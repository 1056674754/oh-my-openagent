import { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"

import { OUTBOX_RETENTION_MS, rfc3339 } from "./bindings"
import { DELIVERY_RETENTION_MS, RETENTION_SWEEP_INTERVAL_MS } from "./constants"
import { gatewayDatabasePath } from "./paths"
import type { GatewayStore } from "./store"
import { createGatewayHarness, type GatewayHarness } from "./testing/harness"

const DAY = 24 * 60 * 60 * 1000
const moduleUrl = new URL("./testing/store-extension.mjs", import.meta.url).href

let harness: GatewayHarness | undefined
afterEach(async () => { await harness?.dispose(); harness = undefined })

function insertDelivery(db: Database, id: string, seq: number, updatedAt: number): void {
  db.run(
    "INSERT INTO deliveries (delivery_id, target_durable_id, seq, sender, envelope, body, bytes, mode_requested, state, root_id, hop, created_at, updated_at, expires_at) VALUES (?, 'B', ?, 'session:A', '{}', 'body', 4, 'auto', 'applied', 'root-x', 1, ?, ?, ?)",
    [id, seq, updatedAt, updatedAt, updatedAt + DAY],
  )
}

function insertBinding(db: Database, id: string, session: string, updatedAt: number): void {
  db.run(
    "INSERT INTO bindings (binding_id, revision, status, platform, account_id, chat_id, thread_id, session_realm_id, session_durable_id, direction_inbound, direction_outbound, inbound_mode, outbound_events, policy_id, created_at, updated_at, lease_started_at) VALUES (?, 1, 'detached', 'custom', 'bot', ?, '@chat', 'realm-x', ?, 1, 1, 'auto', '[\"report\"]', 'default', ?, ?, ?)",
    [id, id, session, rfc3339(updatedAt), rfc3339(updatedAt), rfc3339(updatedAt)],
  )
}

function ids(db: Database, sql: string): string[] {
  return db.query(sql).all().map((row) => String(Object.values(row as Record<string, unknown>)[0]))
}

async function bindSomething(store: GatewayStore, now: number, chat: string) {
  const bound = await store.bind({ now, receipt: null, binding: { platform: "custom", account_id: "bot", chat_id: chat, thread_id: "@chat", root_message_id: null, progress_message_id: null, session_durable_id: "C", direction: { inbound: true, outbound: true }, inbound_mode: "auto", outbound_events: ["report"], policy_id: "default", ttl_seconds: null } })
  if (bound.kind !== "ok") throw new Error(JSON.stringify(bound))
  return bound.binding
}

async function sql(store: GatewayStore, statement: string, params: readonly (string | number | null)[] = []) {
  const result = await store.extensionCall("alpha", "sql", { sql: statement, params })
  if (result.kind !== "ok") throw new Error(JSON.stringify(result))
}

async function core<T>(store: GatewayStore, op: string, request: unknown): Promise<T> {
  const result = await store.extensionCall<T>("alpha", "core", { op, request })
  if (result.kind !== "ok") throw new Error(JSON.stringify(result))
  return result.value
}

test("#given extension rows and the core rows an extension still acts on #when the retention sweep runs long after #then the extension's rows and those core rows stay while unreachable old rows go", async () => {
  const h = (harness = createGatewayHarness())
  h.phantom("target")
  const t0 = h.clock.now
  const store = h.store()
  expect(await store.registerStoreExtension({
    name: "alpha",
    moduleUrl,
    migrations: [[
      "CREATE TABLE alpha_items (id INTEGER PRIMARY KEY, value TEXT)",
      "CREATE TABLE alpha_refs (id INTEGER PRIMARY KEY, binding_id TEXT REFERENCES bindings ON DELETE CASCADE)",
    ]],
  })).toEqual({ kind: "ok", value: { version: 1 } })
  const bindChat = async (chat: string) => {
    const bound = await core<{ kind: string; binding: { binding_id: string; revision: number } }>(store, "bind", { principal: "test", binding: { platform: "custom", account_id: "bot", chat_id: chat, session_durable_id: "target", ttl_seconds: null } })
    if (bound.kind !== "ok") throw new Error(JSON.stringify(bound))
    return bound.binding
  }
  // Closed, but the extension still has a pending outbox row to post and ack (the row's own
  // lifetime is the outbox retention; the sweep keeps its binding while it exists).
  const closed = await bindChat("closed")
  expect((await store.report({ now: t0, receipt: null, origin_delivery_ids: [], session_durable_id: "target", binding_id: closed.binding_id, event: "report", text: "pending report", ui_request_id: null, ui_request_kind: null })).kind).toBe("ok")
  expect(await core(store, "unbind", { principal: "test", binding_id: closed.binding_id, expected_revision: closed.revision })).toMatchObject({ kind: "ok", binding: { status: "detached" } })
  // Active, with nothing else pointing at it.
  const idle = await bindChat("idle")
  // Active, with an undelivered message the extension enqueued.
  const made = await store.extensionCall<{ bound: { binding: { binding_id: string } }; sent: { kind: string; delivery_id?: string } }>("alpha", "bindThenEnqueue", {
    bind: { principal: "test", binding: { platform: "custom", account_id: "bot", chat_id: "busy", session_durable_id: "target", ttl_seconds: null } },
    address: { platform: "custom", account_id: "bot", chat_id: "busy", thread_id: "@chat" },
    send: { event_id: "evt-1", text: "hello" },
  })
  if (made.kind !== "ok" || made.value.sent.kind !== "ok") throw new Error(JSON.stringify(made))
  const busy = made.value.bound.binding.binding_id
  const kept = [closed.binding_id, idle.binding_id, busy].toSorted()
  await sql(store, "INSERT INTO alpha_items (id, value) VALUES (1, ?), (2, ?), (3, ?)", kept)
  // A foreign key to a core table makes every write to the declaring table read that core table,
  // which the extension does not own: no extension row can hold one, so the sweep can neither
  // cascade into extension rows nor be blocked by them.
  for (const value of [idle.binding_id, null]) {
    expect(await store.extensionCall("alpha", "sql", { sql: "INSERT INTO alpha_refs (binding_id) VALUES (?)", params: [value] })).toMatchObject({ kind: "refused", code: "extension_schema_violation" })
  }
  const db = new Database(gatewayDatabasePath(h.agentDir))
  try {
    db.run("PRAGMA busy_timeout = 5000")
    insertDelivery(db, "d-old", 99, t0)
    insertBinding(db, "bnd-old", "S-old", t0)
  } finally {
    db.close()
  }
  h.clock.now = t0 + Math.max(DELIVERY_RETENTION_MS, OUTBOX_RETENTION_MS) + DAY
  await bindSomething(store, h.clock.now, "trigger")
  const check = new Database(gatewayDatabasePath(h.agentDir))
  try {
    expect({
      deliveries: check.query("SELECT state FROM deliveries WHERE delivery_id IN (?, 'd-old')").all(made.value.sent.delivery_id ?? ""),
      bindings: ids(check, `SELECT binding_id FROM bindings WHERE binding_id IN ('${kept.join("', '")}', 'bnd-old') ORDER BY binding_id`),
      alpha_items: check.query("SELECT value FROM alpha_items ORDER BY id").all(),
      alpha_refs: check.query("SELECT id FROM alpha_refs").all(),
      closed_outbox: check.query("SELECT state FROM outbox WHERE binding_id = ?").all(closed.binding_id),
    }).toEqual({
      deliveries: [{ state: "queued" }],
      bindings: kept,
      alpha_items: kept.map((value) => ({ value })),
      alpha_refs: [],
      closed_outbox: [{ state: "pending" }],
    })
  } finally {
    check.close()
  }
  expect(await core(store, "bindingFor", { platform: "custom", account_id: "bot", chat_id: "idle", thread_id: "@chat" })).toMatchObject({ binding_id: idle.binding_id, status: "active" })
})

test("#given a sweep that just ran #when an extension operation reads the outbox within the sweep interval #then it does not sweep again until the interval passes", async () => {
  const h = (harness = createGatewayHarness())
  const t0 = h.clock.now
  const store = h.store()
  expect((await store.registerStoreExtension({ name: "alpha", moduleUrl, migrations: [["CREATE TABLE alpha_items (id INTEGER PRIMARY KEY, value TEXT)"]] })).kind).toBe("ok")
  const binding = await bindSomething(store, t0, "first")
  const db = new Database(gatewayDatabasePath(h.agentDir))
  try {
    db.run("PRAGMA busy_timeout = 5000")
    insertDelivery(db, "d-expired", 1, t0 - DELIVERY_RETENTION_MS - DAY)
  } finally {
    db.close()
  }
  const page = async () => {
    const result = await store.extensionCall("alpha", "core", { op: "outboxPending", request: { binding_id: binding.binding_id } })
    expect(result).toMatchObject({ kind: "ok", value: { kind: "ok" } })
  }
  const remaining = () => {
    const check = new Database(gatewayDatabasePath(h.agentDir))
    try { return ids(check, "SELECT delivery_id FROM deliveries") } finally { check.close() }
  }
  await page()
  expect(remaining()).toEqual(["d-expired"])
  h.clock.now = t0 + RETENTION_SWEEP_INTERVAL_MS
  await page()
  expect(remaining()).toEqual([])
})
