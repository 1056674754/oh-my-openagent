/** Test worlds shared by the host pre-warm suites. */
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

/** Every test file calls this from `afterEach`: each world owns a temp agent dir. */
export function removeWorldDirs(): void {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
}

// "default": the key is left out, so the schema default decides.
export type Prewarm = "off" | "first-turn" | "session-start" | "default"

export function world(input: {
  readonly prewarm: Prewarm
  readonly platform?: NodeJS.Platform
  readonly processRunner?: "host" | "child-process"
  // The shard basename this session itself runs behind (a child opened inside that host).
  readonly ownShard?: string
  readonly resumeChildren?: boolean
  readonly residencyMaxChildren?: number
  readonly reattachOnReconcile?: boolean
  readonly defaultExecutionMode?: "auto" | "in-process" | "process"
  // An omo-spawned session that is not inside a host (a per-process child): a role, no host socket.
  readonly sessionRole?: string
  // "reject-once": the first ensure fails, every later one answers.
  readonly ensure?: "answer" | "reject" | "reject-once"
  readonly warmSession?: "answer" | "reject"
}) {
  // a short POSIX root keeps shard socket paths under the sun_path limit; win32 has no /tmp
  const root = mkdtempSync(process.platform === "win32" ? join(tmpdir(), "omo-t9-") : "/tmp/omo-t9-")
  dirs.push(root)
  const agentDir = join(root, "agent")
  const shard = (name: string): string => join(agentDir, "rpc", "shards", `${name}.sock`)
  const pi = new FakeExtensionAPI()
  const sessionContext =
    input.ownShard !== undefined
      ? { role: "child", host_socket: shard(input.ownShard) }
      : input.sessionRole !== undefined
        ? { role: input.sessionRole }
        : undefined
  const piWithContext = Object.assign(pi, sessionContext === undefined ? {} : { sessionContext })
  const settings = OmoTaskSettingsSchema.parse({
    process_runner: input.processRunner ?? "host",
    ...(input.prewarm === "default" ? {} : { host_shard_prewarm: input.prewarm }),
    ...(input.defaultExecutionMode === undefined ? {} : { default_execution_mode: input.defaultExecutionMode }),
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
      const reject = input.ensure === "reject" || (input.ensure === "reject-once" && ensures.length === 1)
      return reject
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
  const warmUps: { readonly socket: string; readonly cwd: string }[] = []
  const warmUpSeen = Promise.withResolvers<void>()
  const warmSession = (socket: string, cwd: string): Promise<void> => {
    warmUps.push({ socket, cwd })
    warmUpSeen.resolve()
    return input.warmSession === "reject" ? Promise.reject(new Error("warm-up refused")) : Promise.resolve()
  }
  wireHostPrewarm(piWithContext, { settings, runtime, host: { ...host, warmSession }, manager }, input.platform ?? "darwin")
  return {
    pi,
    host,
    root,
    warmUps,
    // Subscribed before any trigger; the timeout only turns a missing warm-up into a readable failure.
    warmUpSeen: () =>
      Promise.race([
        warmUpSeen.promise,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("waited 5 s for the warm-up session, never opened")), 5_000)),
      ]),
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

export function sessionCtx(sessionId: string) {
  return { sessionManager: { getSessionId: () => sessionId, getSessionFile: () => `/tmp/${sessionId}.jsonl` } }
}

function ensured(socket: string): EnsuredTaskDaemon {
  return { action: "reuse", reason: "compatible", socket, pid: 1, reused: true, upgradeable: false, capabilities: CAPABLE }
}

let seq = 0
export function suspendedChild(parent: string, socket: string, overrides: Partial<TaskRecord> = {}): TaskRecord {
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
export function countingGateWorld(input: { readonly prewarm: Prewarm; readonly gate: () => Promise<"process" | "in-process"> }) {
  const pi = new FakeExtensionAPI()
  const calls: string[] = []
  const captures: (string | undefined)[] = []
  const runtime = new TaskRuntimeContext("/tmp")
  const warmUps: string[] = []
  const settings = OmoTaskSettingsSchema.parse({ process_runner: "host", ...(input.prewarm === "default" ? {} : { host_shard_prewarm: input.prewarm }) })
  wireHostPrewarm(pi, {
    settings,
    runtime: {
      captureFrom: (ctx) => {
        captures.push(ctx.sessionManager?.getSessionId())
        runtime.captureFrom(ctx)
      },
      sessionId: () => runtime.sessionId(),
      cwd: () => runtime.cwd(),
    },
    host: {
      executionModeGate: { warm: () => (calls.push("gate"), input.gate().then(() => undefined)), current: () => undefined },
      hostEndpoint: { isOwn: () => false, ensure: () => Promise.resolve("ensured") },
      shardSocket: () => "/tmp/p-counting.sock",
      warmSession: (socket) => (warmUps.push(socket), Promise.resolve()),
    },
    manager: { list: () => [] },
  }, "darwin")
  return {
    calls,
    captures,
    warmUps,
    prompt: (sessionId: string) => pi.dispatch("input", { type: "input", text: "hi", source: "interactive" }, sessionCtx(sessionId)),
    agentStart: (sessionId: string) => pi.dispatch("before_agent_start", { type: "before_agent_start" }, sessionCtx(sessionId)),
    sessionStart: (sessionId: string) => pi.dispatch("session_start", { type: "session_start", reason: "startup" }, sessionCtx(sessionId)),
    // A host context without a session manager: the session id is the one session_start captured.
    bareTurn: () => pi.dispatch("before_agent_start", { type: "before_agent_start" }, {}),
  }
}

export function sockets(ensures: readonly EnsureTaskDaemonInput[]): readonly (string | undefined)[] {
  return ensures.map((request) => request.socket)
}
