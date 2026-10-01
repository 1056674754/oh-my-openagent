import { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"

import { gatewayDatabasePath } from "./paths"
import { createGatewayHarness, type GatewayHarness } from "./testing/harness"

let harness: GatewayHarness | undefined
afterEach(async () => { await harness?.dispose(); harness = undefined })

// Security contract: SQLite's authorizer denies an extension's view creation by itself. A view is
// one statement, so it passes the single-statement guard and reaches the authorizer; the message
// is the authorizer's own, which the later schema-diff guard cannot produce. (A trigger body always
// carries an inner `;`, so the single-statement guard refuses every trigger before SQLite runs.)
test("#given a single-statement view creation #when an extension runs it #then SQLite's authorizer denies the create itself", async () => {
  const h = (harness = createGatewayHarness())
  const store = h.store()
  await store.registerStoreExtension({ name: "alpha", moduleUrl: new URL("./testing/store-extension.mjs", import.meta.url).href, migrations: [["CREATE TABLE alpha_items (id INTEGER)"]] })
  expect(await store.extensionCall("alpha", "sql", { sql: "CREATE VIEW alpha_view AS SELECT id FROM alpha_items" }))
    .toEqual({ kind: "refused", code: "extension_schema_violation", message: "Extension alpha does not own alpha_view." })
  const db = new Database(gatewayDatabasePath(h.agentDir), { readonly: true })
  try {
    expect(db.query("SELECT name FROM sqlite_schema WHERE type = 'view'").all()).toEqual([])
  } finally { db.close() }
  expect(await store.list()).toEqual([])
})
