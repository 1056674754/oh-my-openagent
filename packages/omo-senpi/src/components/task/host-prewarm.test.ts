import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { OmoTaskSettingsSchema } from "@oh-my-opencode/omo-config-core"
import {
  createTaskRecord,
  HostUnavailableError,
  type EnsureTaskDaemonInput,
  type EnsuredTaskDaemon,
  type ListScope,
  type TaskRecord,
} from "@oh-my-opencode/senpi-task"

import { FakeExtensionAPI } from "../../../test-support/fake-extension-api"
import { createEngineHostRuntime } from "./host-execution-mode"
import { wireHostPrewarm } from "./host-prewarm"
import { TaskRuntimeContext } from "./runtime-context"

const CAPABLE = ["multi_session", "extension_events", "session_context", "session_kind", "generation_handoff"]
const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

type Prewarm = "off" | "first-turn" | "session-start"

function world(input: {
  readonly prewarm: Prewarm
  readonly platform?: NodeJS.Platform
  readonly processRunner?: "host" | "child-process"
  // The shard basename this session itself runs behind (a child opened inside that host).
  readonly ownShard?: string
  readonly resumeChildren?: boolean
  readonly residencyMaxChildren?: number
  readonly reattachOnReconcile?: boolean
  readonly ensure?: "answer" | "reject"
}) {
  // a short POSIX root keeps the shard sockets under the unix bind limit; win32 has no /tmp
  const root = mkdtempSync(join(process.platform === "win32" ? tmpdir() : "/tmp", "omo-t9-"))
  dirs.push(root)
  const agentDir = join(root, "agent")
  const shard = (name: string): string => join(agentDir, "rpc", "shards", `${name}.sock`)
  const pi = new FakeExtensionAPI()
  const piWithContext = Object.assign(pi, input.ownShard === undefined ? {} : { sessionContext: { role: "child", host_socket: shard(input.ownShard) } })
  const settings = OmoTaskSettingsSchema.parse({
    process_runner: input.processRunner ?? "host",
    host_shard_prewarm: input.prewarm,
    ...(input.resumeChildren === undefined ? {} : { resume_children: input.resumeChildren }),
    ...(input.residencyMaxChildren === undefined ? {} : { residency_max_children: input.residencyMaxChildren }),
    ...(input.reattachOnReconcile === undefined ? {} : { reattach_on_reconcile: input.reattachOnReconcile }),
  })
  const runtime = new TaskRuntimeContext(root)
  const ensures: EnsureTaskDaemonInput[] = []
  const probes: string[] = []
  const host = createEngineHostRuntime(settings, runtime, piWithContext, {
    env: {},
    platform: input.platform ?? "darwin",
    agentDir,
    ensureDaemon: (request) => {
      ensures.push(request)
      return input.ensure === "reject"
        ? Promise.reject(new HostUnavailableError("ensure_failed", { fallbackAllowed: false }))
        : Promise.resolve(ensured(request.socket ?? "<unnamed>"))
    },
    probeHost: (socket) => {
      probes.push(socket)
      return Promise.resolve(undefined)
    },
  })
  const records: TaskRecord[] = []
  const manager = {
    list: (scope: ListScope) =>
      records.filter((record) => scope.scope === "all" || record.parent_session_id === scope.session_id).map((record) => ({ record })),
  }
  wireHostPrewarm(piWithContext, { settings, runtime, host, manager }, input.platform ?? "darwin")
  return {
    pi,
    host,
    ensures,
    probes,
    records,
    shard,
    legacy: join(agentDir, "rpc", "rpc.sock"),
    sessionStart: (sessionId: string) => pi.dispatch("session_start", { type: "session_start", reason: "startup" }, sessionCtx(sessionId)),
    prompt: (sessionId: string) => pi.dispatch("input", { type: "input", text: "hi", source: "interactive" }, sessionCtx(sessionId)),
    agentStart: (sessionId: string) => pi.dispatch("before_agent_start", { type: "before_agent_start" }, sessionCtx(sessionId)),
  }
}

function sessionCtx(sessionId: string) {
  return { sessionManager: { getSessionId: () => sessionId, getSessionFile: () => `/tmp/${sessionId}.jsonl` } }
}

function ensured(socket: string): EnsuredTaskDaemon {
  return { action: "reuse", reason: "compatible", socket, pid: 1, reused: true, upgradeable: false, capabilities: CAPABLE }
}

