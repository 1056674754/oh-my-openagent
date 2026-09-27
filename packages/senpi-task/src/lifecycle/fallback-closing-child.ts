import { log } from "@oh-my-opencode/utils"

import type { TaskRecord } from "../state"
import type { LifecycleContext } from "./context"
import { forgetClosedChild } from "./fallback-handoff"
import { terminateOldRpc } from "./revive-rollback"

/**
 * A handoff whose owner died before its failed rung finished closing still names that rung's child in
 * `fallback_closing_child`. The child must be ended before the next rung is launched, or the task ends
 * up with two children: a retained daemon session nobody owns, and the fresh one. Returns false while
 * the child may still be alive (the close was refused or the process outlived SIGKILL), so the caller
 * defers the revival instead of launching beside it.
 */
export async function endClosingFallbackChild(context: LifecycleContext, record: TaskRecord): Promise<boolean> {
  const closing = record.fallback_closing_child
  if (closing === undefined) return true
  const ended = closing.host_session === undefined
    ? await terminateOldRpc(context, { ...record, ...(closing.pid === undefined ? {} : { pid: closing.pid }) })
    : await closeClosingSession(context, record, closing.host_session)
  if (!ended) return false
  context.store.mutate(record.task_id, (fresh) => forgetClosedChild(fresh, closing))
  return true
}

async function closeClosingSession(
  context: LifecycleContext,
  record: TaskRecord,
  hostSession: NonNullable<NonNullable<TaskRecord["fallback_closing_child"]>["host_session"]>,
): Promise<boolean> {
  // Closed whenever the daemon answers, not only when it lists the path: closing a session that is
  // already gone is harmless, and a session left open here is never closed by anyone.
  if (!(await context.hostSessionProbe.daemonAlive(hostSession))) return true
  const close = context.hostSessionClose
  if (close === undefined) return false
  try {
    await close({ hostSession, ...(record.spawn_spec?.cwd === undefined ? {} : { cwd: record.spawn_spec.cwd }) })
  } catch (error) {
    log("senpi-task closing fallback session close rejected", { taskId: record.task_id, error: String(error) })
    return false
  }
  context.store.appendEvent(record.task_id, {
    type: "host_session_closed",
    payload: { session_path: hostSession.session_path, socket: hostSession.socket },
  })
  return true
}
