import { describe, expect, it } from "bun:test"
import { RUNTIME_FALLBACK_RETRYABLE_ERROR_PATTERNS } from "@oh-my-opencode/model-core"
import type { HookDeps, RuntimeFallbackPluginInput } from "./types"
import type { AutoRetryHelpers } from "./auto-retry"
import { RETRYABLE_ERROR_PATTERNS } from "./constants"
import { createFallbackState } from "./fallback-state"
import { createSessionStatusHandler } from "./session-status-handler"
import { SessionCategoryRegistry } from "../../shared/session-category-registry"

function createContext(): RuntimeFallbackPluginInput {
  return {
    client: {
      session: {
        abort: async () => ({}),
        messages: async () => ({ data: [] }),
        promptAsync: async () => ({}),
      },
      tui: {
        showToast: async () => ({}),
      },
    },
    directory: "/test/dir",
  }
}

function createDeps(): HookDeps {
  return {
    ctx: createContext(),
    config: {
      enabled: true,
      retry_on_errors: [429, 503, 529],
      max_fallback_attempts: 4,
      cooldown_seconds: 60,
      timeout_seconds: 30,
      notify_on_fallback: false,
      restore_primary_after_cooldown: false, same_model_retries_before_swap: 0, immediate_swap_on_errors: ["quota_exceeded"], provider_overrides: {},
    },
    options: undefined,
    pluginConfig: {
      git_master: {
        commit_footer: true,
        include_co_authored_by: true,
        git_env_prefix: "GIT_MASTER_",
      },
      categories: {
        test: {
          fallback_models: ["openai/gpt-5.4", "google/gemini-2.5-pro"],
        },
      },
    },
    sessionStates: new Map(),
    sessionLastAccess: new Map(),
    sessionRetryInFlight: new Set(),
    sessionAwaitingFallbackResult: new Set(),
    sessionFallbackTimeouts: new Map(),
    sessionStatusRetryKeys: new Map(),
  }
}

function createHelpers(abortCalls: string[], retryCalls: Array<{ sessionID: string; model: string; source: string }>): AutoRetryHelpers {
  return {
    abortSessionRequest: async (sessionID: string) => {
      abortCalls.push(sessionID)
    },
    clearSessionFallbackTimeout: () => {},
    scheduleSessionFallbackTimeout: () => {},
    autoRetryWithFallback: async (sessionID: string, model: string, _resolvedAgent: string | undefined, source: string) => {
      retryCalls.push({ sessionID, model, source })
      return { accepted: true, status: "dispatched" }
    },
    resolveAgentForSessionFromContext: async () => undefined,
    cleanupStaleSessions: () => {},
  }
}

