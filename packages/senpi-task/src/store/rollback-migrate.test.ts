import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createTaskRecord } from "../state"
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
})
