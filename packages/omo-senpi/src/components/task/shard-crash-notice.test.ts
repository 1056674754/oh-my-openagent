import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { runTaskOutput, type ReattachOutcome, type TaskRecord } from "@oh-my-opencode/senpi-task"

import { makeRecord } from "../../../../senpi-task/src/tools/output/__fixtures__/records"
import { OmoTaskSettingsSchema } from "@oh-my-opencode/omo-config-core"

import { createEngineHostRuntime, createHostNotices } from "./host-execution-mode"
import { TaskRuntimeContext, type CapturedUi } from "./runtime-context"
import {
  createShardCrashNotices,
  readNewestHostCrash,
  SHARD_CRASH_DONE_TOKEN,
  SHARD_CRASH_TOKEN,
  type ShardCrashFacts,
} from "./shard-crash-notice"

// Todo 10: one parent-visible line per task-host crash and one when its children are back, on the
// notice list (task_output) and on ui.notify (TUI notice block, Desktop thread row). Asserted by
// their stable tokens and counts only.

const SOCKET_A = "/tmp/dh-t10/rpc/shards/p-aaaaaaaaaaaaaaaa.sock"
const SOCKET_B = "/tmp/dh-t10/rpc/shards/p-bbbbbbbbbbbbbbbb.sock"

type Notified = { readonly text: string; readonly type: string | undefined }

function uiRecorder(): { readonly ui: CapturedUi; readonly notified: Notified[] } {
  const notified: Notified[] = []
  const ui: CapturedUi = {
    notify: (text, type) => notified.push({ text, type }),
    setStatus: () => undefined,
    setWidget: () => undefined,
    select: () => Promise.resolve(undefined),
    confirm: () => Promise.resolve(false),
  }
  return { ui, notified }
}

function harness(options: { readonly withUi?: boolean } = {}) {
  const notices = createHostNotices(() => undefined)
  const { ui, notified } = uiRecorder()
  const crashReads: string[] = []
  const events = createShardCrashNotices({
    agentDir: "/tmp/dh-t10-agent",
    notices,
    ui: () => (options.withUi === false ? undefined : ui),
    readCrash: (_agentDir, socket, instanceId): ShardCrashFacts => {
      crashReads.push(`${socket}#${instanceId}`)
      return { pid: 4242, cause: "SIGSEGV" }
    },
  })
  const lose = (taskId: string, socket = SOCKET_A, instanceId = "gen-1", turnWasInFlight = true): void =>
    events.onTransportLost({ taskId, socket, instanceId, turnWasInFlight })
  const settle = (taskId: string, outcome: ReattachOutcome, socket = SOCKET_A): void =>
    events.onReattachOutcome({ taskId, socket, outcome, ...(outcome === "lost" ? {} : { newInstanceId: "gen-2" }) })
  return { notices, notified, crashReads, lose, settle }
}

function linesWith(lines: readonly string[], token: string): readonly string[] {
  return lines.filter((line) => line.startsWith(`${token}:`))
}

function doneCounts(line: string): readonly number[] {
  return (line.slice(line.indexOf(" ")).match(/\d+/g) ?? []).map(Number)
}

