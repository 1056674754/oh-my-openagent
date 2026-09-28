import { mkdir } from "node:fs/promises"
import { dirname } from "node:path"
import { randomUUID } from "node:crypto"
import { log } from "@oh-my-opencode/utils"

import type { HostEnginePolicy } from "../lazy/senpi-barrel"
import { RunnerError } from "./in-process/runner-error"
import {
  admitChildStore,
  ensureChildEndpoint,
  isEnsuredEndpoint,
  recordSidecarStore,
  resolveChildEndpoint,
  type ChildEndpointPorts,
  type EnsureTaskDaemonPort,
  type ShardResolver,
} from "./rpc-host/child-endpoint"
import { HostUnavailableError, ensureTaskDaemon, forgetTaskDaemon } from "./rpc-host/daemon"
import { recordedEndpointFailure } from "./rpc-host/endpoint-failure"
import { onceNoticeSink, type HostNoticeSink } from "./rpc-host/host-notice"
import { createReattachPort } from "./rpc-host/reattach-port"
import { createHostSessionHandle } from "./rpc-host/handle"
import type { HostShardEvents } from "./rpc-host/handle-reattach"
import { createLiveHostChildren, type LiveHostChildren } from "./rpc-host/live-children"
import type { HostSessionChildHandle, HostSessionIdentity, HostSessionPort } from "./rpc-host/handle-port"
import { HostSessionClient, type OpenedHostSession } from "./rpc-host/session-client"
import { probeWithEngine, type HostProtocolProbe } from "./rpc-host/session-transport"
import { openHostSessionWithAdmission } from "./rpc-host/admission"
import { openTaskHostSession } from "./rpc-host/open-session"
import { resolveChildSessionPath } from "./rpc-host/session-context"
import type { HostSessionOpenInput } from "./rpc-host/session-transport"
import { isHostTransportError } from "./rpc-host/transport-error"
import { createRpcModelAdmission, type RpcModelAdmission } from "./rpc/model-admission"
import { discardUnstartedRpcHandle } from "./rpc/start-cleanup"
import type { RpcChildHandle, RpcRunnerSpec, RpcSwitchSessionResult } from "./types"

const DEFAULT_HEARTBEAT_INTERVAL_MS = 10_000
const DEFAULT_CLOSE_GRACE_MS = 5_000
/** Backoff between reattach attempts after a lost transport; the daemon needs a moment to come back. */
const DEFAULT_REATTACH_DELAYS_MS: readonly number[] = [500, 1_000, 2_000, 4_000, 8_000]
/** How long a start may wait for a memory-critical host to admit a new worker session. */
const DEFAULT_ADMISSION_WAIT_MS = 10 * 60_000

/** ONE child's session on the daemon: the port the handle drives, plus the open the runner makes. */
export interface HostSessionChannel extends HostSessionPort {
  open(input: HostSessionOpenInput): Promise<OpenedHostSession>
}

export type { EnsureTaskDaemonPort, ShardResolver } from "./rpc-host/child-endpoint"
export type CreateHostSessionChannel = (socketPath: string) => HostSessionChannel

/** The per-child runner this one delegates to when the daemon cannot host a child. */
export interface FallbackChildRunner {
  start(spec: RpcRunnerSpec): Promise<RpcChildHandle>
}

