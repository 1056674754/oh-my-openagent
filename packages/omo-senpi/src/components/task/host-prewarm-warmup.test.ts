import { afterEach, describe, expect, test } from "bun:test"

import { world, sockets, removeWorldDirs } from "./host-prewarm.test-support"

afterEach(removeWorldDirs)


// The warm-up session follows the session's own-shard pre-warm, which is POSIX-only by the plan (todo 9:
// "platform is not win32"): these cases resolve the shard through the POSIX socket layout (sun_path limit,
// owner-checked /tmp alternate root), which a win32 filesystem cannot host.
const posixWarmUpTest = test.skipIf(process.platform === "win32")

describe("the pre-warm opens one warm-up session on the host it warmed", () => {
  posixWarmUpTest("#given the default settings #when the first prompt warms the host #then one warm-up session opens on the session's own shard, in its cwd", async () => {
    // given
    const w = world({ prewarm: "default" })
    const seen = w.warmUpSeen()
    await w.sessionStart("root-1")

    // when
    await w.prompt("root-1")
    await w.prompt("root-1")
    await seen

    // then
    expect(w.warmUps).toEqual([{ socket: w.host.shardSocket(), cwd: w.root }])
  })

  posixWarmUpTest("#given session-start #when session_start warms the host #then the warm-up session follows the ensure", async () => {
    // given
    const w = world({ prewarm: "session-start" })
    const seen = w.warmUpSeen()

    // when
    await w.sessionStart("root-1")
    await seen

    // then
    expect(sockets(w.ensures)).toEqual([w.host.shardSocket()])
    expect(w.warmUps.map((entry) => entry.socket)).toEqual([w.host.shardSocket()])
  })

  posixWarmUpTest("#given a host that could not be ensured #when the pre-warm runs #then no warm-up session is attempted", async () => {
    // given
    const w = world({ prewarm: "session-start", ensure: "reject" })

    // when
    await w.sessionStart("root-1")
    await new Promise((resolve) => setImmediate(resolve))

    // then
    expect(w.ensures).toHaveLength(1)
    expect(w.warmUps).toEqual([])
  })

  posixWarmUpTest("#given a warm-up session that fails #when the pre-warm runs #then nothing escapes and the first child still routes to the host", async () => {
    // given
    const w = world({ prewarm: "first-turn", warmSession: "reject" })
    const seen = w.warmUpSeen()
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason)
    }
    process.on("unhandledRejection", onUnhandled)

    try {
      // when
      await w.prompt("root-1")
      await seen
      await new Promise((resolve) => setImmediate(resolve))
      const mode = await w.host.executionModeGate.ensure()

      // then
      expect(unhandled).toEqual([])
      expect(mode).toBe("process")
      expect(w.ensures).toHaveLength(1)
      expect(w.host.notices.list()).toEqual([])
    } finally {
      process.off("unhandledRejection", onUnhandled)
    }
  })

  test("#given an omo-spawned session #when every prewarm edge fires #then no warm-up session is opened", async () => {
    // given
    const w = world({ prewarm: "session-start", sessionRole: "child" })

    // when
    await w.sessionStart("child-1")
    await w.prompt("child-1")
    await new Promise((resolve) => setImmediate(resolve))

    // then
    expect(w.warmUps).toEqual([])
  })
})
