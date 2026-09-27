import { log } from "@oh-my-opencode/utils"

import type { HostEnginePolicy } from "../../lazy/senpi-barrel"
import { RunnerError } from "../in-process/runner-error"
import type { RpcRunnerSpec } from "../types"
import type { EnsureTaskDaemonInput, EnsuredTaskDaemon } from "./daemon"
import type { HostNoticeKind } from "./host-notice"
import { isOwnEndpoint } from "./own-endpoint"
import { registerSidecarStore, type ShardOwner } from "./shard-sidecar"
import type { ShardNotice, ShardResolution } from "./shard-socket"
import { registerStoreIndex, taskStoreIndexPath } from "./store-index"

export type EnsureTaskDaemonPort = (input: EnsureTaskDaemonInput) => Promise<EnsuredTaskDaemon>
export type ShardResolver = (spec: RpcRunnerSpec) => ShardResolution

export interface ChildEndpointPorts {
  readonly agentDir: string
  readonly env: Readonly<Record<string, string | undefined>>
  readonly policy: HostEnginePolicy
  readonly ensureDaemon: EnsureTaskDaemonPort
  readonly storeDir: string | undefined
  readonly shardResolver: ShardResolver | undefined
  readonly ownHostSocket: (() => string | undefined) | undefined
  readonly notice: (kind: HostNoticeKind, detail?: string) => void
  readonly now: () => number
}

/**
 * WHERE a child opens. A revived or reattached child names its RECORDED socket and opens there and
 * only there; a new child asks the resolver (per start - the owning session changes on /new); a
 * runner built without a resolver keeps the machine-wide socket `ensureTaskDaemon` resolves.
 */
export interface ChildEndpoint {
  readonly socket: string | undefined
  readonly recorded: boolean
  readonly owner?: ShardOwner
  readonly sidecarNotice?: ShardNotice
}

export function resolveChildEndpoint(ports: ChildEndpointPorts, spec: RpcRunnerSpec): ChildEndpoint {
  if (spec.hostSocket !== undefined) return { socket: spec.hostSocket, recorded: true }
  if (ports.shardResolver === undefined) return { socket: undefined, recorded: false }
  const resolution = ports.shardResolver(spec)
  if (resolution.notice !== undefined) ports.notice(resolution.notice, resolution.socket)
  const { kind, key, ownerSessionId, ownerSessionFile } = resolution.shard
  return {
    socket: resolution.socket,
    recorded: false,
    owner: { kind, key, ownerSessionId, ...(ownerSessionFile === undefined ? {} : { ownerSessionFile }) },
    ...(resolution.notice === undefined ? {} : { sidecarNotice: resolution.notice }),
  }
}

/**
 * The ADMISSION PRECONDITION: the child's store is durably in the agent-dir store index before any
 * host is ensured or any session opened, so no record can name an endpoint whose store the index
 * does not list. Failure is a typed `store_index_unavailable`, never a silent open.
 */
export async function admitChildStore(ports: ChildEndpointPorts): Promise<void> {
  if (ports.storeDir === undefined) return
  try {
    await registerStoreIndex({ indexPath: taskStoreIndexPath(ports.agentDir), storeDir: ports.storeDir, now: ports.now })
  } catch (error) {
    ports.notice("store_index_unavailable")
    throw new RunnerError({
      kind: "host_unavailable",
      reason: "store_index_unavailable",
      message: error instanceof Error ? error.message : String(error),
      cause: error,
    })
  }
}

export function isStoreIndexUnavailable(error: unknown): boolean {
  return RunnerError.is(error) && error.failure.reason === "store_index_unavailable"
}

/**
 * THE one place an ensure result is consumed. The session's OWN endpoint is never ensured from
 * inside it. When the engine's ensure starts handing its readiness connection to the caller as an
 * attach hold (senpi #2242), that hold is released here, after the open it guards.
 */
export async function ensureChildEndpoint(ports: ChildEndpointPorts, endpoint: ChildEndpoint): Promise<string> {
  if (endpoint.socket !== undefined && isOwnEndpoint(endpoint.socket, ports.ownHostSocket?.())) return endpoint.socket
  const daemon = await ports.ensureDaemon({
    agentDir: ports.agentDir,
    env: ports.env,
    policy: ports.policy,
    ...(endpoint.socket === undefined ? {} : { socket: endpoint.socket }),
    ...(endpoint.owner === undefined ? {} : { owner: endpoint.owner }),
    ...(endpoint.sidecarNotice === undefined ? {} : { sidecarNotice: endpoint.sidecarNotice }),
  })
  return daemon.socket
}

/** The sidecar's copy of the store list is informational: a failure is logged and noticed once. */
export async function recordSidecarStore(ports: ChildEndpointPorts, socket: string): Promise<void> {
  if (ports.storeDir === undefined) return
  try {
    await registerSidecarStore({ socket, storeDir: ports.storeDir })
  } catch (error) {
    log("senpi-task shard sidecar store registration failed", { socket, error: String(error) })
    ports.notice("store_register_failed")
  }
}
