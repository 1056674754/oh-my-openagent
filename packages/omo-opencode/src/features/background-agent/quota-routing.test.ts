import { describe, expect, test } from "bun:test"
import type { BackgroundTaskConfig } from "../../config/schema"
import type { LaunchInput } from "./types"
import {
  BackgroundQuotaRouter,
  evaluateQuotaPace,
  type QuotaUsageSnapshot,
} from "./quota-routing"

const FIVE_HOURS = 18_000
const WEEK = 604_800
const NOW = Date.UTC(2026, 6, 22, 12, 0, 0)

function windowAtElapsed(
  windowSeconds: number,
  usedPercent: number,
  elapsedSeconds: number,
): QuotaUsageSnapshot["windows"][number] {
  return {
    windowSeconds,
    usedPercent,
    resetAtMs: NOW + (windowSeconds - elapsedSeconds) * 1_000,
  }
}

function createInput(): LaunchInput {
  return {
    description: "build UI",
    prompt: "implement the frontend",
    agent: "sisyphus-junior",
    parentSessionId: "parent",
    parentMessageId: "message",
    model: { providerID: "kimi-for-coding", modelID: "k3", variant: "max" },
    fallbackChain: [{ providers: ["openai"], model: "gpt-5.6-sol" }],
  }
}

function createRules(): NonNullable<BackgroundTaskConfig["quotaRouting"]> {
  return {
    "kimi-for-coding/k3": {
      enabled: true,
      quotaProvider: "kimi-for-coding",
      windows: [
        { windowSeconds: FIVE_HOURS, gracePeriodSeconds: 3_600, paceThresholdRatio: 0.95 },
        { windowSeconds: WEEK, gracePeriodSeconds: 3_600, paceThresholdRatio: 0.95 },
      ],
      refreshIntervalSeconds: 60,
      requestTimeoutMs: 5_000,
      fallbackModels: ["openai/gpt-5.6-sol"],
    },
  }
}

describe("evaluateQuotaPace", () => {
  test("#given exhausted quota in the first hour #when evaluated #then keeps the requested model", () => {
    const decision = evaluateQuotaPace({
      snapshot: windowAtElapsed(FIVE_HOURS, 100, 30 * 60),
      nowMs: NOW,
      gracePeriodSeconds: 3_600,
      paceThresholdRatio: 0.95,
    })

    expect(decision.shouldRoute).toBe(false)
    expect(decision.reason).toBe("grace-period")
  })

  test("#given usage at 95 percent of elapsed budget #when evaluated #then routes", () => {
    const decision = evaluateQuotaPace({
      snapshot: windowAtElapsed(FIVE_HOURS, 38, 2 * 60 * 60),
      nowMs: NOW,
      gracePeriodSeconds: 3_600,
      paceThresholdRatio: 0.95,
    })

    expect(decision.expectedUsedPercent).toBeCloseTo(40)
    expect(decision.routeAtPercent).toBeCloseTo(38)
    expect(decision.shouldRoute).toBe(true)
  })
})

