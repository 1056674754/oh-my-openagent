import { afterEach, describe, expect, test } from "bun:test"

import { hostSession, hostSessionRecordInput } from "../lifecycle/__fixtures__/host-session-fakes"
import { cleanupProjects, seedRecord, tempStore } from "../lifecycle/__fixtures__/lifecycle-fakes"
import { RunnerError } from "../runners/in-process/runner-error"
import type { RpcRunnerSpec } from "../runners/types"
import type { SuspensionReason } from "../state"
import type { ManagedChildHandle } from "./child-handle"
import { createOutcomeTracker } from "./manager-outcome"
import { respawnManagedTask } from "./manager-respawn"

afterEach(cleanupProjects)

const SHARD = "/tmp/dh-t7/shards/p-00000000000000e1.sock"
const LEGACY = "/tmp/dh-t7/rpc.sock"

function parkingHandle(taskId: string) {
  const listeners = new Set<(event: { readonly reason?: SuspensionReason }) => void>()
  const handle: ManagedChildHandle = {
    task_id: taskId,
    kind: "host-session",
    sessionId: "child",
    pid: undefined,
    onParked: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    steer: () => Promise.resolve(),
    followUp: () => Promise.resolve(),
    abort: () => Promise.resolve(),
    subscribe: () => () => undefined,
    waitForOutcome: () => new Promise(() => undefined),
    lastAssistantText: () => undefined,
    dispose: () => Promise.resolve(),
  }
  return { handle, park: (reason?: SuspensionReason) => { for (const listener of listeners) listener(reason === undefined ? {} : { reason }) } }
}

function trackerOver(store: ReturnType<typeof tempStore>, handle: ManagedChildHandle, forgotten: string[]) {
  return createOutcomeTracker({
    store,
    now: Date.now,
    liveHandle: (taskId) => (taskId === handle.task_id && !forgotten.includes(taskId) ? handle : undefined),
    tryLoad: (taskId) => store.load(taskId),
    runStatsSnapshot: () => undefined,
    releaseSlot: () => undefined,
    forget: (taskId) => forgotten.push(taskId),
    settleWaiters: () => undefined,
    tryRuntimeFallback: () => Promise.resolve(false),
  })
}

describe("a daemon child that parks itself parks its record", () => {
  test("#given a running child whose recorded host refused the reattach #when it parks host_incompatible #then the record is rpc_detached with that reason and the run is released", () => {
    // given
    const store = tempStore()
    const record = seedRecord(store, { ...hostSessionRecordInput("st_0e000001", hostSession("st_0e000001", { socket: SHARD })), status: "running", host_pid: 4_242 })
    const { handle, park } = parkingHandle(record.task_id)
    const forgotten: string[] = []
    trackerOver(store, handle, forgotten).trackOutcome(record.task_id, handle, record.model, record.notification.run_epoch)

    // when
    park("host_incompatible")

    // then
    const parked = store.load(record.task_id)
    expect(parked?.residency_state).toBe("rpc_detached")
    expect(parked?.suspension_reason).toBe("host_incompatible")
    expect(parked?.status).toBe("running")
    expect(parked?.host_pid).toBeUndefined()
    expect(parked?.host_session?.socket).toBe(SHARD)
    expect(forgotten).toEqual([record.task_id])
  })

  test("#given a session the HOST parked (no reason) #when the park arrives #then the record is left as it was", () => {
    // given
    const store = tempStore()
    const record = seedRecord(store, { ...hostSessionRecordInput("st_0e000002", hostSession("st_0e000002")), status: "running", host_pid: 4_242 })
    const { handle, park } = parkingHandle(record.task_id)
    const forgotten: string[] = []
    trackerOver(store, handle, forgotten).trackOutcome(record.task_id, handle, record.model, record.notification.run_epoch)

    // when
    park()

    // then
    expect(store.load(record.task_id)?.residency_state).toBe("resident")
    expect(forgotten).toEqual([])
  })
})

describe("respawn opens a daemon child on its RECORDED socket", () => {
  function respawnWith(socket: string, failure?: RunnerError) {
    const store = tempStore()
    const record = seedRecord(store, {
      ...hostSessionRecordInput("st_0e000003", hostSession("st_0e000003", { socket })),
      spawn_spec: { cwd: "/tmp" },
      status: "running",
    })
    const specs: RpcRunnerSpec[] = []
    const result = respawnManagedTask({
      beforeLaunch: () => undefined,
      record,
      sessionPath: record.host_session?.session_path,
      stateDir: store.stateDir,
      runners: { "in-process": { start: () => Promise.reject(new Error("unused")) }, process: { start: () => Promise.reject(new Error("unused")) } },
      rpcRunner: {
        start: (spec) => {
          specs.push(spec)
          return Promise.reject(failure ?? new Error("stop after the spec is seen"))
        },
      },
    })
    return { result, specs }
  }

  test("#given a pre-migration child on the legacy socket #when it is respawned #then the runner is handed that socket", async () => {
    // given / when
    const { result, specs } = respawnWith(LEGACY)
    await result

    // then
    expect(specs.map((spec) => spec.hostSocket)).toEqual([LEGACY])
  })

  for (const reason of ["store_index_unavailable", "host_incompatible"] as const) {
    test(`#given the runner refuses with ${reason} #when respawning #then the failure is a retryable ${reason}`, async () => {
      // given
      const failure = new RunnerError({ kind: "host_unavailable", reason, message: reason })

      // when
      const { result } = respawnWith(SHARD, failure)

      // then
      expect(await result).toMatchObject({ ok: false, disposition: "retryable", code: reason })
    })
  }
})
