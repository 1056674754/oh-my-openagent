import { isRecord } from "@oh-my-opencode/utils"
import type { PluginInput } from "@opencode-ai/plugin"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { getDataDir } from "../../shared/data-path"
import type { QuotaUsageLoader, QuotaUsageSnapshot } from "./quota-routing"
import { readQuotaResponseJson } from "./quota-response-reader"
import { parseKimiQuotaPayload, parseZhipuQuotaPayload } from "./quota-usage-parser"
export { parseKimiQuotaPayload, parseZhipuQuotaPayload } from "./quota-usage-parser"

const QUOTA_URL_BY_PROVIDER = {
  "kimi-for-coding": "https://api.kimi.com/coding/v1/usages",
  "zai-coding-plan": "https://api.z.ai/api/monitor/usage/quota/limit",
  "zhipuai-coding-plan": "https://open.bigmodel.cn/api/monitor/usage/quota/limit",
} as const

type QuotaProvider = keyof typeof QUOTA_URL_BY_PROVIDER

type LoaderLogger = (message: string, details?: Record<string, unknown>) => void

type ProviderQuotaUsageLoaderArgs = {
  client: PluginInput["client"]
  now?: () => number
  fetch?: typeof fetch
  log?: LoaderLogger
  readAuthFile?: () => Promise<unknown>
}

type QuotaCache = {
  snapshot: QuotaUsageSnapshot
  fetchedAtMs: number
}

function readStringField(value: unknown, field: string): string | undefined {
  if (!isRecord(value)) return undefined
  const candidate = value[field]
  return typeof candidate === "string" && candidate.length > 0 ? candidate : undefined
}

function findProviderEntry(providerConfig: unknown, provider: QuotaProvider): unknown {
  if (!isRecord(providerConfig)) return undefined
  return providerConfig[provider]
}

