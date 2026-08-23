import { describe, expect, test } from "bun:test"
import { ZodError } from "zod"
import { BackgroundTaskConfigSchema } from "./background-task"

describe("BackgroundTaskConfigSchema", () => {
  describe("quotaRouting", () => {
    test("applies pacing defaults to a configured model", () => {
      const result = BackgroundTaskConfigSchema.parse({
        quotaRouting: {
          "zhipuai-coding-plan/glm-5.2": {
            fallbackModels: ["bailian/deepseek-v4-pro"],
          },
        },
      })

      expect(result.quotaRouting?.["zhipuai-coding-plan/glm-5.2"]).toEqual({
        enabled: true,
        quotaProvider: "zhipuai-coding-plan",
        windowSeconds: 18_000,
        gracePeriodSeconds: 3_600,
        paceThresholdRatio: 0.95,
        refreshIntervalSeconds: 60,
        requestTimeoutMs: 5_000,
        fallbackModels: ["bailian/deepseek-v4-pro"],
      })
    })

    test("rejects an empty fallback model list", () => {
      const result = BackgroundTaskConfigSchema.safeParse({
        quotaRouting: {
          "zhipuai-coding-plan/glm-5.2": {
            fallbackModels: [],
          },
        },
      })

      expect(result.success).toBe(false)
    })

    test("rejects a grace period as long as the quota window", () => {
      const result = BackgroundTaskConfigSchema.safeParse({
        quotaRouting: {
          "zhipuai-coding-plan/glm-5.2": {
            windowSeconds: 3_600,
            gracePeriodSeconds: 3_600,
            fallbackModels: ["bailian/deepseek-v4-pro"],
          },
        },
      })

      expect(result.success).toBe(false)
    })
  })

  describe("maxDepth", () => {
    describe("#given valid maxDepth (3)", () => {
      test("#when parsed #then returns correct value", () => {
        const result = BackgroundTaskConfigSchema.parse({ maxDepth: 3 })

        expect(result.maxDepth).toBe(3)
      })
    })

    describe("#given maxDepth below minimum (0)", () => {
      test("#when parsed #then throws ZodError", () => {
        let thrownError: unknown

        try {
          BackgroundTaskConfigSchema.parse({ maxDepth: 0 })
        } catch (error) {
          thrownError = error
        }

        expect(thrownError).toBeInstanceOf(ZodError)
      })
    })
  })

  describe("syncPollTimeoutMs", () => {
    describe("#given valid syncPollTimeoutMs (120000)", () => {
      test("#when parsed #then returns correct value", () => {
        const result = BackgroundTaskConfigSchema.parse({ syncPollTimeoutMs: 120000 })

        expect(result.syncPollTimeoutMs).toBe(120000)
      })
    })

    describe("#given syncPollTimeoutMs below minimum (59999)", () => {
      test("#when parsed #then throws ZodError", () => {
        let thrownError: unknown

        try {
          BackgroundTaskConfigSchema.parse({ syncPollTimeoutMs: 59999 })
        } catch (error) {
          thrownError = error
        }

        expect(thrownError).toBeInstanceOf(ZodError)
      })
    })

    describe("#given syncPollTimeoutMs not provided", () => {
      test("#when parsed #then field is undefined", () => {
        const result = BackgroundTaskConfigSchema.parse({})

        expect(result.syncPollTimeoutMs).toBeUndefined()
      })
    })

    describe('#given syncPollTimeoutMs is non-number ("abc")', () => {
      test("#when parsed #then throws ZodError", () => {
        let thrownError: unknown

        try {
          BackgroundTaskConfigSchema.parse({ syncPollTimeoutMs: "abc" })
        } catch (error) {
          thrownError = error
        }

        expect(thrownError).toBeInstanceOf(ZodError)
      })
    })
  })
})
