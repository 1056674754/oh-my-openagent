import { randomUUID } from "node:crypto"
import {
  closeSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeSync,
} from "node:fs"
import { dirname } from "node:path"

import { formatLockBody, isLockOwnerProvenDead, parseLockOwner } from "./lock-owner"

const LOCK_RETRY_MS = 10
const LOCK_WAIT_TIMEOUT_MS = 1_000
// A lock is taken from its holder only on proof that the holder is dead (lock-owner.ts); age alone
// never expires a lock. The one exception is a lock with no parseable owner - its writer died between
// the create and the write, which takes microseconds - once it is older than this window.
// The async holder still refreshes the mtime so that builds which expire locks by age leave it alone.
const LOCK_STALE_MS = 5_000
const sleeper = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT))

export function withTaskRecordLock<T>(recordPath: string, operation: () => T): T {
  const lockPath = `${recordPath}.lock`
  mkdirSync(dirname(lockPath), { recursive: true })
  const token = acquireLock(lockPath)
  try {
    return operation()
  } finally {
    releaseLock(lockPath, token)
  }
}

export async function withTaskRecordLockAsync<T>(recordPath: string, operation: () => Promise<T>): Promise<T> {
  const lockPath = `${recordPath}.lock`
  mkdirSync(dirname(lockPath), { recursive: true })
  const token = await acquireLockAsync(lockPath)
  const heartbeat = setInterval(() => refreshLock(lockPath), LOCK_STALE_MS / 2)
  heartbeat.unref()
  try {
    return await operation()
  } finally {
    clearInterval(heartbeat)
    releaseLock(lockPath, token)
  }
}

type AcquireAttempt = { readonly acquired: string } | "retry" | "held"

function acquireLock(lockPath: string): string {
  const startedAt = Date.now()
  for (;;) {
    const attempt = tryAcquire(lockPath)
    if (attempt === "retry") continue
    if (attempt !== "held") return attempt.acquired
    if (Date.now() - startedAt >= LOCK_WAIT_TIMEOUT_MS) {
      throw new Error(`Timed out acquiring task record lock: ${lockPath}`)
    }
    Atomics.wait(sleeper, 0, 0, LOCK_RETRY_MS)
  }
}

async function acquireLockAsync(lockPath: string): Promise<string> {
  const startedAt = Date.now()
  for (;;) {
    const attempt = tryAcquire(lockPath)
    if (attempt === "retry") continue
    if (attempt !== "held") return attempt.acquired
    if (Date.now() - startedAt >= LOCK_WAIT_TIMEOUT_MS) {
      throw new Error(`Timed out acquiring task record lock: ${lockPath}`)
    }
    await new Promise<void>((resolve) => setTimeout(resolve, LOCK_RETRY_MS))
  }
}

function tryAcquire(lockPath: string): AcquireAttempt {
  const token = randomUUID()
  if (publishLock(lockPath, token)) return { acquired: token }
  return reapAbandonedLock(lockPath)
}

function publishLock(lockPath: string, token: string): boolean {
  let fd: number
  try {
    fd = openSync(lockPath, "wx")
  } catch (error) {
    if (hasCode(error, "EEXIST")) return false
    throw error
  }
  try {
    writeSync(fd, formatLockBody(token))
  } finally {
    closeSync(fd)
  }
  return true
}

interface LockIdentity {
  readonly dev: number
  readonly ino: number
  readonly mtimeMs: number
  readonly body: string
}

function isAbandoned(lock: LockIdentity): boolean {
  const owner = parseLockOwner(lock.body)
  return owner === undefined ? Date.now() - lock.mtimeMs > LOCK_STALE_MS : isLockOwnerProvenDead(owner)
}

/**
 * Removes a lock whose owner is proven dead. Reapers serialize on `<lock>.recovery`: while one holds
 * it, the judged lock can change only by that reaper (its dead owner never releases, and nobody
 * creates over an existing file), so re-reading it unchanged and unlinking it can never remove a
 * fresh holder's lock. A lock that changed since the judgement is simply judged again.
 */