describe("BackgroundQuotaRouter", () => {
  test("#given the weekly window over pace #when a new K3 task launches #then reroutes to GPT", async () => {
    const input = createInput()
    const router = new BackgroundQuotaRouter({
      rules: createRules(),
      now: () => NOW,
      loadQuotaUsage: async () => ({
        windows: [
          windowAtElapsed(FIVE_HOURS, 10, 2 * 60 * 60),
          windowAtElapsed(WEEK, 54.3, 4 * 24 * 60 * 60),
        ],
      }),
    })

    const routed = await router.route(input)

    expect(input.model).toEqual({ providerID: "kimi-for-coding", modelID: "k3", variant: "max" })
    expect(routed.model).toEqual({ providerID: "openai", modelID: "gpt-5.6-sol" })
    expect(routed.fallbackChain).toEqual([])
  })

  test("#given the 300-minute window over pace #when a new K3 task launches #then reroutes to GPT", async () => {
    const router = new BackgroundQuotaRouter({
      rules: createRules(),
      now: () => NOW,
      loadQuotaUsage: async () => ({
        windows: [
          windowAtElapsed(FIVE_HOURS, 38, 2 * 60 * 60),
          windowAtElapsed(WEEK, 20, 4 * 24 * 60 * 60),
        ],
      }),
    })

    const routed = await router.route(createInput())

    expect(routed.model).toEqual({ providerID: "openai", modelID: "gpt-5.6-sol" })
  })

  test("#given a multi-provider fallback shares the promoted model #then preserves its other provider", async () => {
    const input = createInput()
    input.fallbackChain = [
      { providers: ["github-copilot", "openai"], model: "gpt-5.6-sol" },
    ]
    const router = new BackgroundQuotaRouter({
      rules: createRules(),
      now: () => NOW,
      loadQuotaUsage: async () => ({
        windows: [
          windowAtElapsed(FIVE_HOURS, 38, 2 * 60 * 60),
          windowAtElapsed(WEEK, 20, 4 * 24 * 60 * 60),
        ],
      }),
    })

    const routed = await router.route(input)

    expect(routed.model).toEqual({ providerID: "openai", modelID: "gpt-5.6-sol" })
    expect(routed.fallbackChain).toEqual([
      { providers: ["github-copilot"], model: "gpt-5.6-sol" },
    ])
  })

  test("#given both windows below pace #when a new K3 task launches #then preserves K3", async () => {
    const input = createInput()
    const router = new BackgroundQuotaRouter({
      rules: createRules(),
      now: () => NOW,
      loadQuotaUsage: async () => ({
        windows: [
          windowAtElapsed(FIVE_HOURS, 30, 2 * 60 * 60),
          windowAtElapsed(WEEK, 20, 4 * 24 * 60 * 60),
        ],
      }),
    })

    expect(await router.route(input)).toBe(input)
  })

  test("#given one configured quota window is missing #when the other is over pace #then fails open", async () => {
    const input = createInput()
    const router = new BackgroundQuotaRouter({
      rules: createRules(),
      now: () => NOW,
      loadQuotaUsage: async () => ({
        windows: [windowAtElapsed(WEEK, 80, 4 * 24 * 60 * 60)],
      }),
    })

    expect(await router.route(input)).toBe(input)
  })

  test("#given primary is below pace and a later managed fallback is over pace #then evaluates both rules", async () => {
    const rules = createRules()
    rules["zhipuai-coding-plan/glm-5.2"] = {
      enabled: true,
      quotaProvider: "zhipuai-coding-plan",
      windows: [{ windowSeconds: FIVE_HOURS, gracePeriodSeconds: 3_600, paceThresholdRatio: 0.95 }],
      refreshIntervalSeconds: 60,
      requestTimeoutMs: 5_000,
      fallbackModels: ["openai/gpt-5.6-sol"],
    }
    const input = createInput()
    input.fallbackChain = [
      { providers: ["anthropic"], model: "claude-sonnet-4-6" },
      { providers: ["zhipuai-coding-plan"], model: "glm-5.2" },
      { providers: ["opencode"], model: "big-pickle" },
    ]
    const router = new BackgroundQuotaRouter({
      rules,
      now: () => NOW,
      loadQuotaUsage: async ({ quotaProvider }) => ({
        windows: quotaProvider === "kimi-for-coding"
          ? [windowAtElapsed(FIVE_HOURS, 10, 2 * 60 * 60), windowAtElapsed(WEEK, 20, 4 * 24 * 60 * 60)]
          : [windowAtElapsed(FIVE_HOURS, 50, 2 * 60 * 60)],
      }),
    })

    const routed = await router.route(input)

    expect(routed.model).toEqual(input.model)
    expect(routed.fallbackChain).toEqual([
      { providers: ["anthropic"], model: "claude-sonnet-4-6" },
      { providers: ["openai"], model: "gpt-5.6-sol" },
      { providers: ["opencode"], model: "big-pickle" },
    ])
  })

  test("#given a managed fallback in the middle #when it is over pace #then replaces it in place", async () => {
    const input = createInput()
    input.model = { providerID: "openai", modelID: "gpt-5.6-sol" }
    input.fallbackChain = [
      { providers: ["anthropic"], model: "claude-sonnet-4-6" },
      { providers: ["kimi-for-coding"], model: "k3" },
      { providers: ["opencode"], model: "big-pickle" },
    ]
    const router = new BackgroundQuotaRouter({
      rules: createRules(),
      now: () => NOW,
      loadQuotaUsage: async () => ({
        windows: [
          windowAtElapsed(FIVE_HOURS, 38, 2 * 60 * 60),
          windowAtElapsed(WEEK, 20, 4 * 24 * 60 * 60),
        ],
      }),
    })

    const routed = await router.route(input)

    expect(routed.fallbackChain).toEqual([
      { providers: ["anthropic"], model: "claude-sonnet-4-6" },
      { providers: ["opencode"], model: "big-pickle" },
    ])
  })
})
