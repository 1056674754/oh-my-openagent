import { describe, expect, test } from "bun:test"
import { parseZhipuQuotaPayload } from "./zhipu-quota-usage-loader"

describe("parseZhipuQuotaPayload", () => {
  test("extracts token usage and normalizes a seconds reset timestamp", () => {
    const result = parseZhipuQuotaPayload({
      data: {
        limits: [
          { type: "TIME_LIMIT", percentage: 8, nextResetTime: 1_800_000_000 },
          { type: "TOKENS_LIMIT", percentage: 38, nextResetTime: 1_800_000_000 },
        ],
      },
    })

    expect(result).toEqual({
      usedPercent: 38,
      resetAtMs: 1_800_000_000_000,
    })
  })

  test("preserves a millisecond reset timestamp", () => {
    const result = parseZhipuQuotaPayload({
      data: {
        limits: [
          { type: "TOKENS_LIMIT", percentage: 41.5, nextResetTime: 1_800_000_000_000 },
        ],
      },
    })

    expect(result?.resetAtMs).toBe(1_800_000_000_000)
  })

  test("returns null for an incomplete token limit", () => {
    const result = parseZhipuQuotaPayload({
      data: {
        limits: [{ type: "TOKENS_LIMIT", percentage: 38 }],
      },
    })

    expect(result).toBeNull()
  })
})
