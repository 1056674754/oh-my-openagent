import { afterEach, describe, expect, test } from "bun:test"
import type { HandleRef, HandleSnapshot, HandleWatch } from "@code-yeongyu/senpi"

import type { ManagedChildHandle } from "../manager/child-handle"
import { FakeRunner, baseSpec, cleanupProjects, flush, makeManager } from "../manager/__fixtures__/manager-fakes"
import type { ManagedStartSpec } from "../manager/types"
import { createEvalHandleHost } from "./host"

afterEach(cleanupProjects)

const OWNER = { ownerSessionId: "parent-1" }
const NO_POOLS = {
  inspect: () => { throw new Error("no pools in this test") },
  cancel: () => { throw new Error("no pools in this test") },
  subscribe: () => () => undefined,
}

async function harness() {
  const inProcess = new FakeRunner()
  const { manager, store } = makeManager({ inProcess })
  const host = createEvalHandleHost({ tasks: manager, workpools: NO_POOLS, poolCaller: (sessionId) => ({ sessionId, rootSessionId: sessionId, depth: 0, cwd: "/" }), stateDir: store.stateDir })
  const started = await manager.start(baseSpec())
  if (started.kind !== "started") throw new Error("expected a started child")
  const ref: HandleRef = { kind: "agent", id: started.task_id, run_epoch: 0 }
  const settle = async (finalResponse: string): Promise<void> => {
    inProcess.handles.get(started.task_id)?.settle({ status: "completed", finalResponse })
    await flush()
  }
  return { host, manager, store, ref, settle }
}

class StartObservingRunner extends FakeRunner {
  readonly #waiters: Array<() => void> = []

  override start(spec: ManagedStartSpec): Promise<ManagedChildHandle> {
    const started = super.start(spec)
    this.#waiters.shift()?.()
    return started
  }

