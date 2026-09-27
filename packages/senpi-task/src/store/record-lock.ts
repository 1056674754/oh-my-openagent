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

const LOCK_RETRY_MS = 10
const LOCK_WAIT_TIMEOUT_MS = 1_000
// The lock guards a sub-10ms record read-modify-write. Any lock file older than this window was
// left behind by a crashed or wedged holder; age (file mtime) is the staleness authority because a
// pid probe can false-alive after pid reuse and a partially written lock file has no parseable
// content. The async holder refreshes the mtime while it runs, so a live holder never expires.
// The pid+timestamp lines of the body are diagnostic; the token line names the acquisition.
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
  try {
    const fd = openSync(lockPath, "wx")
    try {
      writeSync(fd, `${process.pid}\n${Date.now()}\n${token}\n`)
    } finally {
      closeSync(fd)
    }
    return { acquired: token }
  } catch (error) {
    if (!hasCode(error, "EEXIST")) throw error
    return reapExpiredLock(lockPath)
  }
}

interface LockIdentity {
  readonly dev: number
  readonly ino: number
  readonly mtimeMs: number
  readonly body: string
}

/**
 * Removes the lock only when it is EXPIRED and is still the very lock that was judged expired. A
 * lock that is gone was released - the caller retries the create, nothing is removed. The expired
 * lock is renamed away (atomic: exactly one reaper obtains it) and compared with what was judged;
 * if a fresh holder published in between, the renamed file is that holder's, so it is linked back
 * (EEXIST: yet another contender already republished) instead of being deleted.
 */
function reapExpiredLock(lockPath: string): "retry" | "held" {
  const judged = readLockIdentity(lockPath)
  if (judged === undefined) return "retry"
  if (Date.now() - judged.mtimeMs <= LOCK_STALE_MS) return "held"
  const tombstone = `${lockPath}.reaping-${randomUUID()}`
  try {
    renameSync(lockPath, tombstone)
  } catch (error) {
    if (hasCode(error, "ENOENT")) return "retry"
    throw error
  }
  const moved = readLockIdentity(tombstone)
  if (moved !== undefined && !isSameLock(moved, judged)) {
    try {
      linkSync(tombstone, lockPath)
    } catch (error) {
      if (!hasCode(error, "EEXIST")) throw error
    }
  }
  rmSync(tombstone, { force: true })
  return "retry"
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
  let body: string
  try {
    body = readFileSync(lockPath, "utf8")
  } catch (error) {
    if (hasCode(error, "ENOENT")) return
    throw error
  }
  if (body.split("\n")[2] === token) rmSync(lockPath, { force: true })
}

function refreshLock(lockPath: string): void {
  const now = new Date()
  try {
    utimesSync(lockPath, now, now)
  } catch (error) {
    if (!hasCode(error, "ENOENT")) console.error("Task record lock heartbeat failed", error)
  }
}

function hasCode(error: unknown, expected: string): boolean {
  return error instanceof Error && "code" in error && error.code === expected
}
