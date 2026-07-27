import { isRecord } from "@oh-my-opencode/utils"
import type { QuotaUsageSnapshot, QuotaUsageWindowSnapshot } from "./quota-routing"

const WEEK_SECONDS = 7 * 24 * 60 * 60
const ZHIPU_DEFAULT_WINDOW_SECONDS = 5 * 60 * 60
const MAX_QUOTA_WINDOWS = 20

function readNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value !== "string" || value.trim() === "") return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function normalizeTimestamp(value: unknown): number | undefined {
  const numeric = readNumber(value)
  if (numeric !== undefined) return numeric < 1_000_000_000_000 ? numeric * 1_000 : numeric
  if (typeof value !== "string") return undefined
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? undefined : parsed
}

function usedPercent(limit: unknown, remaining: unknown): number | undefined {
  const total = readNumber(limit)
  const rest = readNumber(remaining)
  if (total === undefined || total <= 0 || rest === undefined || rest < 0 || rest > total) return undefined
  return 100 - (rest / total) * 100
}

function durationToSeconds(duration: unknown, unit: unknown): number | undefined {
  const amount = readNumber(duration)
  if (amount === undefined || amount <= 0) return undefined
  if (unit === "TIME_UNIT_MINUTE") return amount * 60
  if (unit === "TIME_UNIT_HOUR") return amount * 60 * 60
  if (unit === "TIME_UNIT_DAY") return amount * 24 * 60 * 60
  return undefined
}

function createWindow(args: {
  windowSeconds: number | undefined
  usedPercent: number | undefined
  resetAtMs: number | undefined
}): QuotaUsageWindowSnapshot | undefined {
  if (args.windowSeconds === undefined || args.usedPercent === undefined || args.resetAtMs === undefined) {
    return undefined
  }
  if (args.windowSeconds <= 0 || args.usedPercent < 0 || args.usedPercent > 100 || args.resetAtMs <= 0) {
    return undefined
  }
  return {
    windowSeconds: args.windowSeconds,
    usedPercent: args.usedPercent,
    resetAtMs: args.resetAtMs,
  }
}

export function parseKimiQuotaPayload(payload: unknown): QuotaUsageSnapshot | null {
  if (!isRecord(payload)) return null
  const windows: QuotaUsageWindowSnapshot[] = []

  if (isRecord(payload.usage)) {
    const weekly = createWindow({
      windowSeconds: WEEK_SECONDS,
      usedPercent: usedPercent(payload.usage.limit, payload.usage.remaining),
      resetAtMs: normalizeTimestamp(payload.usage.resetTime),
    })
    if (weekly) windows.push(weekly)
  }

  if (Array.isArray(payload.limits)) {
    if (payload.limits.length > MAX_QUOTA_WINDOWS) return null
    for (const limit of payload.limits) {
      if (!isRecord(limit) || !isRecord(limit.window) || !isRecord(limit.detail)) continue
      const window = createWindow({
        windowSeconds: durationToSeconds(limit.window.duration, limit.window.timeUnit),
        usedPercent: usedPercent(limit.detail.limit, limit.detail.remaining),
        resetAtMs: normalizeTimestamp(limit.detail.resetTime),
      })
      if (window) windows.push(window)
    }
  }

  return windows.length > 0 ? { windows } : null
}

export function parseZhipuQuotaPayload(payload: unknown): QuotaUsageSnapshot | null {
  if (!isRecord(payload) || !isRecord(payload.data) || !Array.isArray(payload.data.limits)) return null
  if (payload.data.limits.length > MAX_QUOTA_WINDOWS) return null

  for (const limit of payload.data.limits) {
    if (!isRecord(limit) || limit.type !== "TOKENS_LIMIT") continue
    if (limit.unit !== undefined && limit.unit !== 3) return null
    const count = readNumber(limit.number)
    const window = createWindow({
      windowSeconds: count !== undefined ? count * 60 * 60 : ZHIPU_DEFAULT_WINDOW_SECONDS,
      usedPercent: readNumber(limit.percentage),
      resetAtMs: normalizeTimestamp(limit.nextResetTime),
    })
    return window ? { windows: [window] } : null
  }

  return null
}
