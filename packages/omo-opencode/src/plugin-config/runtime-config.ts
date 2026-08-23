import type { OhMyOpenCodeConfig } from "../config"
import type { BackgroundTaskConfig } from "../config/schema"

type MutableRecord = Record<string, unknown>

function isRecord(value: unknown): value is MutableRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function reconcileRecord(target: MutableRecord, source: Readonly<MutableRecord>): void {
  for (const key of Object.keys(target)) {
    if (!(key in source)) {
      delete target[key]
    }
  }

  for (const [key, sourceValue] of Object.entries(source)) {
    const targetValue = target[key]
    if (isRecord(targetValue) && isRecord(sourceValue)) {
      reconcileRecord(targetValue, sourceValue)
      continue
    }
    if (Array.isArray(targetValue) && Array.isArray(sourceValue)) {
      targetValue.splice(0, targetValue.length, ...sourceValue)
      continue
    }
    target[key] = sourceValue
  }
}

export function applyRuntimePluginConfig(args: {
  current: OhMyOpenCodeConfig
  next: OhMyOpenCodeConfig
  updateBackgroundTaskConfig?: (config: BackgroundTaskConfig | undefined) => void
}): void {
  reconcileRecord(args.current, args.next)
  args.updateBackgroundTaskConfig?.(args.current.background_task)
}