  nextStart(): Promise<void> {
    return new Promise((resolve) => { this.#waiters.push(resolve) })
  }
}

function fallbackPlanner() {
  const model = (provider: string, id: string) => ({ source: "category" as const, provider, model_id: id, display: `${provider}/${id}` })
  return () => ({
    kind: "resolved" as const,
    plan: { model: "vendor-a/primary", requested_model: model("vendor-a", "primary"), resolved_model: model("vendor-a", "primary"), fallback_models: [model("vendor-b", "next")], category: "quick" },
  })
}

async function drain(watch: HandleWatch): Promise<HandleSnapshot[]> {
  const seen: HandleSnapshot[] = []
  for await (const snapshot of watch.updates) seen.push(snapshot)
  return seen
}

describe("EvalHandleHost over real task children", () => {
  test("a watched agent run that finishes arrives exactly once and its result is the task's final text", async () => {
    const { host, ref, settle } = await harness()
    const watch = await host.watch([ref], OWNER)
    expect(watch.initial.map((s) => s.phase)).toEqual(["pending"])

    const updates = drain(watch)
    await settle("both values")
    watch.close()

    expect((await updates).map((s) => [s.phase, s.ref.run_epoch])).toEqual([["succeeded", 0]])
    expect(await host.result(ref, OWNER)).toEqual({ status: "fulfilled", ref, value: "both values" })
  })

  test("two agent runs finishing out of order are each reported once and their results come back in the caller's order", async () => {
    const inProcess = new FakeRunner()
    const { manager, store } = makeManager({ inProcess })
    const host = createEvalHandleHost({ tasks: manager, workpools: NO_POOLS, poolCaller: (sessionId) => ({ sessionId, rootSessionId: sessionId, depth: 0, cwd: "/" }), stateDir: store.stateDir })
    const a = await manager.start(baseSpec())
    const b = await manager.start(baseSpec())
    if (a.kind !== "started" || b.kind !== "started") throw new Error("expected two started children")
    const refs: HandleRef[] = [{ kind: "agent", id: a.task_id, run_epoch: 0 }, { kind: "agent", id: b.task_id, run_epoch: 0 }]
    const watch = await host.watch(refs, OWNER)
    const updates = drain(watch)

    inProcess.handles.get(b.task_id)?.settle({ status: "completed", finalResponse: "value b" })
    await flush()
    inProcess.handles.get(a.task_id)?.settle({ status: "completed", finalResponse: "value a" })
    await flush()
    watch.close()

    expect((await updates).map((s) => s.ref.id)).toEqual([b.task_id, a.task_id])
    const values = await Promise.all(refs.map(async (ref) => (await host.result(ref, OWNER)) as { value: unknown }))
    expect(values.map((outcome) => outcome.value)).toEqual(["value a", "value b"])
  })

  test("a run that already finished before the watch shows up once, in initial, with no update", async () => {
    const { host, ref, settle } = await harness()
    await settle("done early")

    const watch = await host.watch([ref], OWNER)
    const updates = drain(watch)
    watch.close()

    expect(watch.initial.map((s) => s.phase)).toEqual(["succeeded"])
    expect(await updates).toEqual([])
  })

  test("a runtime model fallback moves the epoch inside the same run: the handle stays live and the fallback's result arrives", async () => {
    const runner = new StartObservingRunner()
    const { manager, store } = makeManager({ inProcess: runner, planner: fallbackPlanner() })
    const host = createEvalHandleHost({ tasks: manager, workpools: NO_POOLS, poolCaller: (sessionId) => ({ sessionId, rootSessionId: sessionId, depth: 0, cwd: "/" }), stateDir: store.stateDir })
    const firstStart = runner.nextStart()
    const started = await manager.start(baseSpec({ execution_mode: "in-process" }))
    if (started.kind !== "started") throw new Error("expected a started child")
    await firstStart
    const ref: HandleRef = { kind: "agent", id: started.task_id, run_epoch: 0 }
    const watch = await host.watch([ref], OWNER)
    const updates = drain(watch)

    const fallbackStart = runner.nextStart()
    runner.handles.get(started.task_id)?.settle({ status: "error", failure: { kind: "child-turn-failed", message: "provider capacity exhausted" } })
    await fallbackStart
    expect(store.load(started.task_id)?.notification.run_epoch).toBeGreaterThan(0)
    expect(await host.cancel(ref, OWNER)).toMatchObject({ cancelled: true, phase: "cancelled" })

    watch.close()
    expect((await updates).map((s) => s.phase)).toEqual(["cancelled"])
  })

  test("a send to a finished agent revives it as a new run: the caller gets the new ref, told so, and the old ref goes stale", async () => {
    const { host, ref, settle } = await harness()
    await settle("first pass")

    const revived = await host.send(ref, "second pass", OWNER)

    expect(revived.ref.run_epoch).toBe(1)
    expect(revived.host_status).toBe("revived as epoch 1")
    expect(revived.phase).toBe("pending")
    await expect(host.result(ref, OWNER)).rejects.toMatchObject({ code: "eval_handle_stale" })
    const watch = await host.watch([revived.ref], OWNER)
    const updates = drain(watch)
    await settle("second result")
    watch.close()
    expect((await updates).map((s) => [s.phase, s.ref.run_epoch])).toEqual([["succeeded", 1]])
    expect(await host.result(revived.ref, OWNER)).toMatchObject({ status: "fulfilled", value: "second result" })
  })

  test("cancelling a stale handle is refused and the successor run keeps running", async () => {
    const { host, store, ref, settle } = await harness()
    await settle("first pass")
    await host.send(ref, "second pass", OWNER)

    await expect(host.cancel(ref, OWNER)).rejects.toMatchObject({ code: "eval_handle_stale" })

    expect(store.load(ref.id)?.status).toBe("running")
  })

  test("a revive landing between the handle's check and the cancel is caught inside the task engine", async () => {
    const { host, manager, store, ref, settle } = await harness()
    await settle("first pass")
    const racing = createEvalHandleHost({
      tasks: {
        get: (id) => manager.get(id),
        waitFor: (id, options) => manager.waitFor(id, options),
        sendToTask: (input) => manager.sendToTask(input),
        cancelTask: async (id, reason, options) => {
          await manager.sendToTask({ idOrName: id, message: "revived in the gap", callerSessionId: OWNER.ownerSessionId })
          return manager.cancelTask(id, reason, options)
        },
      },
      workpools: NO_POOLS,
      poolCaller: (sessionId) => ({ sessionId, rootSessionId: sessionId, depth: 0, cwd: "/" }),
      stateDir: store.stateDir,
    })

    await expect(racing.cancel(ref, OWNER)).rejects.toMatchObject({ code: "eval_handle_stale" })
    expect(host).toBeDefined()
    expect(store.load(ref.id)?.status).toBe("running")
  })

  test("the cancel transition itself refuses a run that moved after the caller read it, under the record lock", async () => {
    const { host, store, ref, settle } = await harness()
    await settle("first pass")
    await host.send(ref, "second pass", OWNER)

    const result = store.transition(ref.id, { type: "cancel", timestamp: new Date().toISOString(), expected_run_epoch: ref.run_epoch })

    expect(result.applied).toBe(false)
    expect(result.audit).toEqual({ type: "epoch_mismatch_ignored", expected_run_epoch: 0, run_epoch: 1 })
    expect(store.load(ref.id)?.status).toBe("running")
  })

  test("cancelling a live run cancels it; cancelling it again reports it already ended", async () => {
    const { host, store, ref } = await harness()

    expect(await host.cancel(ref, OWNER)).toMatchObject({ cancelled: true, phase: "cancelled" })
    expect(store.load(ref.id)?.status).toBe("cancelled")
    expect(await host.cancel(ref, OWNER)).toMatchObject({ cancelled: false, phase: "cancelled" })
  })

  test("a handle from before the upgrade whose task moved epoch is stale and says to re-fetch it", async () => {
    const { host, store, ref } = await harness()
    store.mutate(ref.id, (record) => {
      const { run_start_epoch: _legacy, ...rest } = record
      return { ...rest, notification: { ...record.notification, run_epoch: 1 } }
    })

    await expect(host.result(ref, OWNER)).rejects.toThrow(/handle from before the upgrade.*re-fetch it/)
  })

  test("another session's task is forbidden and an unknown task is not found", async () => {
    const { host, ref } = await harness()

    await expect(host.watch([ref], { ownerSessionId: "someone-else" })).rejects.toMatchObject({ code: "eval_handle_forbidden" })
    await expect(host.result({ ...ref, id: "st_0000000000000000000000000" }, OWNER)).rejects.toMatchObject({ code: "eval_handle_not_found" })
  })

  test("a resume during an output read yields eval_handle_stale, never the successor's transcript", async () => {
    const { manager, store, ref, settle } = await harness()
    await settle("first pass")
    const host = createEvalHandleHost({
      tasks: manager,
      workpools: NO_POOLS,
      poolCaller: (sessionId) => ({ sessionId, rootSessionId: sessionId, depth: 0, cwd: "/" }),
      stateDir: store.stateDir,
      transcriptReader: () => {
        store.mutate(ref.id, (record) => ({ ...record, status: "running", run_start_epoch: 1, notification: { ...record.notification, run_epoch: 1 } }))
        return { entries: [{ kind: "assistant", text: "successor text" }], source: "event-log" }
      },
    })

    await expect(host.output(ref, { format: "raw" }, OWNER)).rejects.toMatchObject({ code: "eval_handle_stale" })
  })

  test("watching a run never touches its completion notification bookkeeping", async () => {
    const { host, store, ref, settle } = await harness()
    const watch = await host.watch([ref], OWNER)
    const updates = drain(watch)
    const before = store.load(ref.id)?.notification.notified_epoch
    await settle("done")
    watch.close()
    await updates

    expect(store.load(ref.id)?.notification.notified_epoch).toBe(before)
  })
})