export type RpcHostRunnerOptions = {
  readonly policy: HostEnginePolicy
  readonly agentDir: string
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly ensureDaemon?: EnsureTaskDaemonPort
  readonly createClient?: CreateHostSessionChannel
  readonly modelAdmission?: RpcModelAdmission
  // The parent's `-e` extension entries, forwarded exactly as the per-child runner forwards them:
  // the daemon loads its own extension set, but admission and the fallback still need the parent's.
  readonly inheritedExtensions?: readonly string[]
  readonly heartbeatIntervalMs?: number
  readonly closeGraceMs?: number
  readonly fallback?: FallbackChildRunner
  readonly onWarning?: (message: string) => void | (() => void)
  readonly now?: () => number
  readonly reattachDelaysMs?: readonly number[]
  readonly admissionWaitMs?: number
  readonly sleep?: (ms: number) => Promise<void>
  // WHERE a new child's host listens, asked at EVERY start (the owning session changes on /new).
  // Required: a task child has no machine-wide default endpoint.
  readonly shardResolver: ShardResolver
  // The task store (`resolveStateDir`): registered in the agent-dir store index before every open.
  readonly storeDir: string
  // The public socket this session lives behind (`readOwnHostSocket(pi)`); never ensured from inside.
  readonly ownHostSocket: () => string | undefined
  // Whether this session runs inside a host (an inherited tree key): with `ownHostSocket` unknown it
  // may only attach to recorded endpoints, never start a supervisor.
  readonly insideHost: () => boolean
  // `host_notice:*` / `host_unavailable:*` tokens, once per token and endpoint.
  readonly onNotice: HostNoticeSink
  // Every child's transport recoveries, so the parent hears about a host crash once (todo 10).
  readonly shardEvents: HostShardEvents
  // The attach-only probe for the session's own endpoint; defaults to the engine's `probeHost`.
  readonly probeHost?: HostProtocolProbe
}

/** Whether a started child lives on the daemon (a session) or in its own process (the fallback). */
export function isHostSessionHandle(handle: RpcChildHandle): handle is HostSessionChildHandle {
  return "kind" in handle && handle.kind === "host-session"
}

/**
 * Runs a `process`-mode child as a SESSION of its parent session's own task host (the shard the
 * resolver names): it attaches to (or creates) that host through the engine's own ensure - never the
 * host this session itself lives on, which is only attached - opens one retained worker session per
 * child, and returns the same steerable handle shape the per-child runner returns. It spawns
 * nothing itself and holds no pid - a session's death is a session record, never a signal.
 *
 * When the daemon cannot host a child for a reason the engine marked as fallback-allowed (a
 * narrower or pre-change daemon, win32, a Node runtime without bun), the child is delegated to the
 * per-child `RpcProcessRunner` and the reason is warned ONCE per runner. Every other reason fails
 * closed with `host_unavailable`: a refused client must never start a second host beside the daemon.
 *
 * Two refusals are recoveries, not failures (omo#8563). A host above its memory refuse watermark
 * answers `host_memory_pressure` with a retry hint: the start WAITS for it (bounded) and asks
 * again - the one-process rule stands, so this never reaches the fallback. A lost transport under
 * a live child is re-ensured and the same session path reopened with backoff; the handle stays.
 */
export class RpcHostRunner {
  private readonly options: RpcHostRunnerOptions
  private readonly createClient: CreateHostSessionChannel
  private readonly modelAdmission: RpcModelAdmission
  private readonly inheritedExtensions: readonly string[]
  private readonly now: () => number
  private readonly onWarning: (message: string) => void | (() => void)
  private readonly warned = new Set<string>()
  private readonly reattachDelaysMs: readonly number[]
  private readonly admissionWaitMs: number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly endpoint: ChildEndpointPorts
  private readonly liveChildren: LiveHostChildren

  constructor(options: RpcHostRunnerOptions) {
    this.options = options
    this.createClient = options.createClient ?? ((socketPath) => new HostSessionClient({ socketPath }))
    this.modelAdmission = options.modelAdmission ?? createRpcModelAdmission()
    this.inheritedExtensions = options.inheritedExtensions ?? []
    this.now = options.now ?? Date.now
    this.onWarning = options.onWarning ?? ((message) => log("senpi-task host runner fallback", { message }))
    this.reattachDelaysMs = options.reattachDelaysMs ?? DEFAULT_REATTACH_DELAYS_MS
    this.admissionWaitMs = options.admissionWaitMs ?? DEFAULT_ADMISSION_WAIT_MS
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    this.liveChildren = createLiveHostChildren(options.shardEvents)
    this.endpoint = {
      agentDir: options.agentDir,
      env: options.env ?? process.env,
      policy: options.policy,
      ensureDaemon: this.liveChildren.ensure(options.ensureDaemon ?? ensureTaskDaemon),
      storeDir: options.storeDir,
      shardResolver: options.shardResolver,
      ownHostSocket: options.ownHostSocket,
      insideHost: options.insideHost,
      probeHost: options.probeHost ?? probeWithEngine,
      notice: onceNoticeSink(options.onNotice),
      now: this.now,
    }
  }

