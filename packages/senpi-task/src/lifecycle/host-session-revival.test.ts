import { afterEach, describe, expect, test } from "bun:test"

import type { RespawnResult } from "./port"
import { createTaskLifecycle } from "./create"
import { hostLifecycleDeps, hostSession, hostSessionRecordInput } from "./__fixtures__/host-session-fakes"
import { cleanupProjects, seedRecord, tempStore } from "./__fixtures__/lifecycle-fakes"

afterEach(cleanupProjects)

const HOST_PID = 4_242
const OK: RespawnResult = {
  ok: true,
  handle: {
    task_id: "st_0b000000",
    sessionId: "child",
    pid: undefined,
    steer: () => Promise.resolve(),
    followUp: () => Promise.resolve(),
    abort: () => Promise.resolve(),
    subscribe: () => () => undefined,
    waitForOutcome: () => Promise.resolve({ status: "completed", finalResponse: "done" }),
    lastAssistantText: () => undefined,
    dispose: () => Promise.resolve(),
  },
}

function draining(retryAfterMs?: number): RespawnResult {
  return {
    ok: false,
    disposition: "retryable",
    code: "host_draining",
    reason: "session_path_in_use",
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  }
}

describe("host-session revival: attach by session path, drain deferral, daemon-loss parking", () => {
  test("#given a live host session owned by another session #when reconciliation sweeps #then it is deferred without respawn", async () => {
    // given
    const store = tempStore()
    const identity = hostSession("st_0b000001")
    const fixture = hostLifecycleDeps({ store, hostPid: HOST_PID, respawn: () => Promise.resolve(OK) })
    fixture.daemon.hold(identity.session_path)
    seedRecord(store, {
      ...hostSessionRecordInput("st_0b000001", identity),
      parent_session_id: "other-session",
      status: "running",
      residency_state: "resident",
      host_pid: 9_999,
    })
    const lifecycle = createTaskLifecycle(fixture.deps)

    // when
    const result = await lifecycle.reconcileOnSessionStart("parent-1")

    // then
    expect(store.load("st_0b000001")?.status).not.toBe("lost")
    expect(result.outcomes).toContainEqual({
      task_id: "st_0b000001",
      kind: "deferred",
      reason: "foreign_live_owner",
    })
    expect(fixture.respawned).toEqual([])
  })

  test("#given a parked host-session child of this session #when session-start revival runs #then respawn resumes the recorded host session path", async () => {
    // given
    const store = tempStore()
    const identity = hostSession("st_0b000002")
    const fixture = hostLifecycleDeps({ store, hostPid: HOST_PID, respawn: () => Promise.resolve(OK) })
    seedRecord(store, {
      ...hostSessionRecordInput("st_0b000002", identity),
      status: "running",
      residency_state: "rpc_detached",
    })
    const lifecycle = createTaskLifecycle(fixture.deps)

    // when
    await lifecycle.reconcileOnSessionStart("parent-1")

    // then
    expect(fixture.respawned).toEqual([{ task_id: "st_0b000002", sessionPath: identity.session_path }])
    expect(store.load("st_0b000002")?.status).not.toBe("lost")
  })

  test("#given a draining old generation #when revival hits session_path_in_use twice #then it waits the advertised delay and attaches on the retry", async () => {
    // given
    const store = tempStore()
    const identity = hostSession("st_0b000003")
    let attempts = 0
    const fixture = hostLifecycleDeps({
      store,
      hostPid: HOST_PID,
      respawn: () => {
        attempts += 1
        return Promise.resolve(attempts <= 2 ? draining(50) : OK)
      },
    })
    seedRecord(store, {
      ...hostSessionRecordInput("st_0b000003", identity),
      status: "running",
      residency_state: "rpc_detached",
    })
    const lifecycle = createTaskLifecycle(fixture.deps)

    // when
    const result = await lifecycle.reconcileOnSessionStart("parent-1")

    // then
    expect(fixture.waits).toEqual([50, 50])
    expect(result.outcomes).toEqual([{ task_id: "st_0b000003", kind: "resumed", reason: "respawned and reattached" }])
    expect(store.load("st_0b000003")?.status).not.toBe("lost")
  })

  test("#given a generation that never finishes draining #when the attempt budget is exhausted #then the record is suspended with host_draining and never lost", async () => {
    // given
    const store = tempStore()
    const identity = hostSession("st_0b000004")
    const fixture = hostLifecycleDeps({
      store,
      hostPid: HOST_PID,
      maxDrainAttempts: 3,
      respawn: () => Promise.resolve(draining()),
    })
    seedRecord(store, {
      ...hostSessionRecordInput("st_0b000004", identity),
      status: "running",
      residency_state: "rpc_detached",
    })
    const lifecycle = createTaskLifecycle(fixture.deps)

    // when
    const result = await lifecycle.reconcileOnSessionStart("parent-1")

    // then
    expect(fixture.waits).toEqual([2_000, 2_000])
    expect(result.outcomes).toEqual([{ task_id: "st_0b000004", kind: "deferred", reason: "host_draining" }])
    const record = store.load("st_0b000004")
    expect(record?.status).not.toBe("lost")
    expect(record?.residency_state).toBe("rpc_detached")
    expect(record?.suspension_reason).toBe("host_draining")
  })

  test("#given a daemon that never comes back #when the child is parked on daemon loss #then the bounded reconcile runs 1s/4s/16s and the record stays rpc_detached", async () => {
    // given
    const store = tempStore()
    const signals: string[] = []
    const identity = hostSession("st_0b000005")
    const fixture = hostLifecycleDeps({ store, hostPid: HOST_PID, signals, respawn: () => Promise.resolve(OK) })
    fixture.daemon.alive = false
    seedRecord(store, {
      ...hostSessionRecordInput("st_0b000005", identity),
      status: "running",
      residency_state: "resident",
      host_pid: HOST_PID,
    })
    const lifecycle = createTaskLifecycle(fixture.deps)

    // when
    const outcome = await lifecycle.parkHostSessionOnDaemonLoss("st_0b000005")

    // then
    expect(fixture.waits).toEqual([1_000, 4_000, 16_000])
    expect(outcome).toEqual({ kind: "suspended", reason: "daemon_unavailable" })
    const record = store.load("st_0b000005")
    expect(record?.residency_state).toBe("rpc_detached")
    expect(record?.status).toBe("running")
    expect(record?.suspension_reason).toBe("daemon_unavailable")
    expect(signals).toEqual([])
  })

  test("#given a daemon that returns during the bounded reconcile #when the child was parked on daemon loss #then it is revived and no suspension reason survives", async () => {
    // given
    const store = tempStore()
    const identity = hostSession("st_0b000006")
    const fixture = hostLifecycleDeps({ store, hostPid: HOST_PID, respawn: () => Promise.resolve(OK) })
    fixture.daemon.alive = false
    seedRecord(store, {
      ...hostSessionRecordInput("st_0b000006", identity),
      status: "running",
      residency_state: "resident",
      host_pid: HOST_PID,
    })
    const lifecycle = createTaskLifecycle(fixture.deps)

    // when
    const outcome = await lifecycle.parkHostSessionOnDaemonLoss("st_0b000006", {
      beforeAttempt: (attempt) => {
        if (attempt === 2) fixture.daemon.alive = true
      },
    })

    // then
    expect(fixture.waits).toEqual([1_000, 4_000])
    expect(outcome).toEqual({ kind: "revived" })
    expect(fixture.respawned).toEqual([{ task_id: "st_0b000006", sessionPath: identity.session_path }])
    expect(store.load("st_0b000006")?.suspension_reason).toBeUndefined()
  })
})