let seq = 0
function suspendedChild(parent: string, socket: string, overrides: Partial<TaskRecord> = {}): TaskRecord {
  seq += 1
  const draft = createTaskRecord({
    parent_session_id: parent,
    root_session_id: parent,
    depth: 0,
    execution_mode: "process",
    model: "anthropic/claude-opus-5-5",
    notify_on_terminal: false,
  })
  return {
    ...draft,
    status: "running",
    residency_state: "rpc_detached",
    runner_kind: "host-session",
    host_session: { socket, routing_id: `r-${seq}`, session_path: `/tmp/child-${seq}.jsonl`, instance_id: `H${seq}` },
    ...overrides,
  }
}

// The gate itself, counted: the real gate memoizes, so only a counting double shows a second call.
function countingGateWorld(input: { readonly prewarm: Prewarm; readonly gate: () => Promise<"process" | "in-process"> }) {
  const pi = new FakeExtensionAPI()
  const calls: string[] = []
  const captures: (string | undefined)[] = []
  const runtime = new TaskRuntimeContext("/tmp")
  const settings = OmoTaskSettingsSchema.parse({ process_runner: "host", host_shard_prewarm: input.prewarm })
  wireHostPrewarm(pi, {
    settings,
    runtime: {
      captureFrom: (ctx) => {
        captures.push(ctx.sessionManager?.getSessionId())
        runtime.captureFrom(ctx)
      },
      sessionId: () => runtime.sessionId(),
    },
    host: {
      executionModeGate: { ensure: () => (calls.push("gate"), input.gate()) },
      hostEndpoint: { isOwn: () => false, ensure: () => Promise.resolve("ensured") },
    },
    manager: { list: () => [] },
  }, "darwin")
  return {
    calls,
    captures,
    prompt: (sessionId: string) => pi.dispatch("input", { type: "input", text: "hi", source: "interactive" }, sessionCtx(sessionId)),
    agentStart: (sessionId: string) => pi.dispatch("before_agent_start", { type: "before_agent_start" }, sessionCtx(sessionId)),
    sessionStart: (sessionId: string) => pi.dispatch("session_start", { type: "session_start", reason: "startup" }, sessionCtx(sessionId)),
    // A host context without a session manager: the session id is the one session_start captured.
    bareTurn: () => pi.dispatch("before_agent_start", { type: "before_agent_start" }, {}),
  }
}

function sockets(ensures: readonly EnsureTaskDaemonInput[]): readonly (string | undefined)[] {
  return ensures.map((request) => request.socket)
}