function findAuthEntry(auth: unknown, provider: QuotaProvider): unknown {
  if (!isRecord(auth)) return undefined
  return auth[provider]
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`Quota lookup timed out after ${timeoutMs}ms`)), timeoutMs)
    timer.unref?.()
  })

  try {
    return await Promise.race([operation, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

type ConfigApiKeyResult = { blocked: boolean; apiKey?: string }

function endpointOverrideBlocks(
  source: Record<string, unknown>,
  field: string,
  expectedURL: string,
): boolean {
  if (!Object.hasOwn(source, field)) return false
  const value = source[field]
  if (typeof value !== "string" || value.trim() === "") return true
  try {
    return new URL(value).origin !== new URL(expectedURL).origin
  } catch {
    return true
  }
}

function providerImplementationOverrideBlocks(
  providerEntry: Record<string, unknown>,
  expectedURL: string,
): boolean {
  if (Object.hasOwn(providerEntry, "npm")) return true
  if (!Object.hasOwn(providerEntry, "models")) return false
  if (!isRecord(providerEntry.models)) return true

  for (const modelEntry of Object.values(providerEntry.models)) {
    if (!isRecord(modelEntry)) return true
    if (!Object.hasOwn(modelEntry, "provider")) continue
    if (!isRecord(modelEntry.provider)) return true
    if (Object.hasOwn(modelEntry.provider, "npm")) return true
    if (endpointOverrideBlocks(modelEntry.provider, "api", expectedURL)) return true
  }

  return false
}

function extractConfigApiKey(configResult: unknown, provider: QuotaProvider): ConfigApiKeyResult {
  if (!isRecord(configResult) || !isRecord(configResult.data)) return { blocked: false }
  if (Object.hasOwn(configResult.data, "provider") && !isRecord(configResult.data.provider)) {
    return { blocked: true }
  }
  const providerEntry = findProviderEntry(configResult.data.provider, provider)
  if (providerEntry === undefined) return { blocked: false }
  if (!isRecord(providerEntry)) return { blocked: true }
  if (endpointOverrideBlocks(providerEntry, "api", QUOTA_URL_BY_PROVIDER[provider])) {
    return { blocked: true }
  }
  if (providerImplementationOverrideBlocks(providerEntry, QUOTA_URL_BY_PROVIDER[provider])) {
    return { blocked: true }
  }
  if (!isRecord(providerEntry.options)) {
    return { blocked: Object.hasOwn(providerEntry, "options") }
  }
  if (endpointOverrideBlocks(providerEntry.options, "baseURL", QUOTA_URL_BY_PROVIDER[provider])) {
    return { blocked: true }
  }
  return { blocked: false, apiKey: readStringField(providerEntry.options, "apiKey") }
}

function extractAuthApiKey(auth: unknown, provider: QuotaProvider): string | undefined {
  const entry = findAuthEntry(auth, provider)
  if (typeof entry === "string") return entry
  return readStringField(entry, "key") ?? readStringField(entry, "token")
}

export class ProviderQuotaUsageLoader {
  private readonly client: PluginInput["client"]
  private readonly now: () => number
  private readonly fetchRequest: typeof fetch
  private readonly logger?: LoaderLogger
  private readonly readAuth: () => Promise<unknown>
  private readonly cache = new Map<string, QuotaCache>()
  private readonly failedAt = new Map<string, number>()
  private readonly inFlight = new Map<string, Promise<QuotaUsageSnapshot | null>>()

  constructor(args: ProviderQuotaUsageLoaderArgs) {
    this.client = args.client
    this.now = args.now ?? Date.now
    this.fetchRequest = args.fetch ?? fetch
    this.logger = args.log
    this.readAuth = args.readAuthFile ?? (async () => {
      const raw = await readFile(join(getDataDir(), "opencode", "auth.json"), "utf8")
      return JSON.parse(raw)
    })
  }

  readonly load: QuotaUsageLoader = async (args) => {
    const provider = args.quotaProvider
    const nowMs = this.now()
    const lastFailureAt = this.failedAt.get(provider)
    if (lastFailureAt !== undefined && nowMs - lastFailureAt < args.refreshIntervalSeconds * 1_000) {
      return null
    }
    const cached = this.cache.get(provider)
    if (cached && nowMs - cached.fetchedAtMs < args.refreshIntervalSeconds * 1_000) {
      const valid = this.onlyUnexpired(cached.snapshot)
      if (valid) return valid
    }

    const pending = this.inFlight.get(provider)
    if (pending) {
      try {
        return await withTimeout(pending, args.requestTimeoutMs)
      } catch (error) {
        this.logger?.("[background-agent] Shared quota lookup exceeded caller timeout; keeping requested model", {
          provider,
          error: error instanceof Error ? error.message : String(error),
        })
        return null
      }
    }
    const refresh = this.refresh(provider, args.requestTimeoutMs).finally(() => {
      this.inFlight.delete(provider)
    })
    this.inFlight.set(provider, refresh)
    return refresh
  }

  private async resolveApiKey(provider: QuotaProvider): Promise<string | undefined> {
    try {
      const configResult: unknown = await this.client.config.get()
      if (!isRecord(configResult) || configResult.error != null || !isRecord(configResult.data)) {
        this.logger?.("[background-agent] Provider config lookup returned an error; keeping requested model", {
          provider,
        })
        return undefined
      }
      const configKey = extractConfigApiKey(configResult, provider)
      if (configKey.blocked) {
        this.logger?.("[background-agent] Custom provider base URL disables vendor quota lookup", { provider })
        return undefined
      }
      if (configKey.apiKey) return configKey.apiKey
    } catch (error) {
      this.logger?.("[background-agent] Failed to read provider config for quota pacing", {
        provider,
        error: error instanceof Error ? error.message : String(error),
      })
      return undefined
    }

    try {
      return extractAuthApiKey(await this.readAuth(), provider)
    } catch (error) {
      this.logger?.("[background-agent] Failed to read provider auth for quota pacing", {
        provider,
        error: error instanceof Error ? error.message : String(error),
      })
      return undefined
    }
  }

  private async refresh(
    provider: QuotaProvider,
    requestTimeoutMs: number,
  ): Promise<QuotaUsageSnapshot | null> {
    const controller = new AbortController()
    try {
      const valid = await withTimeout(
        this.fetchQuotaSnapshot(provider, controller.signal),
        requestTimeoutMs,
      )
      if (!valid) return this.recordFailure(provider)

      this.cache.set(provider, { snapshot: valid, fetchedAtMs: this.now() })
      this.failedAt.delete(provider)
      return valid
    } catch (error) {
      this.logger?.("[background-agent] Quota request failed", {
        provider,
        error: error instanceof Error ? error.message : String(error),
      })
      controller.abort()
      return this.recordFailure(provider)
    }
  }

  private async fetchQuotaSnapshot(
    provider: QuotaProvider,
    signal: AbortSignal,
  ): Promise<QuotaUsageSnapshot | null> {
    const apiKey = await this.resolveApiKey(provider)
    if (!apiKey || signal.aborted) return null
    const url = QUOTA_URL_BY_PROVIDER[provider]
    const response = await this.fetchRequest(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      signal,
    })
    if (!response.ok) {
      this.logger?.("[background-agent] Quota request failed", { provider, status: response.status })
      return null
    }

    const payload = await readQuotaResponseJson(response)
    if (payload === null) return null
    if (signal.aborted) return null
    const snapshot = provider === "kimi-for-coding"
      ? parseKimiQuotaPayload(payload)
      : parseZhipuQuotaPayload(payload)
    return snapshot ? this.onlyUnexpired(snapshot) : null
  }

  private onlyUnexpired(snapshot: QuotaUsageSnapshot): QuotaUsageSnapshot | null {
    const windows = snapshot.windows.filter((window) => window.resetAtMs > this.now())
    return windows.length > 0 ? { windows } : null
  }

  private recordFailure(provider: string): null {
    this.cache.delete(provider)
    this.failedAt.set(provider, this.now())
    return null
  }
}
