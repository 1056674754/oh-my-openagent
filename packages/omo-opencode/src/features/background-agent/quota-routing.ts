import type { QuotaRoutingRule } from "../../config/schema/background-task"
import { buildFallbackChainFromModels } from "../../shared/fallback-chain-from-models"
import type { FallbackEntry } from "../../shared/model-requirements"
import type { DelegatedModelConfig } from "../../shared/model-resolution-types"
import type { LaunchInput } from "./types"

export type QuotaUsageSnapshot = {
  usedPercent: number
  resetAtMs: number
}

export type QuotaPaceDecision = {
  shouldRoute: boolean
  reason: "invalid-snapshot" | "grace-period" | "below-pace-limit" | "pace-limit-reached"
  elapsedSeconds: number
  expectedUsedPercent: number
  routeAtPercent: number
  usedPercent: number
}

export type QuotaUsageLoader = (args: {
  quotaProvider: QuotaRoutingRule["quotaProvider"]
  refreshIntervalSeconds: number
  requestTimeoutMs: number
}) => Promise<QuotaUsageSnapshot | null>

type QuotaRouterLogger = (message: string, details?: Record<string, unknown>) => void

type BackgroundQuotaRouterArgs = {
  rules: Record<string, QuotaRoutingRule>
  loadQuotaUsage: QuotaUsageLoader
  now?: () => number
  log?: QuotaRouterLogger
}

type MatchedQuotaRule = {
  requestedModel: string
  rule: QuotaRoutingRule
  isPrimary: boolean
}

export function evaluateQuotaPace(args: {
  snapshot: QuotaUsageSnapshot
  nowMs: number
  windowSeconds: number
  gracePeriodSeconds: number
  paceThresholdRatio: number
}): QuotaPaceDecision {
  const { snapshot, nowMs, windowSeconds, gracePeriodSeconds, paceThresholdRatio } = args
  const windowMs = windowSeconds * 1_000
  const resetAtMs = snapshot.resetAtMs
  const hasValidSnapshot = Number.isFinite(snapshot.usedPercent)
    && Number.isFinite(resetAtMs)
    && resetAtMs > nowMs

  if (!hasValidSnapshot) {
    return {
      shouldRoute: false,
      reason: "invalid-snapshot",
      elapsedSeconds: 0,
      expectedUsedPercent: 0,
      routeAtPercent: 0,
      usedPercent: snapshot.usedPercent,
    }
  }

  const windowStartMs = resetAtMs - windowMs
  const elapsedMs = Math.max(0, Math.min(windowMs, nowMs - windowStartMs))
  const elapsedSeconds = elapsedMs / 1_000
  const expectedUsedPercent = (elapsedMs / windowMs) * 100
  const routeAtPercent = expectedUsedPercent * paceThresholdRatio

  if (elapsedSeconds < gracePeriodSeconds) {
    return {
      shouldRoute: false,
      reason: "grace-period",
      elapsedSeconds,
      expectedUsedPercent,
      routeAtPercent,
      usedPercent: snapshot.usedPercent,
    }
  }

  const shouldRoute = snapshot.usedPercent >= routeAtPercent
  return {
    shouldRoute,
    reason: shouldRoute ? "pace-limit-reached" : "below-pace-limit",
    elapsedSeconds,
    expectedUsedPercent,
    routeAtPercent,
    usedPercent: snapshot.usedPercent,
  }
}

function toDelegatedModel(entry: FallbackEntry): DelegatedModelConfig | undefined {
  const providerID = entry.providers[0]
  if (!providerID || !entry.model) return undefined

  return {
    providerID,
    modelID: entry.model,
    variant: entry.variant,
    reasoningEffort: entry.reasoningEffort,
    temperature: entry.temperature,
    top_p: entry.top_p,
    maxTokens: entry.maxTokens,
    thinking: entry.thinking,
  }
}

function fallbackEntryModelKeys(entry: FallbackEntry): string[] {
  return entry.providers.map((providerID) => `${providerID}/${entry.model}`.toLowerCase())
}

function mergeFallbackChains(args: {
  configured: FallbackEntry[]
  existing: FallbackEntry[] | undefined
  excludedModels: Set<string>
}): FallbackEntry[] {
  const merged: FallbackEntry[] = []
  const seen = new Set<string>()

  for (const entry of [...args.configured, ...(args.existing ?? [])]) {
    const keys = fallbackEntryModelKeys(entry)
    if (keys.some((key) => args.excludedModels.has(key) || seen.has(key))) continue
    keys.forEach((key) => seen.add(key))
    merged.push(entry)
  }

  return merged
}

