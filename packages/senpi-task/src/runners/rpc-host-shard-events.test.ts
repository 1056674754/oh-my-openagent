import { afterEach, describe, expect, test } from "bun:test"

import type { ReattachOutcomeInfo, TransportLostInfo } from "./rpc-host/handle-reattach"
import { isHostSessionHandle } from "./rpc-host"
import { childSpec, hostRunnerHarness } from "./rpc-host.test-support"

// Todo 10: the runner tells the parent's crash notice when each child starts recovering from a lost
// host and how that recovery ended, without changing what recovery does.

const { fakeHost, runnerOver, release } = hostRunnerHarness()

afterEach(async () => {
  await release()
})

const NO_WAIT = { reattachDelaysMs: [0, 0, 0], sleep: () => Promise.resolve() } as const

function recorder() {
  const lost: TransportLostInfo[] = []
  const outcome = Promise.withResolvers<ReattachOutcomeInfo>()
  return {
    lost,
    outcome: outcome.promise,
    events: {
      onTransportLost: (info: TransportLostInfo) => lost.push(info),
      onReattachOutcome: (info: ReattachOutcomeInfo) => outcome.resolve(info),
    },
  }
}

describe("RpcHostRunner shard events", () => {
  test("#given a child mid-turn #when its host dies and comes back #then it reports the lost generation and a continued outcome on the new one", async () => {
    // given
    const host = await fakeHost()
    const seen = recorder()
    const runner = runnerOver(host, { ...NO_WAIT, shardEvents: seen.events })
    const handle = await runner.start(childSpec())
    if (!isHostSessionHandle(handle)) throw new Error("the child did not open on the host")
    const lostGeneration = handle.hostSession.instanceId

    // when
    await host.restart()
    const reported = await seen.outcome

    // then
    expect(seen.lost).toEqual([
      { taskId: handle.task_id, socket: host.socketPath, instanceId: lostGeneration, turnWasInFlight: true },
    ])
    expect(reported.outcome).toBe("continued")
    expect(reported.socket).toBe(host.socketPath)
    expect(reported.newInstanceId).toBe(handle.hostSession.instanceId)
    await handle.terminate()
  })

  test("#given a child mid-turn #when its host never comes back #then it reports lost", async () => {
    // given
    const host = await fakeHost()
    const seen = recorder()
    const runner = runnerOver(host, { ...NO_WAIT, shardEvents: seen.events })
    const handle = await runner.start(childSpec())

    // when
    host.crash()
    const reported = await seen.outcome

    // then
    expect(seen.lost.map((info) => info.turnWasInFlight)).toEqual([true])
    expect(reported.outcome).toBe("lost")
    expect(reported.newInstanceId).toBeUndefined()
    expect((await handle.waitForExit()).kind).toBe("crashed")
  })

  test("#given an observer that throws #when the host dies and comes back #then the child still reattaches and is re-prompted", async () => {
    // given
    const host = await fakeHost()
    const runner = runnerOver(host, {
      ...NO_WAIT,
      shardEvents: {
        onTransportLost: () => {
          throw new Error("observer bug")
        },
        onReattachOutcome: () => {
          throw new Error("observer bug")
        },
      },
    })
    const handle = await runner.start(childSpec())

    // when
    await host.restart()
    await host.waitForCommand("prompt")

    // then
    expect(handle.exitOutcome()).toBeUndefined()
    await handle.terminate()
  })
})
