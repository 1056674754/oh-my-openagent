import type { OmoTaskSettings } from "@oh-my-opencode/omo-config-core"
import type { ExecutionModeGate, HostEndpointPort, TaskManager, TaskRecord } from "@oh-my-opencode/senpi-task"

import type { SenpiExtensionAPI } from "../../extension/types"
import type { LiveTaskContext } from "./runtime-context"
import { createOncePerSessionGuard } from "./usage-guidance"

/**
 * Task-host warm-ups, fire-and-forget, at most once per session id, POSIX `host` runner only:
 * - revival (always on): at `session_start`, ensure every recorded socket of this session's suspended
 *   host-session children except its own endpoint, so the host boots while the reconcile scans and
 *   the lifecycle's revival ensure hits the per-socket ensure cache;
 * - `task.host_shard_prewarm` `"session-start"` / `"first-turn"`: the session's own host, through the
 *   execution-mode gate. Failures surface through the host notices, never through a turn.
 */

// The earliest host edges of a submitted prompt: `input` fires before skill/template expansion, and
// `before_agent_start` covers turns that never pass through `input` (print mode, `--message`).
const FIRST_TURN_EVENTS = ["input", "before_agent_start"] as const

// The reconcile's revival population (`reconcile-revival.ts` `suspendedCandidates`) narrowed to
// host sessions: only a record naming a socket has a host worth warming.
const SUSPENDED_RESIDENCIES = new Set(["persisted_only", "rpc_detached"])
const REVIVABLE_STATUSES = new Set(["pending", "running", "interrupted"])

export interface HostPrewarmEngine {
  readonly settings: Pick<OmoTaskSettings, "process_runner" | "host_shard_prewarm" | "resume_children" | "reattach_on_reconcile">
  readonly runtime: {
    captureFrom(ctx: LiveTaskContext): void
    sessionId(): string | undefined
  }
  readonly host: {
    readonly executionModeGate: Pick<ExecutionModeGate, "ensure">
    readonly hostEndpoint: Pick<HostEndpointPort, "isOwn" | "ensure">
  }
  readonly manager: Pick<TaskManager, "list">
}

export function wireHostPrewarm(
  pi: SenpiExtensionAPI,
  engine: HostPrewarmEngine,
  platform: NodeJS.Platform = process.platform,
): void {
  if (engine.settings.process_runner !== "host" || platform === "win32") return
  const revived = createOncePerSessionGuard()
  const warmed = createOncePerSessionGuard()
  const mode = engine.settings.host_shard_prewarm
  const attachedSession = (eventCtx: unknown): string | undefined => {
    if (typeof eventCtx === "object" && eventCtx !== null) engine.runtime.captureFrom(eventCtx)
    return engine.runtime.sessionId()
  }
  const warmOwnHost = (sessionId: string): void => {
    if (warmed(sessionId)) void engine.host.executionModeGate.ensure().catch(() => undefined)
  }

  pi.on("session_start", (_payload, eventCtx) => {
    const sessionId = attachedSession(eventCtx)
    if (sessionId === undefined) return
    if (revived(sessionId)) warmRecordedHosts(engine, sessionId)
    if (mode === "session-start") warmOwnHost(sessionId)
  })
  if (mode !== "first-turn") return
  for (const event of FIRST_TURN_EVENTS) {
    pi.on(event, (_payload, eventCtx) => {
      const sessionId = attachedSession(eventCtx)
      if (sessionId !== undefined) warmOwnHost(sessionId)
      return undefined
    })
  }
}

function warmRecordedHosts(engine: HostPrewarmEngine, sessionId: string): void {
  if (engine.settings.resume_children === false || engine.settings.reattach_on_reconcile === false) return
  const sockets = new Set<string>()
  for (const { record } of engine.manager.list({ scope: "parent-session", session_id: sessionId })) {
    const socket = suspendedHostSocket(record, sessionId)
    // The session's own endpoint is already serving it, or not restartable from inside.
    if (socket !== undefined && !engine.host.hostEndpoint.isOwn(socket)) sockets.add(socket)
  }
  for (const socket of sockets) void engine.host.hostEndpoint.ensure(socket).catch(() => undefined)
}

function suspendedHostSocket(record: TaskRecord, sessionId: string): string | undefined {
  if (record.parent_session_id !== sessionId || record.killed === true) return undefined
  if (!SUSPENDED_RESIDENCIES.has(record.residency_state) || !REVIVABLE_STATUSES.has(record.status)) return undefined
  return record.runner_kind === "host-session" ? record.host_session?.socket : undefined
}
