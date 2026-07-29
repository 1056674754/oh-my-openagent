import { afterEach, describe, expect, test } from "bun:test"

import { baseSpec, cleanupProjects, makeManager } from "./__fixtures__/manager-fakes"

afterEach(() => {
  cleanupProjects()
})

describe("TaskManager runtime fallback visibility", () => {
  test("#given a running category child #when Senpi applies a fallback #then the task record exposes the actual model", async () => {
    // given
    const { manager, store, inProcess } = makeManager({
      planner: () => ({
        kind: "resolved",
        plan: {
          model: "apitopia/kimi-for-coding-highspeed-unlocked",
          category: "quick",
          resolved_model: {
            source: "category",
            provider: "apitopia",
            model_id: "kimi-for-coding-highspeed-unlocked",
            display: "apitopia/kimi-for-coding-highspeed-unlocked",
            reasoning_effort: "minimal",
          },
        },
      }),
    })
    const started = await manager.start(baseSpec())
    if (started.kind !== "started") throw new Error(`Unexpected start result: ${started.kind}`)
    const fake = inProcess.handles.get(started.task_id)
    if (fake === undefined) throw new Error("Fake child handle missing")
    const fallbackEvent = {
      type: "retry_fallback_applied",
      from: "apitopia/kimi-for-coding-highspeed-unlocked",
      to: "quotio-openai/gpt-5.4-mini-fast:minimal",
      chainKey: "apitopia/kimi-for-coding-highspeed-unlocked",
      reason: "hard-error",
    }

    // when
    fake.emit(fallbackEvent)

    // then
    expect(store.load(started.task_id)).toMatchObject({
      model: "quotio-openai/gpt-5.4-mini-fast",
      resolved_model: {
        source: "category",
        provider: "quotio-openai",
        model_id: "gpt-5.4-mini-fast",
        display: "quotio-openai/gpt-5.4-mini-fast",
        reasoning_effort: "minimal",
      },
    })
    fake.settle({ status: "completed", finalResponse: "done" })
    await manager.waitFor(started.task_id)
  })
})
