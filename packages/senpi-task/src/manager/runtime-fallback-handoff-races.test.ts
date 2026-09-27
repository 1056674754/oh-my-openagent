import { afterEach, describe, expect, test } from "bun:test"

import { createManagerResidencyRegistry } from "../../../omo-senpi/src/components/task/residency-registry"
import { createTaskLifecycle } from "../lifecycle/create"
import type { ResolvedModelRecord, TaskRecord } from "../state"
import { createTaskRecordStore, type TaskRecordStore } from "../store"
import type { ManagedChildHandle } from "./child-handle"
import { TaskConcurrency } from "./concurrency"
import { baseSpec, cleanupProjects, FakeRunner, settings, tempProject } from "./__fixtures__/manager-fakes"
import { createTaskManager } from "./manager"
import type { ManagedStartSpec } from "./types"

// The runtime-fallback handoff is committed before the failed rung's session finishes closing. Every
// way that window can end - another owner winning the handoff, an interrupt, a cancel - must leave
// no lease and no handle behind, or a lane at concurrency one never admits another task.

afterEach(cleanupProjects)

const FIRST = "test/first"
const NEXT = "test/next"
const OWNER_PID = 11_001

function rung(id: string): ResolvedModelRecord {
  return { source: "category", provider: "test", model_id: id, display: `test/${id}` }
}

class SlowCloseRunner extends FakeRunner {
  readonly closing = Promise.withResolvers<void>()
  readonly finishClose = Promise.withResolvers<void>()

  override async start(spec: ManagedStartSpec): Promise<ManagedChildHandle> {
    const handle = await super.start(spec)
    const hostSession = { socket: "/tmp/dh-fake/rpc.sock", routingId: `routing-${spec.model}`, sessionPath: `/tmp/dh-fake/${spec.taskId}.jsonl`, instanceId: "fake" }
    return Object.assign(handle, {
      kind: "host-session" as const,
      hostSession,
      dispose: async () => {
        if (spec.model !== FIRST) return
        this.closing.resolve()
        await this.finishClose.promise
      },
    })
  }
}

type MutateHook = (taskId: string, change: (record: TaskRecord) => TaskRecord, mutate: TaskRecordStore["mutate"]) => TaskRecord | null

// Every store call goes to the real store; `mutate` can be intercepted to interleave another owner.
function interceptableStore(base: TaskRecordStore, hook: { current?: MutateHook }): TaskRecordStore {
  return new Proxy(base, {
    get(target, property) {
      if (property === "mutate") {
        return (taskId: string, change: (record: TaskRecord) => TaskRecord) =>
          hook.current === undefined ? target.mutate(taskId, change) : hook.current(taskId, change, target.mutate)
      }
      const value: unknown = Reflect.get(target, property, target)
      return typeof value === "function" ? value.bind(target) : value
    },
  })
}

function lane() {
  const runner = new SlowCloseRunner()
  const mutateHook: { current?: MutateHook } = {}
  const store = interceptableStore(createTaskRecordStore({ project_dir: tempProject() }), mutateHook)
  const config = settings({ default_execution_mode: "process", default_concurrency: 1, global_concurrency: 1 })
  const concurrency = new TaskConcurrency(config)
  const manager = createTaskManager({
    store,
    config,
    concurrency,
    cwd: "/tmp",
    hostPid: OWNER_PID,
    runners: { process: runner, "in-process": runner },
    planner: (spec) => ({
      kind: "resolved",
      plan: spec.name === "fallback"
        ? { model: FIRST, requested_model: rung("first"), resolved_model: rung("first"), fallback_models: [rung("next")] }
        : { model: FIRST },
    }),
    destruction: { destroyResidentTask: (taskId, cause) => lifecycle.destroyResidentTask(taskId, cause) },
  })
  const lifecycle = createTaskLifecycle({ store, config, hostPid: OWNER_PID, registry: createManagerResidencyRegistry(() => manager) })
  const dispose = (): void => {
    runner.finishClose.resolve()
    lifecycle.dispose?.()
    manager.workpools.dispose()
    for (const taskId of manager.residentTaskIds()) manager.forget(taskId)
  }
  return { runner, store, mutateHook, concurrency, manager, dispose }
}

describe("runtime fallback handoff races", () => {
  test("#given another owner takes the task at its epoch #when the handoff loses the fence #then this process lets go of its run and its lease", async () => {
    // given
    const f = lane()
    const task = await f.manager.start(baseSpec({ name: "fallback", execution_mode: "process" }))
    if (task.kind !== "started") throw new Error("expected the task to start")
    const displaced = Promise.withResolvers<void>()
    f.mutateHook.current = (taskId, change, mutate) => {
      if (taskId !== task.task_id) return mutate(taskId, change)
      f.mutateHook.current = undefined
      mutate(taskId, (record) => ({ ...record, host_pid: OWNER_PID + 1, notification: { ...record.notification, run_epoch: record.notification.run_epoch + 1 } }))
      const result = mutate(taskId, change)
      displaced.resolve()
      return result
    }

    try {
      // when
      f.runner.handles.get(task.task_id)?.settle({ status: "error", failure: { kind: "child-turn-failed", message: "500: upstream overloaded" } })
      await displaced.promise
      const following = await f.manager.start(baseSpec({ name: "following", execution_mode: "process" }))

      // then
      expect(f.store.load(task.task_id)?.host_pid).toBe(OWNER_PID + 1)
      expect(f.concurrency.leaseState(task.task_id, 0)).toBeUndefined()
      expect(f.manager.getResidentHandle(task.task_id)).toBeUndefined()
      expect(following.kind === "started" ? f.store.load(following.task_id)?.status : following.kind).toBe("running")
      expect(f.runner.startedSpecs.filter((spec) => spec.model === NEXT)).toEqual([])
    } finally {
      f.dispose()
    }
  })

  for (const ending of ["interrupt", "cancel"] as const) {
    test(`#given the failed rung is still closing #when the task is ${ending === "interrupt" ? "interrupted" : "cancelled"} #then no lease is stranded and no next rung launches`, async () => {
      // given
      const f = lane()
      const task = await f.manager.start(baseSpec({ name: "fallback", execution_mode: "process" }))
      if (task.kind !== "started") throw new Error("expected the task to start")
      const first = f.runner.handles.get(task.task_id)
      if (first === undefined) throw new Error("expected the first rung's handle")
      const unsubscribed = first.waitForUnsubscription()

      try {
        // when
        first.settle({ status: "error", failure: { kind: "child-turn-failed", message: "500: upstream overloaded" } })
        await f.runner.closing.promise
        const ended = ending === "interrupt" ? f.manager.interruptTask(task.task_id) : f.manager.cancelTask(task.task_id)
        f.runner.finishClose.resolve()
        expect((await ended).kind).toBe(ending === "interrupt" ? "interrupted" : "cancelled")
        await unsubscribed
        const following = await f.manager.start(baseSpec({ name: "following", execution_mode: "process" }))

        // then
        expect(f.concurrency.leaseState(task.task_id, 0)).toBeUndefined()
        expect(f.concurrency.leaseState(task.task_id, 1)).toBeUndefined()
        expect(f.runner.startedSpecs.filter((spec) => spec.model === NEXT)).toEqual([])
        expect(following.kind === "started" ? f.store.load(following.task_id)?.status : following.kind).toBe("running")
      } finally {
        f.dispose()
      }
    })
  }
})