describe("task.host_shard_prewarm warms the session's own host", () => {
  test("#given session-start #when session_start fires #then the session's shard is ensured once, before any spawn", async () => {
    // given
    const w = world({ prewarm: "session-start" })

    // when
    await w.sessionStart("root-1")

    // then
    expect(sockets(w.ensures)).toEqual([w.host.shardSocket()])
    expect(w.ensures[0]?.owner?.ownerSessionId).toBe("root-1")
    expect(await w.host.executionModeGate.ensure()).toBe("process")
    expect(w.ensures).toHaveLength(1)
  })

  test("#given first-turn #when session_start then two prompts fire #then nothing at session_start and exactly one ensure on the first prompt", async () => {
    // given
    const w = world({ prewarm: "first-turn" })

    // when
    await w.sessionStart("root-1")
    const atSessionStart = w.ensures.length
    await w.prompt("root-1")
    await w.agentStart("root-1")
    const afterFirstTurn = w.ensures.length
    await w.prompt("root-1")
    await w.agentStart("root-1")

    // then
    expect(atSessionStart).toBe(0)
    expect(afterFirstTurn).toBe(1)
    expect(sockets(w.ensures)).toEqual([w.host.shardSocket()])
  })

  test("#given first-turn and a turn that skips input #when before_agent_start fires #then that turn warms the host", async () => {
    // given
    const w = world({ prewarm: "first-turn" })
    await w.sessionStart("root-1")

    // when
    await w.agentStart("root-1")

    // then
    expect(w.ensures).toHaveLength(1)
  })

  test("#given off and no suspended children #when session_start and a prompt fire #then no host is ensured", async () => {
    // given
    const w = world({ prewarm: "off" })

    // when
    await w.sessionStart("root-1")
    await w.prompt("root-1")
    await w.agentStart("root-1")

    // then
    expect(w.ensures).toEqual([])
  })

  test("#given win32 or the child-process runner #when every prewarm edge fires #then nothing is ensured", async () => {
    for (const variant of [{ platform: "win32" as const }, { processRunner: "child-process" as const }]) {
      // given
      const w = world({ prewarm: "session-start", ...variant })
      w.records.push(suspendedChild("root-1", w.shard("p-aaaaaaaaaaaaaaaa")))

      // when
      await w.sessionStart("root-1")
      await w.prompt("root-1")

      // then
      expect(w.ensures).toEqual([])
      expect(w.pi.handlers.map((entry) => entry.event)).toEqual([])
    }
  })

  test("#given first-turn #when every prompt edge of two turns fires #then the gate is asked once per session id", async () => {
    // given
    const w = countingGateWorld({ prewarm: "first-turn", gate: () => Promise.resolve("process") })

    // when
    await w.sessionStart("root-1")
    await w.prompt("root-1")
    await w.agentStart("root-1")
    await w.prompt("root-1")
    await w.agentStart("root-1")
    await w.prompt("root-2")

    // then
    expect(w.calls).toEqual(["gate", "gate"])
  })

  test("#given first-turn and turn contexts that carry no session manager #when two turns start #then the gate is still asked once", async () => {
    // given
    const w = countingGateWorld({ prewarm: "first-turn", gate: () => Promise.resolve("process") })
    await w.sessionStart("root-1")

    // when
    await w.bareTurn()
    await w.bareTurn()

    // then
    expect(w.calls).toEqual(["gate"])
  })

  test("#given first-turn already fired for a session #when later prompts of that session arrive #then their context is not captured again", async () => {
    // given
    const w = countingGateWorld({ prewarm: "first-turn", gate: () => Promise.resolve("process") })
    await w.sessionStart("root-1")
    await w.prompt("root-1")
    const capturesAtFirstFire = [...w.captures]

    // when
    await w.agentStart("root-1")
    await w.prompt("root-1")
    await w.agentStart("root-1")
    await w.prompt("root-2")

    // then: only the new session's first prompt is captured
    expect(capturesAtFirstFire).toEqual(["root-1", "root-1"])
    expect(w.captures).toEqual(["root-1", "root-1", "root-2"])
    expect(w.calls).toEqual(["gate", "gate"])
  })

  test("#given a gate whose ensure rejects #when first-turn warms #then the rejection is absorbed, never unhandled", async () => {
    // given
    const w = countingGateWorld({ prewarm: "first-turn", gate: () => Promise.reject(new Error("gate exploded")) })
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason)
    }
    process.on("unhandledRejection", onUnhandled)

    try {
      // when
      await w.prompt("root-1")
      await new Promise((resolve) => setImmediate(resolve))

      // then
      expect(w.calls).toEqual(["gate"])
      expect(unhandled).toEqual([])
    } finally {
      process.off("unhandledRejection", onUnhandled)
    }
  })

  test("#given an ensure that rejects #when session-start warms #then no unhandled rejection escapes and a host_unavailable notice lands", async () => {
    // given
    const w = world({ prewarm: "session-start", ensure: "reject" })
    w.records.push(suspendedChild("root-1", w.shard("p-aaaaaaaaaaaaaaaa")))
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason)
    }
    process.on("unhandledRejection", onUnhandled)

    try {
      // when
      await w.sessionStart("root-1")
      const mode = await w.host.executionModeGate.ensure()
      await new Promise((resolve) => setImmediate(resolve))

      // then
      expect(mode).toBe("in-process")
      expect(unhandled).toEqual([])
      expect(w.host.notices.list().some((notice) => notice.startsWith("host_unavailable:"))).toBe(true)
    } finally {
      process.off("unhandledRejection", onUnhandled)
    }
  })
})

