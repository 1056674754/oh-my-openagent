import { describe, expect, test } from "bun:test"

import { createFallbackApprovalRequester } from "./fallback-approval"
import type { HookDeps } from "./types"

function createDeps(): HookDeps {
  return {
    ctx: {
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
      directory: "/workspace",
    },
    config: {
      enabled: true,
      retry_on_errors: [429, 503, 529],
      max_fallback_attempts: 3,
      cooldown_seconds: 60,
      timeout_seconds: 45,
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

describe("createFallbackApprovalRequester", () => {
  test("#given the OpenChamber bridge is present #when the UI approves #then fallback proceeds", async () => {
    const deps = createDeps()
    const calls: Array<{ url: string; body: Record<string, unknown> }> = []
    const requester = createFallbackApprovalRequester(
      deps,
      async (url, init) => {
        calls.push({
          url: String(url),
          body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        })
        return new Response(JSON.stringify({
          decision: "approved",
          preflight: { status: "available", providerId: "zhipuai-coding-plan" },
        }))
      },
      {
        OPENCHAMBER_RUNTIME_FALLBACK_URL: "http://127.0.0.1:5190/api/openchamber/runtime-fallback",
        OPENCHAMBER_AGENT_TOOL_TOKEN: "secret",
      },
    )

    const decision = await requester.request(
      "ses_test",
      "openai/gpt-5.6-sol",
      "zhipuai-coding-plan/glm-5.2",
      "message.updated",
    )

    expect(decision).toEqual({ action: "proceed", reason: "approved" })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.body).toMatchObject({
      sessionID: "ses_test",
      directory: "/workspace",
      timeoutMs: 30_000,
    })
  })

  test("#given quota preflight rejects a candidate #when approval is requested #then the dispatcher can skip it", async () => {
    const requester = createFallbackApprovalRequester(
      createDeps(),
      async () => new Response(JSON.stringify({
        decision: "unavailable",
        preflight: { status: "exhausted", providerId: "zhipuai-coding-plan" },
      })),
      {
        OPENCHAMBER_RUNTIME_FALLBACK_URL: "http://127.0.0.1:5190/api/openchamber/runtime-fallback",
        OPENCHAMBER_AGENT_TOOL_TOKEN: "secret",
      },
    )

    await expect(requester.request(
      "ses_test",
      "openai/gpt-5.6-sol",
      "zhipuai-coding-plan/glm-5.2",
      "message.updated",
    )).resolves.toEqual({ action: "skip", reason: "quota-exhausted" })
  })

  test("#given a pending approval #when model progress resumes #then the bridge request is cancelled", async () => {
    const deps = createDeps()
    const requester = createFallbackApprovalRequester(
      deps,
      async (_url, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")))
      }),
      {
        OPENCHAMBER_RUNTIME_FALLBACK_URL: "http://127.0.0.1:5190/api/openchamber/runtime-fallback",
        OPENCHAMBER_AGENT_TOOL_TOKEN: "secret",
      },
    )

    const pending = requester.request(
      "ses_test",
      "openai/gpt-5.6-sol",
      "zhipuai-coding-plan/glm-5.2",
      "session.timeout",
    )
    await Promise.resolve()
    requester.cancel("ses_test")

    await expect(pending).resolves.toEqual({ action: "cancel", reason: "request-cancelled" })
  })
})
