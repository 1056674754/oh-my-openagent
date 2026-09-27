import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { withTaskRecordLock, withTaskRecordLockAsync } from "./record-lock"

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function recordPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "record-lock-"))
  dirs.push(dir)
  return join(dir, "st_1.json")
}

describe("task record lock", () => {
  test("#given a lock left by a crashed holder long ago #when the record is locked #then the expired lock is reaped and the operation runs", async () => {
    // given
    const path = recordPath()
    writeFileSync(`${path}.lock`, "99999\n0\ncrashed-holder\n")
    const longAgo = new Date(Date.now() - 60_000)
    utimesSync(`${path}.lock`, longAgo, longAgo)

    // when
    const result = await withTaskRecordLockAsync(path, () => Promise.resolve("ran"))

    // then
    expect(result).toBe("ran")
    expect(existsSync(`${path}.lock`)).toBe(false)
  })

  test("#given a lock another process holds right now #when the wait times out #then that lock is left exactly as it was", () => {
    // given
    const path = recordPath()
    const foreign = `${process.pid + 1}\n${Date.now()}\nlive-holder\n`
    writeFileSync(`${path}.lock`, foreign)

    // when
    const failure = (() => {
      try {
        return withTaskRecordLock(path, () => "ran")
      } catch (error) {
        return error
      }
    })()

    // then
    expect(failure).toBeInstanceOf(Error)
    expect(readFileSync(`${path}.lock`, "utf8")).toBe(foreign)
  })

  test("#given a holder whose lock another process took over meanwhile #when the holder releases #then the other process's lock survives", async () => {
    // given - the lock file is replaced mid-operation, as after an expiry reap and a fresh acquire
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
