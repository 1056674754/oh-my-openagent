import { describe, expect, test } from "bun:test"
import type { BackgroundTaskConfig } from "../../config/schema"
import type { LaunchInput } from "./types"
import {
  BackgroundQuotaRouter,
  evaluateQuotaPace,
  type QuotaUsageSnapshot,
} from "./quota-routing"

const WINDOW_SECONDS = 5 * 60 * 60
const NOW = Date.UTC(2026, 6, 15, 10, 0, 0)

function snapshotAtElapsedHours(usedPercent: number, elapsedHours: number): QuotaUsageSnapshot {
  return {
    usedPercent,
    resetAtMs: NOW + (5 - elapsedHours) * 60 * 60 * 1_000,
  }
}

function createLaunchInput(): LaunchInput {
  return {
    description: "research",
    prompt: "investigate",
    agent: "librarian",
    parentSessionId: "parent",
    parentMessageId: "message",
    model: {
      providerID: "zhipuai-coding-plan",
      modelID: "glm-5.2",
      variant: "high",
    },
    fallbackChain: [{ providers: ["openai"], model: "gpt-5.6-sol" }],
  }
}

function createConfig(): NonNullable<BackgroundTaskConfig["quotaRouting"]> {
  const config: BackgroundTaskConfig = {
    quotaRouting: {
      "zhipuai-coding-plan/glm-5.2": {
        enabled: true,
        quotaProvider: "zhipuai-coding-plan",
        windowSeconds: WINDOW_SECONDS,
        gracePeriodSeconds: 60 * 60,
        paceThresholdRatio: 0.95,
        refreshIntervalSeconds: 60,
        requestTimeoutMs: 5_000,
        fallbackModels: [
          { model: "bailian/deepseek-v4-pro", variant: "high" },
          "openai/gpt-5.6-sol",
        ],
      },
    },
  }
  if (!config.quotaRouting) throw new Error("quota routing test config is missing")
  return config.quotaRouting
}

describe("evaluateQuotaPace", () => {
  test("exempts the first hour even when usage is already exhausted", () => {
    const decision = evaluateQuotaPace({
      snapshot: snapshotAtElapsedHours(100, 0.5),
      nowMs: NOW,
      windowSeconds: WINDOW_SECONDS,
      gracePeriodSeconds: 60 * 60,
      paceThresholdRatio: 0.95,
    })

    expect(decision.shouldRoute).toBe(false)
    expect(decision.reason).toBe("grace-period")
  })

  test("keeps GLM just below 95 percent of the expected two-hour usage", () => {
    const decision = evaluateQuotaPace({
      snapshot: snapshotAtElapsedHours(37.99, 2),
      nowMs: NOW,
      windowSeconds: WINDOW_SECONDS,
      gracePeriodSeconds: 60 * 60,
      paceThresholdRatio: 0.95,
    })

    expect(decision.expectedUsedPercent).toBeCloseTo(40)
    expect(decision.routeAtPercent).toBeCloseTo(38)
    expect(decision.shouldRoute).toBe(false)
  })

  test("routes at the 95 percent pacing line", () => {
    const decision = evaluateQuotaPace({
      snapshot: snapshotAtElapsedHours(38, 2),
      nowMs: NOW,
      windowSeconds: WINDOW_SECONDS,
      gracePeriodSeconds: 60 * 60,
      paceThresholdRatio: 0.95,
    })

    expect(decision.shouldRoute).toBe(true)
    expect(decision.reason).toBe("pace-limit-reached")
  })
})

describe("BackgroundQuotaRouter", () => {
  test("reroutes only a newly launched matching model and replaces its fallback chain", async () => {
    const input = createLaunchInput()
    const router = new BackgroundQuotaRouter({
      rules: createConfig(),
      now: () => NOW,
      loadQuotaUsage: async () => snapshotAtElapsedHours(38, 2),
    })

    const routed = await router.route(input)

    expect(routed).not.toBe(input)
    expect(input.model).toEqual({
      providerID: "zhipuai-coding-plan",
      modelID: "glm-5.2",
      variant: "high",
    })
    expect(routed.model).toEqual({
      providerID: "bailian",
      modelID: "deepseek-v4-pro",
      variant: "high",
    })
    expect(routed.fallbackChain).toEqual([
      { providers: ["openai"], model: "gpt-5.6-sol" },
    ])
  })

  test("replaces GLM in a new task fallback chain without changing its primary model", async () => {
    const input = createLaunchInput()
    input.model = { providerID: "bailian", modelID: "qwen3.7-max" }
    input.fallbackChain = [
      { providers: ["zhipuai-coding-plan"], model: "glm-5.2" },
      { providers: ["kimi-for-coding"], model: "kimi-k2.6" },
    ]
    const router = new BackgroundQuotaRouter({
      rules: createConfig(),
      now: () => NOW,
      loadQuotaUsage: async () => snapshotAtElapsedHours(38, 2),
    })

    const routed = await router.route(input)

    expect(routed.model).toEqual({ providerID: "bailian", modelID: "qwen3.7-max" })
    expect(routed.fallbackChain).toEqual([
      { providers: ["bailian"], model: "deepseek-v4-pro", variant: "high" },
      { providers: ["openai"], model: "gpt-5.6-sol" },
      { providers: ["kimi-for-coding"], model: "kimi-k2.6" },
    ])
  })

  test("does not load quota for a different model", async () => {
    let loadCount = 0
    const router = new BackgroundQuotaRouter({
      rules: createConfig(),
      now: () => NOW,
      loadQuotaUsage: async () => {
        loadCount += 1
        return snapshotAtElapsedHours(100, 4)
      },
    })
    const input = createLaunchInput()
    input.model = { providerID: "bailian", modelID: "deepseek-v4-pro" }

    const routed = await router.route(input)

    expect(routed).toBe(input)
    expect(loadCount).toBe(0)
  })

  test("fails open when current quota cannot be loaded", async () => {
    const input = createLaunchInput()
    const router = new BackgroundQuotaRouter({
      rules: createConfig(),
      now: () => NOW,
      loadQuotaUsage: async () => null,
    })

    const routed = await router.route(input)

    expect(routed).toBe(input)
  })

  test("fails open when the quota loader throws", async () => {
    const input = createLaunchInput()
    const router = new BackgroundQuotaRouter({
      rules: createConfig(),
      now: () => NOW,
      loadQuotaUsage: async () => {
        throw new Error("network down")
      },
    })

    const routed = await router.route(input)

    expect(routed).toBe(input)
  })
})
