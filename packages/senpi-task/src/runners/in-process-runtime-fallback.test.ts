import { describe, expect, test } from "bun:test"

import type { CreateAgentSessionOptions } from "@code-yeongyu/senpi"

import { InProcessRunner } from "./in-process"
import type { ChildSession, ChildSpec } from "./in-process"

function completedSession(): ChildSession {
  return {
    sessionId: "runtime-fallback-child",
    prompt: () => Promise.resolve(),
    steer: () => Promise.resolve(),
    followUp: () => Promise.resolve(),
    abort: () => Promise.resolve(),
    subscribe: () => () => {},
    getLastAssistantText: () => "done",
    dispose: () => {},
  }
}

function baseSpec(): ChildSpec {
  return {
    taskId: "task-runtime-fallback",
    cwd: process.cwd(),
    depth: 0,
    parentSessionId: "parent-1",
    rootSessionId: "root-1",
    prompt: "do the work",
  }
}

function capturedRetrySettings(options: CreateAgentSessionOptions | undefined): unknown {
  if (options === undefined) return undefined
  const settingsManager = Reflect.get(options, "settingsManager")
  if (typeof settingsManager !== "object" || settingsManager === null) return undefined
  const getRetryFallbackSettings = Reflect.get(settingsManager, "getRetryFallbackSettings")
  return typeof getRetryFallbackSettings === "function"
    ? Reflect.apply(getRetryFallbackSettings, settingsManager, [])
    : undefined
}

describe("InProcessRunner runtime fallback", () => {
  test("#given a selected model and ordered fallbacks #when the child session is created #then child-local runtime fallback settings preserve the chain", async () => {
    // given
    let captured: CreateAgentSessionOptions | undefined
    const runner = new InProcessRunner({
      createSession: async (options) => {
        captured = options
        return completedSession()
      },
    })
    const fallbackModels = [
      {
        source: "category",
        provider: "quotio-openai",
        model_id: "gpt-5.4-mini-fast",
        display: "quotio-openai/gpt-5.4-mini-fast",
        reasoning_effort: "minimal",
      },
      {
        source: "category",
        provider: "apitopia",
        model_id: "z-ai/glm-5.2-ultrafast-unlocked",
        display: "apitopia/z-ai/glm-5.2-ultrafast-unlocked",
        reasoning_effort: "none",
      },
    ] as const
    const spec = {
      ...baseSpec(),
      selectedModel: "apitopia/kimi-for-coding-highspeed-unlocked",
      fallbackModels,
    }

    // when
    const handle = await runner.start(spec)
    await handle.waitForIdle()

    // then
    expect(capturedRetrySettings(captured)).toMatchObject({
      modelFallback: true,
      chains: {
        "apitopia/kimi-for-coding-highspeed-unlocked": [
          "quotio-openai/gpt-5.4-mini-fast:minimal",
          "apitopia/z-ai/glm-5.2-ultrafast-unlocked:none",
        ],
      },
    })
  })

  test("#given no runtime fallbacks #when the child session is created #then no fallback settings manager is injected", async () => {
    // given
    let captured: CreateAgentSessionOptions | undefined
    const runner = new InProcessRunner({
      createSession: async (options) => {
        captured = options
        return completedSession()
      },
    })

    // when
    const handle = await runner.start(baseSpec())
    await handle.waitForIdle()

    // then
    expect(capturedRetrySettings(captured)).toBeUndefined()
  })
})
