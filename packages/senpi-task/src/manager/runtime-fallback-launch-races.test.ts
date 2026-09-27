import { afterEach, describe, expect, test } from "bun:test"

import { createManagerResidencyRegistry } from "../../../omo-senpi/src/components/task/residency-registry"
import { createTaskLifecycle } from "../lifecycle/create"
import { createTaskRecordStore, type TaskRecordStore } from "../store"
import type { ManagedChildHandle } from "./child-handle"
import { createTaskManager } from "./manager"
import type { ManagedRunner, ManagedStartSpec, ResolvedChildPlan, TaskManager } from "./types"
import { baseSpec, cleanupProjects, makeHandle, settings, tempProject } from "./__fixtures__/manager-fakes"

afterEach(cleanupProjects)

const PRIMARY = "vendor/primary"
const NEXT = "vendor/next"
const plan: ResolvedChildPlan = {
  model: PRIMARY,
  requested_model: { source: "category", provider: "vendor", model_id: "primary", display: PRIMARY },
  resolved_model: { source: "category", provider: "vendor", model_id: "primary", display: PRIMARY },
  fallback_models: [{ source: "category", provider: "vendor", model_id: "next", display: NEXT }],
}

/** The first start returns at once; the second (the next rung) waits until the test releases it. */
class HeldSecondStart implements ManagedRunner {
  readonly entered = Promise.withResolvers<void>()
  readonly release = Promise.withResolvers<void>()
  readonly disposed = Promise.withResolvers<void>()
  first: ReturnType<typeof makeHandle> | undefined
  second: ReturnType<typeof makeHandle> | undefined
  calls = 0

  async start(spec: ManagedStartSpec): Promise<ManagedChildHandle> {
    this.calls += 1
    if (this.calls === 1) {
      this.first = makeHandle(spec.taskId)
      return this.first.handle
    }
    this.entered.resolve()
    await this.release.promise
    this.second = makeHandle(spec.taskId)
    const handle = this.second.handle
    return {
      ...handle,
      dispose: async () => {
        await handle.dispose()
        this.disposed.resolve()
      },
    }
  }
}

/** Tears a registered child down and forgets it, as the lifecycle's destruction port does. */
function managerOver(store: TaskRecordStore, runner: ManagedRunner, project: string, destroy?: (taskId: string, cause: string) => Promise<void>) {
  let manager: TaskManager | undefined
  const built = createTaskManager({
    store,
    runners: { "in-process": runner, process: runner },
    planner: () => ({ kind: "resolved", plan }),
    config: settings({ default_concurrency: 2, max_depth: 1 }),
    cwd: project,
    destruction: {
      destroyResidentTask: destroy ?? (async (taskId) => {
        const handle = manager?.getResidentHandle(taskId)
        manager?.forget(taskId)
        await handle?.dispose()
      }),
    },
  })
  manager = built
  return built
}

describe("runtime fallback: the next rung's start races a user stop", () => {
  for (const stop of ["cancel", "interrupt"] as const) {
    test(`#given the next rung's start is in flight #when the task is ${stop === "cancel" ? "cancelled" : "interrupted"} #then the late child is discarded and never becomes resident`, async () => {
      const project = tempProject()
      const store = createTaskRecordStore({ project_dir: project })
      const runner = new HeldSecondStart()
      const manager = managerOver(store, runner, project)
      const started = await manager.start(baseSpec())
      if (started.kind !== "started" || runner.first === undefined) throw new Error("setup failed")
      runner.first.settle({ status: "error", failure: { kind: "child-turn-failed", message: "500: upstream overloaded" } })
      await runner.entered.promise

      const stopped = stop === "cancel" ? await manager.cancelTask(started.task_id) : await manager.interruptTask(started.task_id)
      expect(stopped.kind).toBe(stop === "cancel" ? "cancelled" : "interrupted")

      runner.release.resolve()
      await runner.disposed.promise

      expect(manager.getResidentHandle(started.task_id)).toBeUndefined()
      expect(store.load(started.task_id)?.status).toBe(stop === "cancel" ? "cancelled" : "interrupted")
      manager.workpools.dispose()
    })
  }
})