export class BackgroundQuotaRouter {
  private readonly rules: Map<string, QuotaRoutingRule>
  private readonly loadQuotaUsage: QuotaUsageLoader
  private readonly now: () => number
  private readonly logger?: QuotaRouterLogger

  constructor(args: BackgroundQuotaRouterArgs) {
    this.rules = new Map(
      Object.entries(args.rules).map(([model, rule]) => [model.toLowerCase(), rule]),
    )
    this.loadQuotaUsage = args.loadQuotaUsage
    this.now = args.now ?? Date.now
    this.logger = args.log
  }

  async route(input: LaunchInput): Promise<LaunchInput> {
    const match = this.findRule(input)
    if (!match || !match.rule.enabled) return input
    const { requestedModel, rule } = match

    let snapshot: QuotaUsageSnapshot | null
    try {
      snapshot = await this.loadQuotaUsage({
        quotaProvider: rule.quotaProvider,
        refreshIntervalSeconds: rule.refreshIntervalSeconds,
        requestTimeoutMs: rule.requestTimeoutMs,
      })
    } catch (error) {
      this.logger?.("[background-agent] Quota pacing lookup failed; keeping requested model", {
        requestedModel,
        error: error instanceof Error ? error.message : String(error),
      })
      return input
    }
    if (!snapshot) return input

    const decision = evaluateQuotaPace({
      snapshot,
      nowMs: this.now(),
      windowSeconds: rule.windowSeconds,
      gracePeriodSeconds: rule.gracePeriodSeconds,
      paceThresholdRatio: rule.paceThresholdRatio,
    })
    if (!decision.shouldRoute) return input

    const requestedProviderID = requestedModel.split("/")[0]
    const configuredChain = buildFallbackChainFromModels(rule.fallbackModels, requestedProviderID)
    if (!configuredChain) return input

    const excludedModels = new Set([requestedModel.toLowerCase()])
    if (!match.isPrimary) {
      const primaryModel = input.model
        ? `${input.model.providerID}/${input.model.modelID}`.toLowerCase()
        : undefined
      if (primaryModel) excludedModels.add(primaryModel)
      const fallbackChain = mergeFallbackChains({
        configured: configuredChain,
        existing: input.fallbackChain,
        excludedModels,
      })

      this.logger?.("[background-agent] Quota pace limit reached; replacing model in new task fallback chain", {
        requestedModel,
        usedPercent: decision.usedPercent,
        expectedUsedPercent: decision.expectedUsedPercent,
        routeAtPercent: decision.routeAtPercent,
        elapsedSeconds: decision.elapsedSeconds,
      })

      return { ...input, fallbackChain }
    }

    const nextModel = toDelegatedModel(configuredChain[0])
    if (!nextModel) return input
    excludedModels.add(`${nextModel.providerID}/${nextModel.modelID}`.toLowerCase())
    const fallbackChain = mergeFallbackChains({
      configured: configuredChain.slice(1),
      existing: input.fallbackChain,
      excludedModels,
    })

    this.logger?.("[background-agent] Quota pace limit reached; rerouting new task", {
      requestedModel,
      routedModel: `${nextModel.providerID}/${nextModel.modelID}`,
      usedPercent: decision.usedPercent,
      expectedUsedPercent: decision.expectedUsedPercent,
      routeAtPercent: decision.routeAtPercent,
      elapsedSeconds: decision.elapsedSeconds,
    })

    return {
      ...input,
      model: nextModel,
      fallbackChain,
    }
  }

  private findRule(input: LaunchInput): MatchedQuotaRule | undefined {
    if (input.model) {
      const requestedModel = `${input.model.providerID}/${input.model.modelID}`
      const rule = this.rules.get(requestedModel.toLowerCase())
      if (rule) return { requestedModel, rule, isPrimary: true }
    }

    for (const entry of input.fallbackChain ?? []) {
      for (const requestedModel of fallbackEntryModelKeys(entry)) {
        const rule = this.rules.get(requestedModel)
        if (rule) return { requestedModel, rule, isPrimary: false }
      }
    }

    return undefined
  }
}