describe("a deferred daemon-hosted child is retried in the background (omo#9069)", () => {
  test("#given a daemon that did not answer when the parent reconciled #when it answers again #then the child is revived without another session start", async () => {
    // given
    const store = tempStore()
    const identity = hostSession("st_0b000007")
    let revived!: () => void
    const done = new Promise<void>((resolve) => { revived = resolve })
    const fixture = hostLifecycleDeps({
      store,
      hostPid: HOST_PID,
      deferredRetryBackoffMs: [5_000, 15_000, 30_000],
      onWait: (ms) => {
        if (ms === 15_000) fixture.daemon.alive = true
      },
      respawn: () => {
        revived()
        return Promise.resolve(OK)
      },
    })
    fixture.daemon.alive = false
    seedRecord(store, { ...hostSessionRecordInput("st_0b000007", identity), status: "running", residency_state: "rpc_detached" })
    const lifecycle = createTaskLifecycle(fixture.deps)

    // when
    const result = await lifecycle.reconcileOnSessionStart("parent-1")
    await done

    // then
    expect(result.outcomes).toEqual([{ task_id: "st_0b000007", kind: "deferred", reason: "host_unreachable" }])
    expect(fixture.waits).toEqual([5_000, 15_000])
    expect(fixture.respawned).toEqual([{ task_id: "st_0b000007", sessionPath: identity.session_path }])
  })

  test("#given a deferred child that was cancelled meanwhile #when its retry wakes #then nothing is respawned", async () => {
    // given
    const store = tempStore()
    const identity = hostSession("st_0b000008")
    let woke!: () => void
    const waited = new Promise<void>((resolve) => { woke = resolve })
    const fixture = hostLifecycleDeps({
      store,
      hostPid: HOST_PID,
      deferredRetryBackoffMs: [5_000],
      onWait: () => {
        store.transition("st_0b000008", { type: "cancel", timestamp: new Date().toISOString() })
        fixture.daemon.alive = true
        woke()
      },
      respawn: () => Promise.resolve(OK),
    })
    fixture.daemon.alive = false
    seedRecord(store, { ...hostSessionRecordInput("st_0b000008", identity), status: "running", residency_state: "rpc_detached" })
    const lifecycle = createTaskLifecycle(fixture.deps)

    // when
    await lifecycle.reconcileOnSessionStart("parent-1")
    await waited
    await Bun.sleep(0)

    // then
    expect(fixture.respawned).toEqual([])
    expect(store.load("st_0b000008")?.status).toBe("cancelled")
  })
})