describe("createSessionStatusHandler", () => {
  it("#given model-core retryable patterns #when the adapter status fallback patterns are loaded #then they share the canonical pattern set", () => {
    // given
    const canonicalPatterns = RUNTIME_FALLBACK_RETRYABLE_ERROR_PATTERNS

    // when
    const statusFallbackPatterns = RETRYABLE_ERROR_PATTERNS

    // then
    expect(statusFallbackPatterns).toBe(canonicalPatterns)
  })

  it("#given a free usage retry status #when the handler receives it #then it dispatches the fallback immediately", async () => {
    // given
    SessionCategoryRegistry.clear()
    const sessionID = "session-status-free-usage"
    SessionCategoryRegistry.register(sessionID, "test")

    const deps = createDeps()
    const abortCalls: string[] = []
    const retryCalls: Array<{ sessionID: string; model: string; source: string }> = []
    const handler = createSessionStatusHandler(deps, createHelpers(abortCalls, retryCalls), deps.sessionStatusRetryKeys)

    // when
    await handler({
      sessionID,
      model: "opencode/big-pickle",
      status: {
        type: "retry",
        attempt: 1,
        message: "Free usage exceeded, subscribe to Go",
      },
    })

    // then
    expect(abortCalls).toEqual([sessionID])
    expect(retryCalls).toEqual([
      {
        sessionID,
        model: "openai/gpt-5.4",
        source: "session.status",
      },
    ])
    expect(deps.sessionStatusRetryKeys.has(sessionID)).toBe(true)
    SessionCategoryRegistry.clear()
  })

  it("#given pending fallback prompt may already be accepted #when provider retry status arrives #then it keeps waiting for that accepted prompt", async () => {
    // given
    SessionCategoryRegistry.remove("session-status-ambiguous-pending")
    const sessionID = "session-status-ambiguous-pending"
    SessionCategoryRegistry.register(sessionID, "test")

    const deps = createDeps()
    const abortCalls: string[] = []
    const retryCalls: Array<{ sessionID: string; model: string; source: string }> = []
    const state = createFallbackState("anthropic/claude-opus-4-7")
    state.currentModel = "openai/gpt-5.4"
    state.fallbackIndex = 0
    state.attemptCount = 1
    state.pendingFallbackModel = "openai/gpt-5.4"
    state.pendingFallbackPromptMayHaveBeenAccepted = true
    deps.sessionStates.set(sessionID, state)

    const handler = createSessionStatusHandler(deps, createHelpers(abortCalls, retryCalls), deps.sessionStatusRetryKeys)

    // when
    await handler({
      sessionID,
      model: "openai/gpt-5.4",
      status: {
        type: "retry",
        attempt: 2,
        message: "All credentials for model gpt-5.4 are cooling down [retrying in 7m 56s attempt #2]",
      },
    })

    // then
    expect(abortCalls).toEqual([])
    expect(retryCalls).toEqual([])
    expect(state.currentModel).toBe("openai/gpt-5.4")
    expect(state.pendingFallbackModel).toBe("openai/gpt-5.4")
    expect(state.pendingFallbackPromptMayHaveBeenAccepted).toBe(true)
    SessionCategoryRegistry.remove("session-status-ambiguous-pending")
  })

  it("#given a pending fallback model #when a new provider cooldown retry arrives #then the handler overrides the pending fallback and advances the chain", async () => {
    // given
    SessionCategoryRegistry.remove("session-status-pending-fallback")
    const sessionID = "session-status-pending-fallback"
    SessionCategoryRegistry.register(sessionID, "test")

    const deps = createDeps()
    const abortCalls: string[] = []
    const retryCalls: Array<{ sessionID: string; model: string; source: string }> = []
    const state = createFallbackState("anthropic/claude-opus-4-7")
    state.currentModel = "openai/gpt-5.4"
    state.fallbackIndex = 0
    state.attemptCount = 1
    state.pendingFallbackModel = "openai/gpt-5.4"
    state.failedModels.set("anthropic/claude-opus-4-7", Date.now())
    deps.sessionStates.set(sessionID, state)

    const handler = createSessionStatusHandler(deps, createHelpers(abortCalls, retryCalls), deps.sessionStatusRetryKeys)

    // when
    await handler({
      sessionID,
      model: "openai/gpt-5.4",
      status: {
        type: "retry",
        attempt: 2,
        message: "All credentials for model gpt-5.4 are cooling down [retrying in 7m 56s attempt #2]",
      },
    })

    // then
    expect(abortCalls).toEqual([sessionID])
    expect(retryCalls).toEqual([
      {
        sessionID,
        model: "google/gemini-2.5-pro",
        source: "session.status",
      },
    ])
    expect(state.currentModel).toBe("google/gemini-2.5-pro")
    expect(state.pendingFallbackModel).toBe("google/gemini-2.5-pro")
    SessionCategoryRegistry.remove("session-status-pending-fallback")
  })
})

