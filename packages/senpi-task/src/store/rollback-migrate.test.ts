import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  createTaskRecord,
  SUSPENSION_REASONS,
  TASK_START_FAILURE_REASONS,
  type TaskStartFailureReason,
} from "../state"
import { createTaskRecordStore } from "./record-store"
import { migrateHostSessionSockets, planHostSessionSocketMigration } from "./rollback-migrate"

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function storeFixture() {
  const storeDir = mkdtempSync(join(tmpdir(), "senpi-task-rollback-"))
  roots.push(storeDir)
  const store = createTaskRecordStore({ project_dir: storeDir, task: { state_dir: storeDir } })
  const base = createTaskRecord({
    parent_session_id: "parent",
    root_session_id: "root",
    depth: 0,
    execution_mode: "process",
    model: "test/model",
    notify_on_terminal: false,
  })
  return { storeDir, store, base }
}

describe("rollback host-session migration", () => {
  test("#given shard and rpc records #when migration runs #then only shard sockets move and one event is appended", () => {
    const { storeDir, store, base } = storeFixture()
    const shard = "/tmp/p-aaaaaaaaaaaaaaaa.sock"
    const target = "/tmp/rpc.sock"
    store.save({
      ...base,
      task_id: "st_00000001",
      runner_kind: "host-session",
      suspension_reason: "host_incompatible",
      host_session: { socket: shard, routing_id: "r1", session_path: "/tmp/s1.jsonl", instance_id: "i1" },
    })
    store.save({
      ...base,
      task_id: "st_00000002",
      runner_kind: "host-session",
      host_session: { socket: target, routing_id: "r2", session_path: "/tmp/s2.jsonl", instance_id: "i2" },
    })

    const result = migrateHostSessionSockets(storeDir, { to: target, deadEndpoints: new Set([shard]) })

    expect(result).toMatchObject({ migrate: 1, migrated: 1, skipped: 1, sockets: [shard] })
    expect(store.load("st_00000001")?.host_session?.socket).toBe(target)
    expect(store.load("st_00000001")?.suspension_reason).toBeUndefined()
    expect(store.load("st_00000002")?.host_session?.socket).toBe(target)
    const events = readFileSync(join(storeDir, "logs", "st_00000001.jsonl"), "utf8").trim().split("\n")
    expect(events).toHaveLength(1)
    expect(JSON.parse(events[0] ?? "{}")).toEqual({
      type: "host_session_migrated",
      payload: { from: shard, to: target, reason: "rollback" },
    })
  })

  test("#given an unverified endpoint #when migration is requested #then no record is rewritten", () => {
    const { storeDir, store, base } = storeFixture()
    const shard = "/tmp/p-bbbbbbbbbbbbbbbb.sock"
    store.save({
      ...base,
      task_id: "st_00000003",
      runner_kind: "host-session",
      host_session: { socket: shard, routing_id: "r3", session_path: "/tmp/s3.jsonl", instance_id: "i3" },
    })

    expect(() => migrateHostSessionSockets(storeDir, { to: "/tmp/rpc.sock", deadEndpoints: new Set() }))
      .toThrow("live or unverified endpoint")
    expect(store.load("st_00000003")?.host_session?.socket).toBe(shard)
  })

  test("#given a dry run #when migration is planned #then the store remains byte-identical", () => {
    const { storeDir, store, base } = storeFixture()
    const shard = "/tmp/p-cccccccccccccccc.sock"
    store.save({
      ...base,
      task_id: "st_00000004",
      runner_kind: "host-session",
      host_session: { socket: shard, routing_id: "r4", session_path: "/tmp/s4.jsonl", instance_id: "i4" },
    })
    const path = join(storeDir, "tasks", "st_00000004.json")
    const before = readFileSync(path)

    const plan = planHostSessionSocketMigration(storeDir, "/tmp/rpc.sock")
    const result = migrateHostSessionSockets(storeDir, {
      to: "/tmp/rpc.sock",
      deadEndpoints: new Set([shard]),
      dryRun: true,
    })

    expect(plan.migrate).toBe(1)
    expect(result.migrated).toBe(0)
    expect(readFileSync(path)).toEqual(before)
  })

  test("#given every current persisted reason #when rollback prepares #then an R0-equivalent strict parser accepts every record", () => {
    const { storeDir, store, base } = storeFixture()
    const target = "/tmp/rpc.sock"
    let ordinal = 16
    for (const suspensionReason of SUSPENSION_REASONS) {
      store.save({
        ...base,
        task_id: `st_${ordinal.toString(16).padStart(8, "0")}`,
        runner_kind: "host-session",
        suspension_reason: suspensionReason,
        host_session: {
          socket: target,
          routing_id: `s-${ordinal}`,
          session_path: `/tmp/s-${ordinal}.jsonl`,
          instance_id: `i-${ordinal}`,
        },
      })
      ordinal += 1
    }
    for (const failureReason of TASK_START_FAILURE_REASONS) {
      store.save({
        ...base,
        task_id: `st_${ordinal.toString(16).padStart(8, "0")}`,
        failure_kind: failureKindFor(failureReason),
        failure_reason: failureReason,
      })
      ordinal += 1
    }

    const result = migrateHostSessionSockets(storeDir, { to: target, deadEndpoints: new Set() })

    expect(result.sockets).toEqual([])
    expect(result.migrated).toBeGreaterThan(0)
    const taskFiles = Array.from(
      { length: ordinal - 16 },
      (_, index) => join(storeDir, "tasks", `st_${(index + 16).toString(16).padStart(8, "0")}.json`),
    )
    for (const path of taskFiles) expect(() => parseR0Record(readFileSync(path, "utf8"))).not.toThrow()
    const preservedSuspension = store.list().records.find((record) => record.suspension_reason === "host_draining")
    const preservedFailure = store.list().records.find(
      (record) => record.failure_reason === "model_not_in_child_profile",
    )
    expect(preservedSuspension?.suspension_reason).toBe("host_draining")
    expect(preservedFailure?.failure_reason).toBe("model_not_in_child_profile")
  })
})

