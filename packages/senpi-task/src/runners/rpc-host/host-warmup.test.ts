import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { startFakeHost, type FakeHost } from "./__fixtures__/fake-host"
import { HOST_WARMUP_TASK_ID, warmHostSession } from "./host-warmup"
import { HOST_WARMUP_CONTEXT, isHostWarmupSession } from "./session-role"

const hosts: FakeHost[] = []
const roots: string[] = []

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stop()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function world(options: Parameters<typeof startFakeHost>[0] = {}) {
  const host = await startFakeHost({ enforceSessionDir: true, ...options })
  hosts.push(host)
  const tempRoot = mkdtempSync(join(tmpdir(), "omo-warmup-test-"))
  roots.push(tempRoot)
  const warm = () =>
    warmHostSession({
      socket: host.socketPath,
      cwd: "/tmp/parent-cwd",
      tempRoot,
      ports: { probeProtocolInfo: () => host.probeProtocolInfo() },
    })
  return { host, tempRoot, warm }
}

describe("warmHostSession", () => {
  test("#given a fresh host #when it is warmed #then one child-shaped, unretained warm-up session opens and is closed", async () => {
    // given
    const w = await world()

    // when
    await w.warm()

    // then
    const opens = w.host.commands.filter((command) => command.type === "open_session")
    expect(opens).toHaveLength(1)
    const payload = opens[0]?.payload ?? {}
    const context = payload["context"]
    expect(context).toEqual({
      role: "child",
      task_id: HOST_WARMUP_TASK_ID,
      state_dir: dirname(String(payload["sessionPath"])),
      [HOST_WARMUP_CONTEXT]: "1",
    })
    expect(payload["retain_on_disconnect"]).toBe(false)
    expect(payload["kind"]).toBe("worker")
    expect(w.host.commands.some((command) => command.type === "close_session")).toBe(true)
    expect(w.host.sessions()).toEqual([])
    expect(isHostWarmupSession({ sessionContext: context })).toBe(true)
  })

  test("#given a warm-up that finished #when its temp root is listed #then its private state directory is gone", async () => {
    // given
    const w = await world()

    // when
    await w.warm()

    // then
    expect(readdirSync(w.tempRoot)).toEqual([])
  })

  test("#given a host that refuses the open #when it is warmed #then the refusal reaches the caller and nothing is left behind", async () => {
    // given
    const w = await world({ openFailure: { code: "invalid_launch_profile", detail: "refused" } })

    // when
    const outcome = await w.warm().then(
      () => "resolved",
      () => "rejected",
    )

    // then
    expect(outcome).toBe("rejected")
    expect(readdirSync(w.tempRoot)).toEqual([])
    expect(w.host.sessions()).toEqual([])
    await w.host.waitForConnections(0)
  })

  test("#given an ordinary child context #when it is read #then it is not a warm-up session", () => {
    expect(isHostWarmupSession({ sessionContext: { role: "child", task_id: "t-1" } })).toBe(false)
    expect(isHostWarmupSession({})).toBe(false)
  })
})
