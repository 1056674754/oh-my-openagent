/**
 * The bound on ONE lost transport's recovery (omo#9403). Within it the child either runs again on a
 * recovered connection or ends as `transport lost`; it never waits on a connection that is gone.
 * The bound only starts on transport evidence (the connection closed), so a quiet child whose
 * connection is fine is never failed by it.
 */

export const TRANSPORT_RECOVERY_BOUND_MS = 180_000

export const TRANSPORT_LOST_REASON = "transport lost: the connection to the task host dropped and the child did not resume"

export interface RecoveryClock {
  schedule(ms: number, expire: () => void): () => void
}

export interface TransportRecoveryOptions {
  readonly boundMs?: number
  readonly clock?: RecoveryClock
}

const realRecoveryClock: RecoveryClock = {
  schedule: (ms, expire) => {
    const timer = setTimeout(expire, ms)
    timer.unref?.()
    return () => clearTimeout(timer)
  },
}

export class TransportRecoveryExpiredError extends Error {
  readonly code = "transport_recovery_expired"

  constructor() {
    super(TRANSPORT_LOST_REASON)
    this.name = "TransportRecoveryExpiredError"
  }
}

export function isTransportRecoveryExpired(error: unknown): error is TransportRecoveryExpiredError {
  return error instanceof TransportRecoveryExpiredError
}

export interface RecoveryBound {
  readonly expired: Promise<"expired">
  isExpired(): boolean
  settle(): void
}

export function armRecoveryBound(options: TransportRecoveryOptions | undefined): RecoveryBound {
  const { promise, resolve } = Promise.withResolvers<"expired">()
  let expired = false
  const clock = options?.clock ?? realRecoveryClock
  const cancel = clock.schedule(options?.boundMs ?? TRANSPORT_RECOVERY_BOUND_MS, () => {
    expired = true
    resolve("expired")
  })
  return {
    expired: promise,
    isExpired: () => expired,
    settle: cancel,
  }
}

export async function withinBound<T>(bound: RecoveryBound, work: Promise<T>): Promise<T> {
  const winner = await Promise.race([work, bound.expired])
  if (winner === "expired" && bound.isExpired()) throw new TransportRecoveryExpiredError()
  return winner as T
}
