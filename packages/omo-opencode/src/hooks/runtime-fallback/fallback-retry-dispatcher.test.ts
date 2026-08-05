import { describe, expect, test } from "bun:test"

import type { AutoRetryHelpers } from "./auto-retry"
import { dispatchFallbackRetry } from "./fallback-retry-dispatcher"
import { createFallbackState } from "./fallback-state"
import type { HookDeps, RuntimeFallbackPluginInput } from "./types"

function createContext(toastMessages: string[]): RuntimeFallbackPluginInput {
  return {
    client: {
      session: {
        abort: async () => ({}),
        messages: async () => ({ data: [] }),
        promptAsync: async () => ({}),
      },
      tui: {
        showToast: async (input) => {
          toastMessages.push(input.body.message)
          return {}
        },
      },
    },
    directory: "/test/dir",
  }
}

function createDeps(toastMessages: string[]): HookDeps {
  return {
    ctx: createContext(toastMessages),
    config: {
      enabled: true,
      retry_on_errors: [429, 503, 529],
      max_fallback_attempts: 3,
      cooldown_seconds: 60,
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

function createRejectedDispatchHelpers(dispatchCalls: string[]): AutoRetryHelpers {
  return {
    abortSessionRequest: async () => {},
    clearSessionFallbackTimeout: () => {},
    scheduleSessionFallbackTimeout: () => {},
    autoRetryWithFallback: async (_sessionID, model) => {
      dispatchCalls.push(model)
      return { accepted: false, status: "blocked", reason: "test gate blocked dispatch" }
    },
    resolveAgentForSessionFromContext: async () => undefined,
    cleanupStaleSessions: () => {},
  }
}

describe("dispatchFallbackRetry", () => {
  test("#given fallback dispatch is blocked #when fallback retry runs #then state is restored and error toast notifies user", async () => {
    const toastMessages: string[] = []
    const dispatchCalls: string[] = []
    const deps = createDeps(toastMessages)
    const helpers = createRejectedDispatchHelpers(dispatchCalls)
    const sessionID = "session-dispatch-rejected"
    const state = createFallbackState("openai/gpt-5.4")
    deps.sessionStates.set(sessionID, state)

    await dispatchFallbackRetry(deps, helpers, {
      sessionID,
      state,
      fallbackModels: ["litellm/openai.eu.gpt-5.5"],
      source: "message.updated",
    })

    expect(dispatchCalls).toEqual(["litellm/openai.eu.gpt-5.5"])
    expect(toastMessages).toEqual([
      "Could not switch to litellm/openai.eu.gpt-5.5: test gate blocked dispatch. Please retry or select a model manually.",
    ])
    expect(state.currentModel).toBe("openai/gpt-5.4")
    expect(state.fallbackIndex).toBe(-1)
    expect(state.attemptCount).toBe(0)
    expect(state.pendingFallbackModel).toBe(undefined)
    expect(state.failedModels.size).toBe(0)
  })

  test("#given all fallback candidates exhausted #when fallback retry runs #then error toast lists exhausted models", async () => {
    const toastMessages: string[] = []
    const deps = createDeps(toastMessages)
    const helpers: AutoRetryHelpers = {
      abortSessionRequest: async () => {},
      clearSessionFallbackTimeout: () => {},
      scheduleSessionFallbackTimeout: () => {},
      autoRetryWithFallback: async () => undefined,
      resolveAgentForSessionFromContext: async () => undefined,
      cleanupStaleSessions: () => {},
    }
    const sessionID = "session-all-exhausted"
    const state = createFallbackState("openai/gpt-5.4")
    deps.sessionStates.set(sessionID, state)

    await dispatchFallbackRetry(deps, helpers, {
      sessionID,
      state,
      fallbackModels: [],
      source: "session.status",
    })

    expect(toastMessages).toEqual([
      "Primary model and all fallback candidates failed (no fallback models were available). Please recharge quota or select a different model manually.",
    ])
  })
})
