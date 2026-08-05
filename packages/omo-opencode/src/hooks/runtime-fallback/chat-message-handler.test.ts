import { describe, expect, test } from "bun:test"

import { createChatMessageHandler } from "./chat-message-handler"
import { createFallbackState } from "./fallback-state"
import type { HookDeps } from "./types"

function createDeps(): HookDeps {
  return {
    ctx: {
      client: {
        session: {},
        tui: {},
      },
      directory: "/test/dir",
    },
    config: {
      enabled: true,
      retry_on_errors: [429, 503, 529],
      max_fallback_attempts: 3,
      cooldown_seconds: 0,
      timeout_seconds: 30,
      notify_on_fallback: true,
      restore_primary_after_cooldown: false, same_model_retries_before_swap: 3, immediate_swap_on_errors: ["quota_exceeded"], provider_overrides: {},
    },
    options: undefined,
    pluginConfig: undefined,
    sessionStates: new Map(),
    sessionLastAccess: new Map(),
    sessionRetryInFlight: new Set(),
    sessionAwaitingFallbackResult: new Set(),
    sessionFallbackTimeouts: new Map(),
    sessionStatusRetryKeys: new Map(),
    internallyAbortedSessions: new Set(),
  }
}

describe("createChatMessageHandler runtime fallback model override", () => {
  test("#given a fallback timeout is armed #when the user manually switches models #then stale retry state is cancelled", async () => {
    const deps = createDeps()
    const sessionID = "session-manual-model-change"
    const state = createFallbackState("openai/gpt-5.4")
    state.currentModel = "zhipuai-coding-plan/glm-5.2"
    state.pendingFallbackModel = "zhipuai-coding-plan/glm-5.2"
    deps.sessionStates.set(sessionID, state)
    deps.sessionAwaitingFallbackResult.add(sessionID)
    deps.sessionRetryInFlight.add(sessionID)
    deps.sessionFallbackTimeouts.set(sessionID, 1)
    const cleared: string[] = []
    const handler = createChatMessageHandler(deps, (id) => {
      cleared.push(id)
      deps.sessionFallbackTimeouts.delete(id)
    })

    await handler(
      {
        sessionID,
        model: {
          providerID: "deepseek",
          modelID: "deepseek-v4-pro",
        },
      },
      { message: {} },
    )

    expect(cleared).toEqual([sessionID])
    expect(deps.sessionFallbackTimeouts.has(sessionID)).toBe(false)
    expect(deps.sessionAwaitingFallbackResult.has(sessionID)).toBe(false)
    expect(deps.sessionRetryInFlight.has(sessionID)).toBe(false)
    expect(deps.sessionStates.get(sessionID)?.currentModel).toBe("deepseek/deepseek-v4-pro")
  })

  test("#given session is on an accepted fallback #when a later user message is transformed after cooldown #then it stays on the fallback model", async () => {
    // given
    const deps = createDeps()
    const sessionID = "session-active-fallback"
    const state = createFallbackState("openai/gpt-5.4")
    state.currentModel = "litellm/openai.eu.gpt-5.5"
    state.fallbackIndex = 0
    state.failedModels.set("openai/gpt-5.4", Date.now() - 60_000)
    deps.sessionStates.set(sessionID, state)
    const handler = createChatMessageHandler(deps)
    const output: { message: { model?: { providerID: string; modelID: string } } } = { message: {} }

    // when
    await handler(
      {
        sessionID,
        model: {
          providerID: "litellm",
          modelID: "openai.eu.gpt-5.5",
        },
      },
      output,
    )

    // then
    expect(output.message.model).toEqual({
      providerID: "litellm",
      modelID: "openai.eu.gpt-5.5",
    })
    expect(deps.sessionStates.get(sessionID)?.currentModel).toBe("litellm/openai.eu.gpt-5.5")
  })
})
