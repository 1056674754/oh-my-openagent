import { log } from "@oh-my-opencode/utils"

import type { HostSessionPort } from "./handle-port"

/** How long `terminate()` waits for the host to acknowledge the abort before closing anyway. */
const ABORT_GRACE_MS = 2_000

export interface HostTeardownInput {
  readonly taskId: string
  readonly closeGraceMs: number
  port(): HostSessionPort
}

// Bounded teardown: a daemon that never answers must not hold the parent's shutdown open, and a
// session is never ended with a signal.
export async function endSessionOnHost(input: HostTeardownInput, next: "closed" | "terminated"): Promise<void> {
  const bestEffort = async (work: () => Promise<void>, step: string): Promise<void> => {
    try {
      await work()
    } catch (error) {
      log("senpi-task host session teardown step failed", { taskId: input.taskId, step, error: String(error) })
    }
  }
  if (next === "terminated") await settleWithin(bestEffort(() => input.port().send({ type: "abort" }), "abort"), ABORT_GRACE_MS)
  await settleWithin(bestEffort(() => input.port().close(), "close_session"), input.closeGraceMs)
}

/** Resolve when the work settles or the budget expires, whichever comes first. */
function settleWithin(work: Promise<void>, budgetMs: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, budgetMs)
    timer.unref?.()
    void work.then(() => {
      clearTimeout(timer)
      resolve()
    })
  })
}
