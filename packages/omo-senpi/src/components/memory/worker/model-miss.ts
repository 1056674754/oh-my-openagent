import { isContextOverflowMessage, isRetryableModelError } from "@oh-my-opencode/model-core"

export type ModelMissResult = {
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string
  readonly timedOut: boolean
}

export type RetryableModelMiss =
  | { readonly kind: "model_not_visible"; readonly id: string }
  | { readonly kind: "auth_missing"; readonly provider: string }
  | { readonly kind: "context_overflow"; readonly detail: string }
  | { readonly kind: "provider_unavailable"; readonly detail: string }

const MODEL_NOT_FOUND_PATTERN = /^Error: Model "([^"]+)" not found\. Use --list-models to see available models\.$/m
const API_KEY_NOT_FOUND_PATTERN = /^(?:Error:\s*)?No API key found for\s+([^\s.]+)/m
const HTTP_STATUS_PATTERN = /(?:^|\s)(\d{3})\s*:/
const PROVIDER_DETAIL_MAX_CHARS = 200

export function classifyRetryableModelMiss(result: ModelMissResult): RetryableModelMiss | undefined {
  if (result.timedOut || result.code === 0) return undefined
  const output = `${result.stderr}\n${result.stdout}`
  const model = MODEL_NOT_FOUND_PATTERN.exec(output)?.[1]
  if (model !== undefined) return { kind: "model_not_visible", id: model }
  const provider = API_KEY_NOT_FOUND_PATTERN.exec(output)?.[1]
  if (provider !== undefined) return { kind: "auth_missing", provider }
  const detail = providerFailureDetail(result)
  if (detail === undefined) return undefined
  if (isContextOverflowMessage(detail)) return { kind: "context_overflow", detail }
  // A provider-side outage or a spent usage/quota limit says nothing about THIS model being wrong,
  // so the reflection chain moves to the next candidate instead of recording a dead run. The shared
  // classifier owns the pattern table; only a quota the provider marks as terminal stays a stop.
  const statusCode = Number.parseInt(HTTP_STATUS_PATTERN.exec(detail)?.[1] ?? "", 10)
  return isRetryableModelError({
    message: detail,
    ...(Number.isNaN(statusCode) ? {} : { statusCode }),
  })
    ? { kind: "provider_unavailable", detail }
    : undefined
}

/**
 * A line shaped like the failure itself: an HTTP status answer (`503: ...`), a provider JSON error
 * body, or an `Error`/`TypeError`/`ENOENT`-style line. Picked over any line printed before it.
 */
const ERROR_SHAPED = /^(?:\d{3}\s*:|\{.*"(?:error|message|type)"|[A-Z][A-Za-z]*(?:Error|Exception)\b|[Ee]rror\b|[Ff]atal\b|E[A-Z]{2,}\b)/

/**
 * A runtime reporting on itself (Bun on win32 prints `child reaper unavailable under Bun on win32:
 * ...` once per terminated worker thread, before any real error). It is never the provider's answer,
 * so it can never make a child look like a provider outage on its own (#9553).
 */
const RUNTIME_ADVISORY = /\bunder (?:Bun|Node(?:\.js)?|Deno)\b/i

/**
 * The child's failure line: the first error-shaped line, else the first line that is not a runtime
 * advisory. senpi prints the fatal provider error and exits, but a runtime may print notices first.
 */
function providerFailureDetail(result: ModelMissResult): string | undefined {
  for (const stream of [result.stderr, result.stdout]) {
    const lines = stream.split("\n").map((entry) => entry.trim()).filter((entry) => entry.length > 0)
    const line = lines.find((entry) => ERROR_SHAPED.test(entry)) ?? lines.find((entry) => !RUNTIME_ADVISORY.test(entry))
    if (line !== undefined) return line.slice(0, PROVIDER_DETAIL_MAX_CHARS)
  }
  return undefined
}

export function isRetryableModelMiss(result: ModelMissResult): boolean {
  return classifyRetryableModelMiss(result) !== undefined
}
