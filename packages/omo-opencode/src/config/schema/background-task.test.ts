import { describe, expect, test } from "bun:test"
import { ZodError } from "zod"
import { BackgroundTaskConfigSchema } from "./background-task"

describe("BackgroundTaskConfigSchema", () => {
  describe("quotaRouting", () => {
    test("#given Kimi dual-window routing #when parsed #then preserves both pacing windows", () => {
      const result = BackgroundTaskConfigSchema.parse({
        quotaRouting: {
          "kimi-for-coding/k3": {
            quotaProvider: "kimi-for-coding",
            windows: [
              { windowSeconds: 18_000 },
              { windowSeconds: 604_800 },
            ],
            fallbackModels: ["openai/gpt-5.6-sol"],
          },
        },
      })

      expect(result.quotaRouting?.["kimi-for-coding/k3"]).toEqual({
        enabled: true,
        quotaProvider: "kimi-for-coding",
        windows: [
          { windowSeconds: 18_000, gracePeriodSeconds: 3_600, paceThresholdRatio: 0.95 },
          { windowSeconds: 604_800, gracePeriodSeconds: 3_600, paceThresholdRatio: 0.95 },
        ],
        refreshIntervalSeconds: 60,
        requestTimeoutMs: 5_000,
        fallbackModels: ["openai/gpt-5.6-sol"],
      })
    })

    test("#given a grace period equal to a window #when parsed #then rejects the rule", () => {
      const result = BackgroundTaskConfigSchema.safeParse({
        quotaRouting: {
          "kimi-for-coding/k3": {
            quotaProvider: "kimi-for-coding",
            windows: [{ windowSeconds: 3_600, gracePeriodSeconds: 3_600 }],
            fallbackModels: ["openai/gpt-5.6-sol"],
          },
        },
      })

      expect(result.success).toBe(false)
    })
  })

  describe("defaultConcurrency", () => {
    test("#given defaultConcurrency is 0 #then parses successfully", () => {
      const result = BackgroundTaskConfigSchema.safeParse({ defaultConcurrency: 0 })

      expect(result.success).toBe(true)
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
