import { log } from "@oh-my-opencode/utils"

import type { HostSessionIdentity } from "../state"
import type { LifecycleContext } from "./context"

/**
 * End a daemon session this process holds no handle for, and report whether the daemon CONFIRMED it.
 * A refused attach or close_session, and a daemon that never answers within `hostCloseTimeoutMs`, are
 * unconfirmed: the caller must keep whatever points at the session (a record, a cleanup obligation)
 * and must not start anything in its place.
 */
export async function closeHostSessionConfirmed(
  context: LifecycleContext,
  taskId: string,
  hostSession: HostSessionIdentity,
  cwd: string | undefined,
): Promise<boolean> {
  const close = context.hostSessionClose
  if (close === undefined) return false
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), context.hostCloseTimeoutMs)
    timer.unref?.()
  })
  try {
    const outcome = await Promise.race([close({ hostSession, ...(cwd === undefined ? {} : { cwd }) }).then(() => "closed" as const), timedOut])
    if (outcome === "timeout") {
      log("senpi-task host session close not confirmed in time", { taskId, sessionPath: hostSession.session_path })
      return false
    }
  } catch (error) {
    log("senpi-task host session close not confirmed", { taskId, error: String(error) })
    return false
  } finally {
    clearTimeout(timer)
  }
  context.store.appendEvent(taskId, {
    type: "host_session_closed",
    payload: { session_path: hostSession.session_path, socket: hostSession.socket },
  })
  return true
}
