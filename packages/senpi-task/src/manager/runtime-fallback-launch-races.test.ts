import { afterEach, describe, expect, test } from "bun:test"

import { createTaskRecordStore, type TaskRecordStore } from "../store"
import type { ManagedChildHandle } from "./child-handle"
import { createTaskManager } from "./manager"
import type { ManagedRunner, ManagedStartSpec, ResolvedChildPlan } from "./types"
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

function managerOver(store: TaskRecordStore, runner: ManagedRunner, project: string, destroy: (taskId: string, cause: string) => Promise<void> = async () => {}) {
  return createTaskManager({
    store,
    runners: { "in-process": runner, process: runner },
    planner: () => ({ kind: "resolved", plan }),
    config: settings({ default_concurrency: 2, max_depth: 1 }),
    cwd: project,
    destruction: { destroyResidentTask: destroy },
  })
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
  test("#given the failed rung's teardown rejects #when the handoff was committed #then the task ends in error, is released, and no next rung starts", async () => {
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
      if (cause === "fallback_handoff") throw new Error("dispose rejected")
    })
    const started = await manager.start(baseSpec())
    if (started.kind !== "started" || first === undefined) throw new Error("setup failed")

    const terminal = manager.waitFor(started.task_id)
    first.settle({ status: "error", failure: { kind: "child-turn-failed", message: "500: upstream overloaded" } })
    const ended = await terminal

    expect(ended.status).toBe("error")
    expect(ended.error_message).toContain("dispose rejected")
    expect(ended.fallback_handoff_epoch).toBeUndefined()
    expect(starts).toEqual([PRIMARY])
    expect(manager.getResidentHandle(started.task_id)).toBeUndefined()
    const other = await manager.start(baseSpec({ name: "after" }))
    expect(other).toMatchObject({ kind: "started", status: "running" })
    manager.workpools.dispose()
  })
})
