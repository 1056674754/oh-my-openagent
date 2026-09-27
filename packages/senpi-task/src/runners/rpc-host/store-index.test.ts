import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { DURABLE_JSON_FS } from "./durable-json"
import { readTaskStoreIndex, registerStoreIndex, StoreIndexUnavailableError, taskStoreIndexPath } from "./store-index"

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function indexPath(): string {
  const agentDir = mkdtempSync(join(tmpdir(), "dh-t7-index-"))
  dirs.push(agentDir)
  return taskStoreIndexPath(agentDir)
}

describe("registerStoreIndex", () => {
  test("#given a store registered twice #when read back #then it is listed once and keeps its first_seen", async () => {
    // given
    const path = indexPath()
    let now = 1_000

    // when
    await registerStoreIndex({ indexPath: path, storeDir: "/p1/.omo/senpi-task", now: () => now })
    now = 2_000
    await registerStoreIndex({ indexPath: path, storeDir: "/p1/.omo/senpi-task", now: () => now })

    // then
    expect(readTaskStoreIndex(path)).toEqual({
      version: 1,
      stores: { "/p1/.omo/senpi-task": { first_seen: new Date(1_000).toISOString(), last_seen: new Date(2_000).toISOString() } },
    })
  })

  test("#given a write whose read-back does not contain the store #when registering #then it is unavailable", async () => {
    // given - the write lands nowhere: every read returns the empty index
    const path = indexPath()
    const fs = { read: () => undefined, write: () => undefined }

    // when
    const failure = await registerStoreIndex({ indexPath: path, storeDir: "/tmp/x-store", now: Date.now, fs }).catch((error: unknown) => error)

    // then
    expect(failure).toBeInstanceOf(StoreIndexUnavailableError)
  })

  test("#given a corrupt index #when registering #then it is unavailable and the file is left as it was", async () => {
    // given
    const path = indexPath()
    DURABLE_JSON_FS.write(path, "{not json")

    // when
    const failure = await registerStoreIndex({ indexPath: path, storeDir: "/tmp/x-store", now: Date.now }).catch((error: unknown) => error)

    // then
    expect(failure).toBeInstanceOf(StoreIndexUnavailableError)
    expect(DURABLE_JSON_FS.read(path)).toBe("{not json")
  })

  test("#given a parent path that is a file #when registering #then it is unavailable", async () => {
    // given
    const path = indexPath()
    const agentDir = join(path, "..", "..")
    writeFileSync(join(agentDir, "rpc"), "file")

    // when
    const failure = await registerStoreIndex({ indexPath: path, storeDir: "/tmp/x-store", now: Date.now }).catch((error: unknown) => error)

    // then
    expect(failure).toBeInstanceOf(StoreIndexUnavailableError)
  })
})