  async start(specInput: RpcRunnerSpec): Promise<RpcChildHandle> {
    const spec =
      specInput.extensions === undefined && this.inheritedExtensions.length > 0
        ? { ...specInput, extensions: this.inheritedExtensions }
        : specInput
    await this.modelAdmission(spec)
    const endpoint = resolveChildEndpoint(this.endpoint, spec)
    const keyed = endpoint.shardKey === undefined ? spec : { ...spec, treeKey: endpoint.shardKey, shardKey: endpoint.shardKey }
    await admitChildStore(this.endpoint)
    for (let retried = false; ; retried = true) {
      let socket: string
      try {
        socket = await ensureChildEndpoint(this.endpoint, endpoint)
      } catch (error) {
        if (RunnerError.is(error)) throw error
        if (endpoint.recorded) throw recordedEndpointFailure(this.endpoint.notice, error, endpoint.socket)
        return await this.delegate(error, spec, isHostTransportError(error))
      }
      await recordSidecarStore(this.endpoint, socket)
      try {
        return await this.openChild(keyed, socket)
      } catch (error) {
        if (RunnerError.is(error)) throw error
        // The host refusing the OPEN on a recorded endpoint (e.g. a missing capability - the only
        // check the session's own endpoint gets, since it is never ensured) must park the child too:
        // the fallback would reopen the retained session off its endpoint.
        if (endpoint.recorded && error instanceof HostUnavailableError) {
          throw recordedEndpointFailure(this.endpoint.notice, error, endpoint.socket)
        }
        // An ensure answered from the cache can vouch for a host that died moments ago: drop it and
        // ensure once more, which starts the endpoint again.
        if (!retried && isHostGone(error) && isEnsuredEndpoint(this.endpoint, endpoint)) {
          forgetTaskDaemon(socket)
          continue
        }
        return await this.delegate(error, spec, false)
      }
    }
  }

  /**
   * The LOUD, narrow fallback. `fallbackAllowed` is the engine's own verdict (`daemon.ts`), so the
   * set of reasons that may run a child as its own process is stated exactly once.
   */
  private async delegate(
    error: unknown,
    spec: RpcRunnerSpec,
    hostUnreachable: boolean,
  ): Promise<RpcChildHandle> {
    const fallback = this.options.fallback
    if (fallback === undefined || !(error instanceof HostUnavailableError) || !error.fallbackAllowed) {
      throw new RunnerError({
        kind: "host_unavailable",
        message: error instanceof Error ? error.message : String(error),
        ...(error instanceof HostUnavailableError
          ? { reason: error.reason }
          : hostUnreachable
            ? { reason: "host_unreachable" as const }
            : {}),
        cause: error,
      })
    }
    if (!this.warned.has(error.reason)) {
      this.warned.add(error.reason)
      this.onWarning(`host_unavailable:${error.reason} - task children run as their own process: ${error.message}`)
    }
    return await fallback.start(spec)
  }