describe("runtime fallback: the failed rung's teardown rejects", () => {
  for (const [label, rejection] of [["an Error", new Error("dispose rejected")], ["undefined", undefined], ["a string", "dispose rejected"]] as const) test(`#given the failed rung's teardown rejects with ${label} #when the handoff was committed #then the task ends in error, is released, and no next rung starts`, async () => {
    const project = tempProject()
    const store = createTaskRecordStore({ project_dir: project })
    const starts: string[] = []
    let first: ReturnType<typeof makeHandle> | undefined
    const runner: ManagedRunner = {
      start: async (spec) => {
        starts.push(spec.model ?? "")
        first = makeHandle(spec.taskId)
        return first.handle
      },
    }
    const manager = managerOver(store, runner, project, async (_taskId, cause) => {
      if (cause === "fallback_handoff") return Promise.reject(rejection)
    })
    const started = await manager.start(baseSpec())
    if (started.kind !== "started" || first === undefined) throw new Error("setup failed")

    const terminal = manager.waitFor(started.task_id)
    first.settle({ status: "error", failure: { kind: "child-turn-failed", message: "500: upstream overloaded" } })
    const ended = await terminal

    expect(ended.status).toBe("error")
    expect(ended.error_message).toContain(rejection === undefined ? "was not started" : "dispose rejected")
    expect(ended.fallback_handoff_epoch).toBeUndefined()
    expect(starts).toEqual([PRIMARY])
    expect(manager.getResidentHandle(started.task_id)).toBeUndefined()
    const other = await manager.start(baseSpec({ name: "after" }))
    expect(other).toMatchObject({ kind: "started", status: "running" })
    manager.workpools.dispose()
  })

  test("#given a cancel lands while the stranded handoff is being failed #when the failure is written #then the cancel is kept", async () => {
    const project = tempProject()
    const backing = createTaskRecordStore({ project_dir: project })
    let injectCancel = false
    const cancelNow = (taskId: string): void => {
      if (!injectCancel) return
      injectCancel = false
      backing.transition(taskId, { type: "cancel", timestamp: "2026-09-27T00:00:00.000Z" })
    }
    // The first store access after the teardown rejects races a user cancel: a read returns the
    // snapshot taken before the cancel, a write lands after it.
    const store: TaskRecordStore = {
      ...backing,
      load(taskId) {
        const observed = backing.load(taskId)
        cancelNow(taskId)
        return observed
      },
      mutate(taskId, update) {
        cancelNow(taskId)
        return backing.mutate(taskId, update)
      },
      replace(record) {
        cancelNow(record.task_id)
        return backing.replace(record)
      },
    }
    let first: ReturnType<typeof makeHandle> | undefined
    const runner: ManagedRunner = {
      start: async (spec) => {
        first = makeHandle(spec.taskId)
        return first.handle
      },
    }
    const manager = managerOver(store, runner, project, async (_taskId, cause) => {
      if (cause !== "fallback_handoff") return
      injectCancel = true
      throw new Error("dispose rejected")
    })
    const started = await manager.start(baseSpec())
    if (started.kind !== "started" || first === undefined) throw new Error("setup failed")

    const terminal = manager.waitFor(started.task_id)
    first.settle({ status: "error", failure: { kind: "child-turn-failed", message: "500: upstream overloaded" } })

    expect((await terminal).status).toBe("cancelled")
    expect(backing.load(started.task_id)?.status).toBe("cancelled")
    manager.workpools.dispose()
  })
})

const HOST_PID = 21_001

/** A manager over the REAL destruction port, so a child whose cleanup failed must reach the orphan path. */
function managerWithLifecycle(store: TaskRecordStore, runner: ManagedRunner, project: string, alive: Set<number>) {
  const terminated = Promise.withResolvers<number>()
  const signals: string[] = []
  let manager: TaskManager | undefined
  const lifecycle = createTaskLifecycle({
    store,
    config: settings({ default_concurrency: 2, max_depth: 1 }),
    hostPid: HOST_PID,
    registry: createManagerResidencyRegistry(() => {
      if (manager === undefined) throw new Error("manager not built")
      return manager
    }),
    orphanKillDelayMs: 0,
    signaller: {
      isAlive: (pid) => alive.has(pid),
      signal: (pid, signal) => {
        signals.push(`${signal}:${pid}`)
        alive.delete(pid)
        terminated.resolve(pid)
      },
    },
  })
  const built = createTaskManager({
    store,
    runners: { "in-process": runner, process: runner },
    planner: () => ({ kind: "resolved", plan }),
    config: settings({ default_concurrency: 2, max_depth: 1 }),
    cwd: project,
    hostPid: HOST_PID,
    destruction: { destroyResidentTask: (taskId, cause) => lifecycle.destroyResidentTask(taskId, cause) },
  })
  manager = built
  return { manager: built, signals, terminated: terminated.promise }
}

