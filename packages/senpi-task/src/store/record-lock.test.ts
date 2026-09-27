import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs"
import { hostname, tmpdir } from "node:os"
import { join } from "node:path"

import { readProcessStartIdentity } from "./lock-owner"
import { withTaskRecordLock, withTaskRecordLockAsync } from "./record-lock"

const dirs: string[] = []
const children: Bun.Subprocess[] = []

afterEach(async () => {
  for (const child of children.splice(0)) {
    child.kill()
    await child.exited
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function recordPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "record-lock-"))
  dirs.push(dir)
  return join(dir, "st_1.json")
}

function liveProcess(): number {
  const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], { stdout: "ignore", stderr: "ignore" })
  children.push(child)
  return child.pid
}

async function deadPid(): Promise<number> {
  const child = Bun.spawn([process.execPath, "-e", ""], { stdout: "ignore", stderr: "ignore" })
  await child.exited
  return child.pid
}

function writeLock(path: string, body: string, ageMs: number): void {
  writeFileSync(`${path}.lock`, body)
  const mtime = new Date(Date.now() - ageMs)
  utimesSync(`${path}.lock`, mtime, mtime)
}

function lockTaken(path: string): unknown {
  try {
    return withTaskRecordLock(path, () => "ran")
  } catch (error) {
    return error
  }
}

describe("task record lock", () => {
  test("#given a lock whose holder process is gone #when the record is locked #then the lock is reaped and the operation runs", async () => {
    // given
    const path = recordPath()
    writeLock(path, `${await deadPid()}\n0\ncrashed-holder\n`, 60_000)

    // when
    const result = await withTaskRecordLockAsync(path, () => Promise.resolve("ran"))

    // then
    expect(result).toBe("ran")
    expect(existsSync(`${path}.lock`)).toBe(false)
  })

  test("#given a just-written lock whose holder already died #when the record is locked #then it is reaped without waiting for it to age", async () => {
    // given
    const path = recordPath()
    writeLock(path, `${await deadPid()}\n${Date.now()}\ncrashed-holder\nunavailable\n${hostname()}\n`, 0)

    // when
    const result = lockTaken(path)

    // then
    expect(result).toBe("ran")
  })

  test("#given an old lock a live process holds #when the wait times out #then that lock is left exactly as it was", () => {
    // given
    const path = recordPath()
    const holder = liveProcess()
    const body = `${holder}\n0\nlive-holder\n${readProcessStartIdentity(holder)}\n${hostname()}\n`
    writeLock(path, body, 60_000)
    const before = statSync(`${path}.lock`)

    // when
    const failure = lockTaken(path)

    // then
    expect(failure).toBeInstanceOf(Error)
    expect(readFileSync(`${path}.lock`, "utf8")).toBe(body)
    expect(statSync(`${path}.lock`).ino).toBe(before.ino)
  })

  test("#given an old legacy lock (no start identity) a live process holds #when the wait times out #then it is not reaped", () => {
    // given
    const path = recordPath()
    const body = `${liveProcess()}\n0\nlegacy-holder\n`
    writeLock(path, body, 60_000)

    // when
    const failure = lockTaken(path)

    // then
    expect(failure).toBeInstanceOf(Error)
    expect(readFileSync(`${path}.lock`, "utf8")).toBe(body)
  })

  test("#given a fresh lock whose pid now belongs to another process #when the record is locked #then the recycled owner is proven dead and reaped", () => {
    // given - same pid, a start identity of the same scheme that is not this process's
    const path = recordPath()
    const holder = liveProcess()
    const actual = readProcessStartIdentity(holder)
    expect(actual).not.toBeNull()
    const recycled = `${actual?.slice(0, actual.indexOf(":"))}:1`
    writeLock(path, `${holder}\n${Date.now()}\nrecycled-holder\n${recycled}\n${hostname()}\n`, 0)

    // when
    const result = lockTaken(path)

    // then
    expect(result).toBe("ran")
  })

  test("#given a lock written on another host #when the wait times out #then it is never reaped", async () => {
    // given
    const path = recordPath()
    const body = `${await deadPid()}\n0\nremote-holder\nunavailable\nsome-other-host.invalid\n`
    writeLock(path, body, 60_000)

    // when
    const failure = lockTaken(path)

    // then
    expect(failure).toBeInstanceOf(Error)
    expect(readFileSync(`${path}.lock`, "utf8")).toBe(body)
  })

  test("#given an empty lock #when it is fresh #then it is held, and once past the stale window #then it is reaped", () => {
    // given
    const fresh = recordPath()
    const abandoned = recordPath()
    writeLock(fresh, "", 0)
    writeLock(abandoned, "", 60_000)

    // when
    const freshResult = lockTaken(fresh)
    const abandonedResult = lockTaken(abandoned)

    // then
    expect(freshResult).toBeInstanceOf(Error)
    expect(abandonedResult).toBe("ran")
  })

  test("#given a dead lock and a recovery lock left by a reaper that died #when the record is locked #then both are recovered and the operation runs", async () => {
    // given
    const path = recordPath()
    writeLock(path, `${await deadPid()}\n0\ncrashed-holder\n`, 60_000)
    writeFileSync(`${path}.lock.recovery`, `${await deadPid()}\n0\ncrashed-reaper\nunavailable\n${hostname()}\n`)

    // when
    const result = lockTaken(path)

    // then
    expect(result).toBe("ran")
    expect(existsSync(`${path}.lock.recovery`)).toBe(false)
  })

  test("#given a holder whose lock another process took over meanwhile #when the holder releases #then the other process's lock survives", async () => {
    // given - the lock file is replaced mid-operation, as after a reap and a fresh acquire
    const path = recordPath()
    const successor = `${process.pid + 1}\n${Date.now()}\nsuccessor\n`

    // when
    await withTaskRecordLockAsync(path, () => Promise.resolve(writeFileSync(`${path}.lock`, successor)))
    withTaskRecordLock(`${path}-sync`, () => writeFileSync(`${path}-sync.lock`, successor))

    // then
    expect(readFileSync(`${path}.lock`, "utf8")).toBe(successor)
    expect(readFileSync(`${path}-sync.lock`, "utf8")).toBe(successor)
  })
})
