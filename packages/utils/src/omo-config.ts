export const HARNESS_IDS = ["codex", "opencode", "omo"] as const

export type HarnessId = (typeof HARNESS_IDS)[number]

export interface CodegraphConfig {
  readonly auto_init?: boolean | "safe"
  readonly auto_provision?: boolean
  readonly daemon?: boolean
  readonly enabled?: boolean
  readonly excluded_roots?: readonly string[]
  readonly install_dir?: string
  readonly max_index_db_bytes?: number
  readonly telemetry?: boolean
  readonly watch_debounce_ms?: number
}

export type HarnessOverrideConfig = {
  readonly codegraph?: Partial<CodegraphConfig>
}

export type OmoConfig = HarnessOverrideConfig & {
  readonly "[codex]"?: HarnessOverrideConfig
  readonly "[omo]"?: HarnessOverrideConfig
  readonly "[opencode]"?: HarnessOverrideConfig
}

type CodegraphSettingKey = keyof CodegraphConfig
type SettingPath = `codegraph.${CodegraphSettingKey}`

export const SETTING_HARNESS_SUPPORT: Record<SettingPath, readonly HarnessId[]> = {
  "codegraph.auto_init": HARNESS_IDS,
  "codegraph.auto_provision": HARNESS_IDS,
  "codegraph.daemon": ["codex", "opencode"],
  "codegraph.enabled": HARNESS_IDS,
  "codegraph.excluded_roots": ["codex", "opencode"],
  "codegraph.install_dir": HARNESS_IDS,
  "codegraph.max_index_db_bytes": HARNESS_IDS,
  "codegraph.telemetry": HARNESS_IDS,
  "codegraph.watch_debounce_ms": HARNESS_IDS,
} as const

export interface OmoConfigValidationResult {
  readonly errors: readonly string[]
  readonly ok: boolean
}

const HARNESS_BLOCK_KEYS: Record<string, HarnessId> = {
  "[codex]": "codex",
  "[omo]": "omo",
  "[opencode]": "opencode",
}

const CODEGRAPH_VALUE_TYPES: Record<CodegraphSettingKey, "auto_init" | "boolean" | "number" | "positive_integer" | "string" | "string_array"> = {
  auto_init: "auto_init",
  auto_provision: "boolean",
  daemon: "boolean",
  enabled: "boolean",
  excluded_roots: "string_array",
  install_dir: "string",
  max_index_db_bytes: "positive_integer",
  telemetry: "boolean",
  watch_debounce_ms: "number",
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isHarnessBlockKey(key: string): boolean {
  return key.startsWith("[") && key.endsWith("]")
}

function validateCodegraphSection(
  section: unknown,
  pathPrefix: string,
  harness: HarnessId | null,
  errors: string[],
): void {
  if (!isRecord(section)) {
    errors.push(`${pathPrefix} must be an object`)
    return
  }

  for (const [key, value] of Object.entries(section)) {
    if (!(key in CODEGRAPH_VALUE_TYPES)) {
      errors.push(`${pathPrefix}.${key} is not a supported setting`)
      continue
    }

    const settingKey = key as CodegraphSettingKey
    const expectedType = CODEGRAPH_VALUE_TYPES[settingKey]
    if (expectedType === "auto_init") {
      if (value !== "safe" && typeof value !== "boolean") {
        errors.push(`${pathPrefix}.${key} must be "safe" or a boolean`)
      }
      continue
    }
    if (expectedType === "string_array") {
      if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
        errors.push(`${pathPrefix}.${key} must be an array of strings`)
      }
      continue
    }
    if (expectedType === "positive_integer") {
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
        errors.push(`${pathPrefix}.${key} must be a positive safe integer`)
      }
      continue
    }

    if (typeof value !== expectedType) {
      errors.push(`${pathPrefix}.${key} must be a ${expectedType}`)
      continue
    }

    if (settingKey === "watch_debounce_ms" && typeof value === "number" && (!Number.isFinite(value) || value < 0)) {
      errors.push(`${pathPrefix}.${key} must be a non-negative finite number`)
      continue
    }

    if (harness !== null) {
      const settingPath: SettingPath = `codegraph.${settingKey}`
      if (!SETTING_HARNESS_SUPPORT[settingPath].includes(harness)) {
        errors.push(`${settingPath} is not supported for harness ${harness}`)
      }
    }
  }
}

function validateConfigBody(value: unknown, pathPrefix: string, harness: HarnessId | null, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push(`${pathPrefix} must be an object`)
    return
  }

  for (const [key, section] of Object.entries(value)) {
    if (key === "codegraph") {
      validateCodegraphSection(section, `${pathPrefix}.codegraph`, harness, errors)
      continue
    }

    if (isHarnessBlockKey(key)) {
      if (harness !== null) {
        errors.push(`${pathPrefix}.${key} cannot contain nested harness override blocks`)
        continue
      }

      const harnessId = HARNESS_BLOCK_KEYS[key]
      if (harnessId === undefined) {
        errors.push(`Unknown harness override block "${key}"`)
        continue
      }
      validateConfigBody(section, key, harnessId, errors)
      continue
    }

    errors.push(`${pathPrefix}.${key} is not a supported setting`)
  }
}

export function validateOmoConfig(value: unknown): OmoConfigValidationResult {
  const errors: string[] = []
  validateConfigBody(value, "config", null, errors)

  return {
    errors,
    ok: errors.length === 0,
  }
}