/** A per-process child whose terminate and dispose both reject: it stays alive until signalled. */
function stubbornChild(taskId: string, pid: number, disposed?: () => void): ManagedChildHandle {
  const { handle } = makeHandle(taskId, pid)
  return {
    ...handle,
    kind: "rpc",
    terminate: async () => { throw new Error("terminate rejected") },
    dispose: async () => {
      disposed?.()
      throw new Error("dispose rejected")
    },
  }
}

describe("runtime fallback: a child whose cleanup rejects is handed to orphan termination", () => {
  test("#given a stale next-rung child whose discard rejects #when the task was cancelled mid-start #then its pid is recorded and the orphan path signals it", async () => {
    const project = tempProject()
    const store = createTaskRecordStore({ project_dir: project })
    const alive = new Set([2_222])
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let first: ReturnType<typeof makeHandle> | undefined
    const runner: ManagedRunner = {
      start: async (spec) => {
        if (first === undefined) {
          first = makeHandle(spec.taskId, 1_111)
          return Object.assign(first.handle, { kind: "rpc" as const, terminate: async () => {} })
        }
        entered.resolve()
        await release.promise
        return stubbornChild(spec.taskId, 2_222)
      },
    }
    const { manager, signals, terminated } = managerWithLifecycle(store, runner, project, alive)
    const started = await manager.start(baseSpec({ execution_mode: "process" }))
    if (started.kind !== "started" || first === undefined) throw new Error("setup failed")
    first.settle({ status: "error", failure: { kind: "child-turn-failed", message: "500: upstream overloaded" } })
    await entered.promise
    expect((await manager.cancelTask(started.task_id)).kind).toBe("cancelled")

    release.resolve()

    expect(await terminated).toBe(2_222)
    expect(signals[0]).toBe("SIGTERM:2222")
    expect(store.load(started.task_id)).toMatchObject({ status: "cancelled", pid: 2_222 })
    expect(manager.getResidentHandle(started.task_id)).toBeUndefined()
    manager.workpools.dispose()
  })

  test("#given the failed rung's teardown rejects and its child stays alive #when the task is failed #then the failed rung's pid is restored and the orphan path signals it", async () => {
    const project = tempProject()
    const store = createTaskRecordStore({ project_dir: project })
    const alive = new Set([3_333])
    const starts: string[] = []
    let first: ReturnType<typeof makeHandle> | undefined
    const runner: ManagedRunner = {
      start: async (spec) => {
        starts.push(spec.model ?? "")
        first = makeHandle(spec.taskId, 3_333)
        return Object.assign(first.handle, stubbornChild(spec.taskId, 3_333), { waitForOutcome: first.handle.waitForOutcome, subscribe: first.handle.subscribe })
      },
    }
    const { manager, signals, terminated } = managerWithLifecycle(store, runner, project, alive)
    const started = await manager.start(baseSpec({ execution_mode: "process" }))
    if (started.kind !== "started" || first === undefined) throw new Error("setup failed")

    const ended = manager.waitFor(started.task_id)
    first.settle({ status: "error", failure: { kind: "child-turn-failed", message: "500: upstream overloaded" } })

    expect((await ended).status).toBe("error")
    expect(await terminated).toBe(3_333)
    expect(signals[0]).toBe("SIGTERM:3333")
    expect(store.load(started.task_id)).toMatchObject({ status: "error", pid: 3_333 })
    expect(store.load(started.task_id)?.fallback_handoff_epoch).toBeUndefined()
    expect(starts).toEqual([PRIMARY])
    manager.workpools.dispose()
  })
})
