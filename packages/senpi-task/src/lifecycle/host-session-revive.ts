import { log } from "@oh-my-opencode/utils"

import type { TaskRecord } from "../state"
import type { LifecycleContext } from "./context"
import { hostSessionResumePath, isHostSessionRecord, type HostSessionRecord } from "./host-session"
import { parkedReason, reachRecordedHost, type HostParkedReason, type RecordedHostVerdict } from "./host-endpoint-reach"
import { markSuspensionReason, parkHostSessionRecord } from "./host-session-record"
import { deferred, reviveClaimed } from "./reconcile-reclamation"
import { claimResidencySlot } from "./residency"
import type { ReconcileOutcome } from "./types"

/**
 * Reviving a child that lives on the shared daemon. A host session has no pid, so nothing here can
 * (or may) signal: the only two answers are "attach/reopen it" and "leave it parked". A parked
 * record is NEVER lost - losing it would throw away a transcript the daemon still owns.
 */

export type HostSessionParkOutcome =
  | { readonly kind: "revived" }
  | { readonly kind: "suspended"; readonly reason: HostParkedReason }

export type HostSessionParkOptions = {
  /** Test seam: observe (and drive) the daemon between the bounded reconcile's attempts. */
  readonly beforeAttempt?: (attempt: number) => void
}

/**
 * The reconciliation branch for a daemon-hosted orphan: reach the RECORDED endpoint (re-ensuring it
 * unless it is this session's own), then a live session is re-attached and a parked one reopened from
 * its JSONL there. An endpoint that stays out of reach leaves the record suspended with the reason -
 * never `lost`, never signalled, never moved.
 */
export async function reconcileHostSessionOrphan(
  context: LifecycleContext,
  record: HostSessionRecord,
): Promise<ReconcileOutcome> {
  const verdict = await reachRecordedHost(context, record.host_session)
  if (verdict !== "alive") {
    const reason = parkedReason(verdict)
    parkHostSessionRecord(context, record.task_id)
    markSuspensionReason(context, record.task_id, reason)
    context.store.appendEvent(record.task_id, { type: "suspended", payload: { reason } })
    return deferred(record.task_id, verdict)
  }
  return await reviveClaimed(context, record, "rpc_detached", record.host_session.session_path)
}

/**
 * The daemon died under a live child: park it, then retry the reconcile on a bounded backoff
 * (1 s / 4 s / 16 s). If the daemon never comes back the record STAYS rpc_detached carrying
 * `daemon_unavailable`, which is what task_output reports - it is not an error and not a loss.
 */
export async function parkHostSessionOnDaemonLoss(
  context: LifecycleContext,
  taskId: string,
  options: HostSessionParkOptions = {},
): Promise<HostSessionParkOutcome> {
  const parked = context.store.load(taskId)
  if (!isHostSessionRecord(parked)) return { kind: "suspended", reason: "daemon_unavailable" }
  context.registry.forget(taskId)
  parkHostSessionRecord(context, taskId)
  context.store.appendEvent(taskId, { type: "suspended", payload: { reason: "daemon_unavailable" } })

  let attempt = 0
  let verdict: RecordedHostVerdict = "host_unreachable"
  for (const backoffMs of context.hostRetry.daemonLossBackoffMs) {
    attempt += 1
    await context.hostRetry.wait(backoffMs)
    options.beforeAttempt?.(attempt)
    context.hostSessionProbe.refresh()
    verdict = await reachRecordedHost(context, parked.host_session)
    // An incompatible host will not become compatible by waiting; the session stays where it is.
    if (verdict === "host_incompatible") break
    if (verdict !== "alive") continue
    if (await reviveParkedHostSession(context, taskId)) return { kind: "revived" }
  }
  const reason = verdict === "alive" ? "daemon_unavailable" : parkedReason(verdict)
  markSuspensionReason(context, taskId, reason)
  return { kind: "suspended", reason }
}

async function reviveParkedHostSession(context: LifecycleContext, taskId: string): Promise<boolean> {
  const claimed = claimResidencySlot(
    context,
    taskId,
    (fresh: TaskRecord) => fresh.residency_state === "rpc_detached" && fresh.killed !== true,
  )
  if (claimed !== "claimed") return false
  const fresh = context.store.load(taskId)
  if (fresh === null) return false
  try {
    const outcome = await reviveClaimed(context, fresh, "rpc_detached", hostSessionResumePath(fresh))
    return outcome.kind === "resumed"
  } catch (error) {
    log("senpi-task host session revive after daemon loss failed", { taskId, error: String(error) })
    return false
  }
}