describe("revival pre-warm ensures the recorded hosts of suspended host-session children", () => {
  test("#given off and a root session with children on p-A and rpc.sock #when session_start fires #then each distinct recorded socket is ensured once", async () => {
    // given
    const w = world({ prewarm: "off" })
    const pA = w.shard("p-aaaaaaaaaaaaaaaa")
    w.records.push(
      suspendedChild("root-1", pA),
      suspendedChild("root-1", pA, { residency_state: "persisted_only", status: "interrupted" }),
      suspendedChild("root-1", w.legacy, { status: "pending" }),
      suspendedChild("other-session", w.shard("p-bbbbbbbbbbbbbbbb")),
      suspendedChild("root-1", w.shard("p-cccccccccccccccc"), { status: "completed" }),
      suspendedChild("root-1", w.shard("p-dddddddddddddddd"), { residency_state: "resident" }),
      suspendedChild("root-1", w.shard("p-eeeeeeeeeeeeeeee"), { killed: true }),
    )

    // when
    await w.sessionStart("root-1")

    // then
    expect([...sockets(w.ensures)].sort()).toEqual([pA, w.legacy].sort())
  })

  test("#given the same children seen from a session living on p-A #when session_start fires #then only rpc.sock is ensured and p-A is neither ensured nor probed", async () => {
    // given
    const w = world({ prewarm: "off", ownShard: "p-aaaaaaaaaaaaaaaa" })
    const pA = w.shard("p-aaaaaaaaaaaaaaaa")
    w.records.push(
      suspendedChild("child-1", pA, { host_session: { socket: pA, routing_id: "r-x", session_path: "/tmp/x.jsonl", instance_id: "H1" } }),
      suspendedChild("child-1", pA, { host_session: { socket: pA, routing_id: "r-y", session_path: "/tmp/y.jsonl", instance_id: "H2" } }),
      suspendedChild("child-1", w.legacy),
    )

    // when
    await w.sessionStart("child-1")

    // then
    expect(sockets(w.ensures)).toEqual([w.legacy])
    expect(w.probes).toEqual([])
  })

  test("#given a resumed session #when session_start fires again for the same id #then its recorded hosts are not warmed twice", async () => {
    // given
    const w = world({ prewarm: "off" })
    const pA = w.shard("p-aaaaaaaaaaaaaaaa")
    w.records.push(suspendedChild("root-1", pA), suspendedChild("root-2", w.legacy))

    // when
    await w.sessionStart("root-1")
    await w.sessionStart("root-1")
    await w.sessionStart("root-2")

    // then
    expect(sockets(w.ensures)).toEqual([pA, w.legacy])
  })

  test("#given residency_max_children 1 and three suspended children on three shards #when session_start fires #then only the host the reconcile will revive is warmed", async () => {
    // given
    const w = world({ prewarm: "off", residencyMaxChildren: 1 })
    const [pA, pB, pC] = ["p-aaaaaaaaaaaaaaaa", "p-bbbbbbbbbbbbbbbb", "p-cccccccccccccccc"].map(w.shard)
    w.records.push(
      suspendedChild("root-1", pA, { updated_at: "2026-09-27T10:00:00.000Z" }),
      suspendedChild("root-1", pB, { updated_at: "2026-09-27T12:00:00.000Z" }),
      suspendedChild("root-1", pC, { updated_at: "2026-09-27T11:00:00.000Z" }),
    )

    // when
    await w.sessionStart("root-1")

    // then
    expect(sockets(w.ensures)).toEqual([pB])
  })

  test("#given residency_max_children 2 with one child already resident #when session_start fires #then only one more host is warmed", async () => {
    // given
    const w = world({ prewarm: "off", residencyMaxChildren: 2 })
    const [pA, pB, pC] = ["p-aaaaaaaaaaaaaaaa", "p-bbbbbbbbbbbbbbbb", "p-cccccccccccccccc"].map(w.shard)
    w.records.push(
      suspendedChild("root-1", pA, { residency_state: "resident" }),
      suspendedChild("root-1", pB, { status: "interrupted", updated_at: "2026-09-27T12:00:00.000Z" }),
      suspendedChild("root-1", pC, { status: "pending", updated_at: "2026-09-27T09:00:00.000Z" }),
    )

    // when
    await w.sessionStart("root-1")

    // then: a non-terminal child outranks a more recent terminal one, as in the reconcile
    expect(sockets(w.ensures)).toEqual([pC])
  })

  test("#given reattach_on_reconcile off #when session_start fires #then no recorded host is warmed", async () => {
    // given
    const w = world({ prewarm: "off", reattachOnReconcile: false })
    w.records.push(suspendedChild("root-1", w.shard("p-aaaaaaaaaaaaaaaa")), suspendedChild("root-1", w.legacy))

    // when
    await w.sessionStart("root-1")

    // then
    expect(w.ensures).toEqual([])
  })

  test("#given resume_children off #when session_start fires #then no recorded host is warmed", async () => {
    // given
    const w = world({ prewarm: "off", resumeChildren: false })
    w.records.push(suspendedChild("root-1", w.legacy))

    // when
    await w.sessionStart("root-1")

    // then
    expect(w.ensures).toEqual([])
  })
})
