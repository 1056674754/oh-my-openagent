import { isRecord } from "@oh-my-opencode/utils"
import type { PluginInput } from "@opencode-ai/plugin"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { getDataDir } from "../../shared/data-path"
import type { QuotaUsageLoader, QuotaUsageSnapshot } from "./quota-routing"

const ZHIPU_QUOTA_URL = "https://open.bigmodel.cn/api/monitor/usage/quota/limit"
const ZHIPU_PROVIDER_ALIASES = ["zhipuai-coding-plan", "zhipuai", "zhipu"]

type LoaderLogger = (message: string, details?: Record<string, unknown>) => void

type ZhipuQuotaUsageLoaderArgs = {
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

function findProviderEntry(providerConfig: unknown): unknown {
  if (!isRecord(providerConfig)) return undefined
  for (const alias of ZHIPU_PROVIDER_ALIASES) {
    if (providerConfig[alias]) return providerConfig[alias]
  }
  return undefined
}

function findAuthEntry(auth: unknown): unknown {
  if (!isRecord(auth)) return undefined
  for (const alias of ZHIPU_PROVIDER_ALIASES) {
    if (auth[alias]) return auth[alias]
  }
  for (const alias of ZHIPU_PROVIDER_ALIASES) {
    const matchingKey = Object.keys(auth).find((key) => key.startsWith(`${alias}-`))
    if (matchingKey) return auth[matchingKey]
  }
  return undefined
}

function extractConfigApiKey(configResult: unknown): string | undefined {
  if (!isRecord(configResult) || !isRecord(configResult.data)) return undefined
  const providerEntry = findProviderEntry(configResult.data.provider)
  if (!isRecord(providerEntry) || !isRecord(providerEntry.options)) return undefined
  return readStringField(providerEntry.options, "apiKey")
}

function extractAuthApiKey(auth: unknown): string | undefined {
  const entry = findAuthEntry(auth)
  return readStringField(entry, "key") ?? readStringField(entry, "token")
}

function normalizeTimestamp(value: number): number {
  return value < 1_000_000_000_000 ? value * 1_000 : value
}

export function parseZhipuQuotaPayload(payload: unknown): QuotaUsageSnapshot | null {
  if (!isRecord(payload) || !isRecord(payload.data) || !Array.isArray(payload.data.limits)) {
    return null
  }

  for (const limit of payload.data.limits) {
    if (!isRecord(limit) || limit.type !== "TOKENS_LIMIT") continue
    if (typeof limit.percentage !== "number" || typeof limit.nextResetTime !== "number") {
      return null
    }
    return {
      usedPercent: limit.percentage,
      resetAtMs: normalizeTimestamp(limit.nextResetTime),
    }
  }

  return null
}

export class ZhipuQuotaUsageLoader {
  private readonly client: PluginInput["client"]
  private readonly now: () => number
  private readonly fetchRequest: typeof fetch
  private readonly logger?: LoaderLogger
  private readonly readAuth: () => Promise<unknown>
  private cache?: QuotaCache
  private inFlight?: Promise<QuotaUsageSnapshot | null>

  constructor(args: ZhipuQuotaUsageLoaderArgs) {
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
    if (args.quotaProvider !== "zhipuai-coding-plan") return null

    const nowMs = this.now()
    const cacheIsFresh = this.cache
      && this.cache.snapshot.resetAtMs > nowMs
      && nowMs - this.cache.fetchedAtMs < args.refreshIntervalSeconds * 1_000
    if (cacheIsFresh) return this.cache?.snapshot ?? null
    if (this.inFlight) return this.inFlight

    this.inFlight = this.refresh(args.requestTimeoutMs)
      .finally(() => {
        this.inFlight = undefined
      })
    return this.inFlight
  }

  private async resolveApiKey(): Promise<string | undefined> {
    try {
      const configResult: unknown = await this.client.config.get()
      const apiKey = extractConfigApiKey(configResult)
      if (apiKey) return apiKey
    } catch (error) {
      this.logger?.("[background-agent] Failed to read Zhipu provider config for quota pacing", {
        error: error instanceof Error ? error.message : String(error),
      })
    }

    try {
      return extractAuthApiKey(await this.readAuth())
    } catch (error) {
      this.logger?.("[background-agent] Failed to read Zhipu auth for quota pacing", {
        error: error instanceof Error ? error.message : String(error),
      })
      return undefined
    }
  }

  private async refresh(requestTimeoutMs: number): Promise<QuotaUsageSnapshot | null> {
    try {
      const apiKey = await this.resolveApiKey()
      if (!apiKey) return this.validStaleSnapshot()

      const response = await this.fetchRequest(ZHIPU_QUOTA_URL, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        signal: AbortSignal.timeout(requestTimeoutMs),
      })
      if (!response.ok) {
        this.logger?.("[background-agent] Zhipu quota request failed", { status: response.status })
        return this.validStaleSnapshot()
      }

      const snapshot = parseZhipuQuotaPayload(await response.json())
      if (!snapshot || snapshot.resetAtMs <= this.now()) return this.validStaleSnapshot()

      this.cache = { snapshot, fetchedAtMs: this.now() }
      return snapshot
    } catch (error) {
      this.logger?.("[background-agent] Zhipu quota request failed", {
        error: error instanceof Error ? error.message : String(error),
      })
      return this.validStaleSnapshot()
    }
  }

  private validStaleSnapshot(): QuotaUsageSnapshot | null {
    if (!this.cache || this.cache.snapshot.resetAtMs <= this.now()) return null
    return this.cache.snapshot
  }
}