const R0_SUSPENSION_REASONS = new Set(["daemon_unavailable", "host_draining"])
const R0_FAILURE_REASONS = new Set([
  "model_not_in_child_profile",
  "catalog_probe_timed_out",
  "catalog_probe_failed",
])

function parseR0Record(text: string): void {
  const record = JSON.parse(text) as Record<string, unknown>
  const suspensionReason = record["suspension_reason"]
  if (suspensionReason !== undefined && !R0_SUSPENSION_REASONS.has(String(suspensionReason))) {
    throw new Error(`R0 rejects suspension_reason ${String(suspensionReason)}`)
  }
  const failureReason = record["failure_reason"]
  if (failureReason !== undefined && !R0_FAILURE_REASONS.has(String(failureReason))) {
    throw new Error(`R0 rejects failure_reason ${String(failureReason)}`)
  }
}

function failureKindFor(reason: TaskStartFailureReason) {
  if (
    reason === "model_not_in_child_profile" ||
    reason === "catalog_probe_timed_out" ||
    reason === "catalog_probe_failed"
  ) {
    return "model_unavailable" as const
  }
  if (
    reason === "protocol" ||
    reason === "capability" ||
    reason === "engine_mismatch" ||
    reason === "engine_refused" ||
    reason === "win32" ||
    reason === "runtime" ||
    reason === "host_unreachable" ||
    reason === "ensure_failed" ||
    reason === "ensure_timed_out" ||
    reason === "shard_socket_too_long" ||
    reason === "shard_alt_root_unsafe" ||
    reason === "legacy_host" ||
    reason === "host_incompatible" ||
    reason === "store_index_unavailable" ||
    reason === "own_host_unreachable" ||
    reason === "shard_identity_missing"
  ) {
    return "host_unavailable" as const
  }
  return "session-create-failed" as const
}