  private async openChild(spec: RpcRunnerSpec, socket: string): Promise<RpcChildHandle> {
    const client = this.createClient(socket)
    const sessionPath =
      spec.resumeSessionPath ??
      resolveChildSessionPath(spec.state_dir, spec.task_id, new Date(this.now()), randomUUID())
    // The daemon lstat()s the JSONL's directory before it opens the session and refuses with
    // ENOENT when it is missing. A child process used to create that directory for itself; on the
    // daemon path the client names the path, so the client creates the directory.
    if (spec.resumeSessionPath === undefined) await mkdir(dirname(sessionPath), { recursive: true })
    const opened = await this.openAdmitted(client, spec, sessionPath)
    const handle = createHostSessionHandle({
      client,
      session: { routingId: opened.sessionId, sessionPath, instanceId: opened.instanceId },
      taskId: spec.task_id,
      heartbeatIntervalMs: this.options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
      now: this.now,
      closeGraceMs: this.options.closeGraceMs ?? DEFAULT_CLOSE_GRACE_MS,
      // The host's answer, not connection liveness: respawn continues an interrupted turn only when
      // the session was reopened from its JSONL.
      openDisposition: opened.attached ? "attached" : "reopened",
      shardEvents: this.liveChildren.events,
      reattach: createReattachPort({
        endpoint: this.endpoint,
        spec,
        delaysMs: this.reattachDelaysMs,
        sleep: this.sleep,
        createClient: this.createClient,
        open: (port, path) => this.openAdmitted(port, spec, path),
      }),
    })
    this.liveChildren.add(handle)
    const switchOnPort = handle.switchSession
    // A resumed child says nothing: an attached session is still mid-turn, and a session reopened
    // from its JSONL keeps its transcript - replaying the prompt would duplicate the work.
    if (spec.resumeSessionPath === undefined) await this.startTurn(handle, spec)
    return Object.assign(handle, {
      spawnSpec: {
        cwd: spec.cwd,
        ...(spec.extensions === undefined ? {} : { extensions: spec.extensions }),
        ...(spec.memberEnv === undefined ? {} : { memberEnv: spec.memberEnv }),
      },
      // The session was opened AT this path, so resuming it is already done; only a different path
      // is a real switch, and it goes to the handle's CURRENT port (a reattach replaces `client`).
      switchSession: (target: string): Promise<RpcSwitchSessionResult> =>
        target === sessionPath ? Promise.resolve({ cancelled: false }) : switchOnPort(target),
    })
  }

  /**
   * Open, waiting out `host_memory_pressure`: the host says when to ask again, the wait is bounded
   * by `admissionWaitMs`, and the wait note lives only for that admission episode. Every other
   * refusal is final.
   */
  private async openAdmitted(
    client: HostSessionChannel,
    spec: RpcRunnerSpec,
    sessionPath: string,
  ): Promise<OpenedHostSession> {
    return openHostSessionWithAdmission({
      open: () => openTaskHostSession({ client, spec, sessionPath }),
      now: this.now,
      sleep: this.sleep,
      admissionWaitMs: this.admissionWaitMs,
      onWarning: this.onWarning,
    })
  }

  private async startTurn(handle: HostSessionChildHandle, spec: RpcRunnerSpec): Promise<void> {
    try {
      await handle.startInitialPrompt(spec.prompt)
    } catch (error) {
      // Captured BEFORE cleanup: a rejected prompt can leave the session live, and the teardown
      // below must never be recorded as the cause of the rejection.
      const exitOutcome = handle.exitOutcome()
      try {
        await discardUnstartedRpcHandle(handle)
      } catch (cleanupError) {
        log("senpi-task host session start cleanup failed", { taskId: spec.task_id, error: String(cleanupError) })
      }
      throw new RunnerError({
        kind: "child-prompt-failed",
        message: error instanceof Error ? error.message : String(error),
        cause: error,
        rejected_while: exitOutcome === undefined ? "alive" : "exited",
        ...(exitOutcome === undefined
          ? {}
          : { exit: { kind: exitOutcome.kind, code: exitOutcome.facts.code, signal: exitOutcome.facts.signal } }),
      })
    }
  }
}

function isHostGone(error: unknown): boolean {
  return error instanceof HostUnavailableError && error.reason === "host_unreachable"
}