describe("shard crash notice", () => {
  test("#given two children on one lost generation #when both report the loss back to back #then exactly one crash notice and one crash-record read", () => {
    // given
    const world = harness()

    // when
    world.lose("st_a")
    world.lose("st_b")

    // then
    expect(linesWith(world.notices.list(), SHARD_CRASH_TOKEN)).toHaveLength(1)
    expect(linesWith(world.notices.list(), SHARD_CRASH_TOKEN)[0]).toStartWith(`${SHARD_CRASH_TOKEN}:aaaaaaaaaaaaaaaa `)
    expect(world.crashReads).toEqual([`${SOCKET_A}#gen-1`])
  })

  test("#given the episode's children #when one continues and one is lost #then one done line with counts 2/1/1 and exactly two notifies, warning then info", () => {
    // given
    const world = harness()
    world.lose("st_a")
    world.lose("st_b")

    // when
    world.settle("st_a", "continued")
    expect(linesWith(world.notices.list(), SHARD_CRASH_DONE_TOKEN)).toHaveLength(0)
    world.settle("st_b", "lost")

    // then
    const done = linesWith(world.notices.list(), SHARD_CRASH_DONE_TOKEN)
    expect(done).toHaveLength(1)
    expect(doneCounts(done[0] ?? "")).toEqual([2, 1, 1])
    expect(world.notified.map((call) => call.type)).toEqual(["warning", "info"])
    expect(world.notified[0]?.text).toStartWith(`${SHARD_CRASH_TOKEN}:`)
    expect(world.notified[1]?.text).toStartWith(`${SHARD_CRASH_DONE_TOKEN}:`)
  })

  test("#given one crash in progress #when a child on a second socket loses its host #then that is a second notice", () => {
    // given
    const world = harness()
    world.lose("st_a")

    // when
    world.lose("st_c", SOCKET_B)

    // then
    const notices = linesWith(world.notices.list(), SHARD_CRASH_TOKEN)
    expect(notices).toHaveLength(2)
    expect(notices.map((line) => line.split(" ")[0])).toEqual([
      `${SHARD_CRASH_TOKEN}:aaaaaaaaaaaaaaaa`,
      `${SHARD_CRASH_TOKEN}:bbbbbbbbbbbbbbbb`,
    ])
  })

  test("#given a finished episode #when the same socket loses a NEW generation #then a new notice, and a straggler of the old one adds none", () => {
    // given
    const world = harness()
    world.lose("st_a")
    world.settle("st_a", "continued")

    // when
    world.lose("st_late", SOCKET_A, "gen-1")
    world.lose("st_a", SOCKET_A, "gen-2")

    // then
    expect(world.notified.map((call) => call.type)).toEqual(["warning", "info", "warning"])
    expect(world.crashReads).toEqual([`${SOCKET_A}#gen-1`, `${SOCKET_A}#gen-2`])
  })

  test("#given a host that dies with no turn in flight #when its idle children recover #then nothing is announced", () => {
    // given
    const world = harness()

    // when
    world.lose("st_idle", SOCKET_A, "gen-1", false)
    world.settle("st_idle", "resumed")

    // then
    expect(world.notices.list()).toEqual([])
    expect(world.notified).toEqual([])
    expect(world.crashReads).toEqual([])
  })

  test("#given no captured UI #when an episode runs #then zero notifies and both lines still reach the notice list", () => {
    // given
    const world = harness({ withUi: false })

    // when
    world.lose("st_a")
    world.settle("st_a", "continued")

    // then
    expect(world.notified).toEqual([])
    expect(linesWith(world.notices.list(), SHARD_CRASH_TOKEN)).toHaveLength(1)
    expect(linesWith(world.notices.list(), SHARD_CRASH_DONE_TOKEN)).toHaveLength(1)
  })

  test("#given a finished episode #when task_output reads either child #then both lines are listed", async () => {
    // given
    const world = harness()
    world.lose("st_a")
    world.lose("st_b")
    world.settle("st_a", "continued")
    world.settle("st_b", "lost")
    const records: TaskRecord[] = [
      makeRecord({ task_id: "st_a", status: "running" }),
      makeRecord({ task_id: "st_b", status: "running" }),
    ]
    const deps = {
      manager: {
        get: (taskId: string) => records.find((record) => record.task_id === taskId),
        list: () => records.map((record) => ({ record })),
      },
      stateDir: "/tmp/state",
      now: () => Date.parse("2024-12-03T15:00:00.000Z"),
      transcriptReader: () => ({ entries: [], source: "none" as const }),
      notices: world.notices.list,
    }

    for (const taskId of ["st_a", "st_b"]) {
      // when
      const result = await runTaskOutput(deps, { task_id: taskId }, "session-parent")

      // then
      const first = result.content[0]
      const lines = (first?.type === "text" ? first.text : "").split("\n").map((line) => line.replace(/^note: /, ""))
      expect(linesWith(lines, SHARD_CRASH_TOKEN)).toHaveLength(1)
      expect(linesWith(lines, SHARD_CRASH_DONE_TOKEN)).toHaveLength(1)
    }
  })
})

describe("session host runtime", () => {
  test("#given a session with a captured UI #when its routing's shard events report a crash #then the session's notice list and UI both get it", () => {
    // given
    const { ui, notified } = uiRecorder()
    const runtime = new TaskRuntimeContext("/tmp/dh-t10-project")
    runtime.captureFrom({ ui, sessionManager: { getSessionId: () => "01a0e4ae-parent" } })
    const host = createEngineHostRuntime(OmoTaskSettingsSchema.parse({}), runtime, {}, { agentDir: "/tmp/dh-t10-agent", env: {} })

    // when
    host.routing.shardEvents.onTransportLost?.({ taskId: "st_a", socket: SOCKET_A, instanceId: "gen-1", turnWasInFlight: true })

    // then
    expect(linesWith(host.notices.list(), SHARD_CRASH_TOKEN)).toHaveLength(1)
    expect(notified.map((call) => call.type)).toEqual(["warning"])
  })
})

describe("readNewestHostCrash", () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  function endpointDir(agentDir: string, socket: string): string {
    return join(agentDir, "rpc-host-daemon", createHash("sha256").update(socket, "utf8").digest("hex").slice(0, 16))
  }

  test("#given a fresh signalled record and the lost generation's pid file #when read #then pid and signal come back", () => {
    // given
    const agentDir = mkdtempSync(join(tmpdir(), "dh-t10-agent-"))
    dirs.push(agentDir)
    const dir = endpointDir(agentDir, SOCKET_A)
    mkdirSync(join(dir, "generations", "gen-1"), { recursive: true })
    writeFileSync(join(dir, "generations", "gen-1", "host.pid"), JSON.stringify({ pid: 777 }))
    const at = Date.parse("2026-09-27T12:00:00.000Z")
    writeFileSync(
      join(dir, "crashes.jsonl"),
      `${JSON.stringify({ at: "2026-09-26T12:00:00.000Z", code: 3, uptimeMs: 1 })}\n${JSON.stringify({ at: new Date(at - 1_000).toISOString(), signal: "SIGSEGV", uptimeMs: 5 })}\n`,
    )

    // when
    const facts = readNewestHostCrash(agentDir, SOCKET_A, "gen-1", at)

    // then
    expect(facts).toEqual({ pid: 777, cause: "SIGSEGV" })
  })

  test("#given only an old record and no generation file #when read #then nothing is attributed to this crash", () => {
    // given
    const agentDir = mkdtempSync(join(tmpdir(), "dh-t10-agent-"))
    dirs.push(agentDir)
    const dir = endpointDir(agentDir, SOCKET_A)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "crashes.jsonl"), `${JSON.stringify({ at: "2026-09-20T12:00:00.000Z", signal: "SIGBUS", uptimeMs: 1 })}\n`)

    // when
    const facts = readNewestHostCrash(agentDir, SOCKET_A, "gen-1", Date.parse("2026-09-27T12:00:00.000Z"))

    // then
    expect(facts).toEqual({})
  })
})