describe("createSessionStatusHandler retry budget", () => {
  it("#given attempt within budget #when retry signal arrives #then lets opencode retry without swapping", async () => {
    SessionCategoryRegistry.remove("session-status-pending-fallback")
    const sessionID = "session-budget-within"
    SessionCategoryRegistry.register(sessionID, "test")

    const deps = createDeps()
    deps.config.same_model_retries_before_swap = 3
    const abortCalls: string[] = []
    const retryCalls: Array<{ sessionID: string; model: string; source: string }> = []
    const state = createFallbackState("openai/gpt-5.4")
    deps.sessionStates.set(sessionID, state)

    const handler = createSessionStatusHandler(deps, createHelpers(abortCalls, retryCalls), deps.sessionStatusRetryKeys)

    await handler({
      sessionID,
      model: "openai/gpt-5.4",
      status: { type: "retry", attempt: 1, message: "rate limit exceeded [retrying in 5s attempt #1]" },
    })

    expect(abortCalls).toEqual([])
    expect(retryCalls).toEqual([])
    expect(state.maxRetryAttemptObserved).toBe(1)
    expect(state.currentModel).toBe("openai/gpt-5.4")
    SessionCategoryRegistry.remove(sessionID)
  })

  it("#given attempt exceeds budget #when retry signal arrives #then swaps to fallback", async () => {
    const sessionID = "session-budget-exceeded"
    SessionCategoryRegistry.register(sessionID, "test")

    const deps = createDeps()
    deps.config.same_model_retries_before_swap = 2
    const abortCalls: string[] = []
    const retryCalls: Array<{ sessionID: string; model: string; source: string }> = []
    const state = createFallbackState("openai/gpt-5.4")
    state.maxRetryAttemptObserved = 3
    deps.sessionStates.set(sessionID, state)

    const handler = createSessionStatusHandler(deps, createHelpers(abortCalls, retryCalls), deps.sessionStatusRetryKeys)

    await handler({
      sessionID,
      model: "openai/gpt-5.4",
      status: { type: "retry", attempt: 4, message: "rate limit exceeded [retrying in 5s attempt #4]" },
    })

    expect(retryCalls.length).toBe(1)
    expect(retryCalls[0]?.model).toBe("google/gemini-2.5-pro")
    SessionCategoryRegistry.remove(sessionID)
  })

  it("#given quota_exceeded error #when first retry signal arrives #then swaps immediately ignoring budget", async () => {
    const sessionID = "session-quota-immediate"
    SessionCategoryRegistry.register(sessionID, "test")

    const deps = createDeps()
    deps.config.same_model_retries_before_swap = 5
    const abortCalls: string[] = []
    const retryCalls: Array<{ sessionID: string; model: string; source: string }> = []
    const state = createFallbackState("openai/gpt-5.4")
    deps.sessionStates.set(sessionID, state)

    const handler = createSessionStatusHandler(deps, createHelpers(abortCalls, retryCalls), deps.sessionStatusRetryKeys)

    await handler({
      sessionID,
      model: "openai/gpt-5.4",
      status: { type: "retry", attempt: 1, message: "Insufficient balance or no resource package. Please recharge. [retrying in 5s attempt #1]" },
    })

    expect(retryCalls.length).toBe(1)
    SessionCategoryRegistry.remove(sessionID)
  })

  it("#given provider override #when kimi rate-limited #then uses higher budget", async () => {
    const sessionID = "session-provider-override"
    SessionCategoryRegistry.register(sessionID, "test")

    const deps = createDeps()
    deps.config.same_model_retries_before_swap = 1
    deps.config.provider_overrides = { bailian: { same_model_retries_before_swap: 4 } }
    const abortCalls: string[] = []
    const retryCalls: Array<{ sessionID: string; model: string; source: string }> = []
    const state = createFallbackState("bailian/kimi/kimi-k3")
    deps.sessionStates.set(sessionID, state)

    const handler = createSessionStatusHandler(deps, createHelpers(abortCalls, retryCalls), deps.sessionStatusRetryKeys)

    await handler({
      sessionID,
      model: "bailian/kimi/kimi-k3",
      status: { type: "retry", attempt: 2, message: "rate limit exceeded [retrying in 3s attempt #2]" },
    })

    expect(abortCalls).toEqual([])
    expect(retryCalls).toEqual([])
    expect(state.maxRetryAttemptObserved).toBe(2)
    SessionCategoryRegistry.remove(sessionID)
  })
})