function reapAbandonedLock(lockPath: string): "retry" | "held" {
  const judged = readLockIdentity(lockPath)
  if (judged === undefined) return "retry"
  if (!isAbandoned(judged)) return "held"
  const recoveryPath = `${lockPath}.recovery`
  const recoveryToken = randomUUID()
  if (!publishLock(recoveryPath, recoveryToken)) {
    if (!reclaimAbandonedRecoveryLock(recoveryPath) || !publishLock(recoveryPath, recoveryToken)) return "held"
  }
  try {
    const current = readLockIdentity(lockPath)
    if (current === undefined || !isSameLock(current, judged)) return "retry"
    // Fence: a reaper that lost its recovery lock (see below) must not unlink the primary.
    if (readToken(recoveryPath) !== recoveryToken) return "held"
    rmSync(lockPath, { force: true })
    return "retry"
  } finally {
    releaseLock(recoveryPath, recoveryToken)
  }
}

/**
 * A recovery lock is held for microseconds, so one left behind means its reaper died; it is reclaimed
 * on the same proof. Rename is atomic - exactly one reclaimer obtains the file - and a file that is no
 * longer the judged one is handed back with link. Only when two reapers died in a row can that
 * hand-back lose to a third reaper; the fence in reapAbandonedLock keeps the loser off the primary.
 */
function reclaimAbandonedRecoveryLock(recoveryPath: string): boolean {
  const judged = readLockIdentity(recoveryPath)
  if (judged === undefined) return true
  if (!isAbandoned(judged)) return false
  const tombstone = `${recoveryPath}.reaping-${randomUUID()}`
  try {
    renameSync(recoveryPath, tombstone)
  } catch (error) {
    if (hasCode(error, "ENOENT")) return true
    if (isWindowsSharingError(error)) return false
    throw error
  }
  const moved = readLockIdentity(tombstone)
  const reclaimed = moved === undefined || isSameLock(moved, judged)
  if (!reclaimed) {
    try {
      linkSync(tombstone, recoveryPath)
    } catch (error) {
      if (!hasCode(error, "EEXIST")) throw error
    }
  }
  rmSync(tombstone, { force: true })
  return reclaimed
}

function readLockIdentity(lockPath: string): LockIdentity | undefined {
  try {
    const stat = statSync(lockPath)
    return { dev: stat.dev, ino: stat.ino, mtimeMs: stat.mtimeMs, body: readFileSync(lockPath, "utf8") }
  } catch (error) {
    if (hasCode(error, "ENOENT")) return undefined
    throw error
  }
}

function isSameLock(left: LockIdentity, right: LockIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mtimeMs === right.mtimeMs && left.body === right.body
}

// Only the acquisition that wrote the token releases the lock: a holder whose lock expired and was
// reaped must not delete the lock the next process has since taken.
function releaseLock(lockPath: string, token: string): void {
  if (readToken(lockPath) === token) rmSync(lockPath, { force: true })
}

function readToken(lockPath: string): string | undefined {
  try {
    return readFileSync(lockPath, "utf8").split("\n")[2]
  } catch (error) {
    if (hasCode(error, "ENOENT")) return undefined
    throw error
  }
}

function refreshLock(lockPath: string): void {
  const now = new Date()
  try {
    utimesSync(lockPath, now, now)
  } catch (error) {
    if (!hasCode(error, "ENOENT")) console.error("Task record lock heartbeat failed", error)
  }
}

function isWindowsSharingError(error: unknown): boolean {
  return process.platform === "win32" && ["EBUSY", "EPERM", "EACCES"].some((code) => hasCode(error, code))
}

function hasCode(error: unknown, expected: string): boolean {
  return error instanceof Error && "code" in error && error.code === expected
}
