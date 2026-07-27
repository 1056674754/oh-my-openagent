import type { QuotaRoutingRule } from "../../config/schema/background-task"
import { buildFallbackChainFromModels } from "../../shared/fallback-chain-from-models"
import type { FallbackEntry } from "../../shared/model-requirements"
import type { DelegatedModelConfig } from "../../shared/model-resolution-types"
import type { LaunchInput } from "./types"

export type QuotaUsageWindowSnapshot = {
  windowSeconds: number
  usedPercent: number
  resetAtMs: number
}

export type QuotaUsageSnapshot = {
  windows: QuotaUsageWindowSnapshot[]
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

type ExceededQuotaWindow = { windowSeconds: number; decision: QuotaPaceDecision }

export function evaluateQuotaPace(args: {
  snapshot: QuotaUsageWindowSnapshot
  nowMs: number
  gracePeriodSeconds: number
  paceThresholdRatio: number
}): QuotaPaceDecision {
  const { snapshot, nowMs, gracePeriodSeconds, paceThresholdRatio } = args
  const windowMs = snapshot.windowSeconds * 1_000
  const hasValidSnapshot = Number.isFinite(snapshot.usedPercent)
    && snapshot.usedPercent >= 0
    && snapshot.usedPercent <= 100
    && Number.isFinite(snapshot.resetAtMs)
    && Number.isFinite(windowMs)
    && windowMs > 0
    && snapshot.resetAtMs > nowMs

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

  const windowStartMs = snapshot.resetAtMs - windowMs
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
    appendUniqueFallback(merged, entry, seen, args.excludedModels)
  }

  return merged
}

function appendUniqueFallback(
  target: FallbackEntry[],
  entry: FallbackEntry,
  seen: Set<string>,
  excludedModels: Set<string>,
): void {
  const providers = entry.providers.filter((providerID) => {
    const key = `${providerID}/${entry.model}`.toLowerCase()
    return !excludedModels.has(key) && !seen.has(key)
  })
  if (providers.length === 0) return
  providers.forEach((providerID) => seen.add(`${providerID}/${entry.model}`.toLowerCase()))
  target.push(providers.length === entry.providers.length ? entry : { ...entry, providers })
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
    let routed = await this.routePrimary(input)
    routed = await this.routeFallbacks(routed)
    return routed
  }

  private async routePrimary(input: LaunchInput): Promise<LaunchInput> {
    if (!input.model) return input
    const requestedModel = `${input.model.providerID}/${input.model.modelID}`
    const rule = this.rules.get(requestedModel.toLowerCase())
    if (!rule?.enabled) return input
    const exceeded = await this.findExceededWindow(requestedModel, rule)
    if (!exceeded) return input

    const configuredChain = buildFallbackChainFromModels(rule.fallbackModels, input.model.providerID)
    if (!configuredChain) return input
    const nextModel = toDelegatedModel(configuredChain[0])
    if (!nextModel) return input

    const excludedModels = new Set([
      requestedModel.toLowerCase(),
      `${nextModel.providerID}/${nextModel.modelID}`.toLowerCase(),
    ])
    const fallbackChain = mergeFallbackChains({
      configured: configuredChain.slice(1),
      existing: input.fallbackChain,
      excludedModels,
    })

    this.logRoute("rerouting new task", requestedModel, exceeded, `${nextModel.providerID}/${nextModel.modelID}`)
    return { ...input, model: nextModel, fallbackChain }
  }

  private async routeFallbacks(input: LaunchInput): Promise<LaunchInput> {
    if (!input.fallbackChain?.length) return input
    const primaryModel = input.model
      ? `${input.model.providerID}/${input.model.modelID}`.toLowerCase()
      : undefined
    const excludedModels = new Set(primaryModel ? [primaryModel] : [])
    const seen = new Set<string>()
    const fallbackChain: FallbackEntry[] = []
    let changed = false

    for (const entry of input.fallbackChain) {
      const replacements = new Map<string, FallbackEntry[]>()
      for (const providerID of entry.providers) {
        const requestedModel = `${providerID}/${entry.model}`
        const requestedKey = requestedModel.toLowerCase()
        const rule = this.rules.get(requestedKey)
        if (!rule?.enabled || seen.has(requestedKey)) continue
        const exceeded = await this.findExceededWindow(requestedModel, rule)
        if (!exceeded) continue
        const configuredChain = buildFallbackChainFromModels(rule.fallbackModels, providerID)
        if (!configuredChain) continue
        replacements.set(providerID, configuredChain)
        excludedModels.add(requestedKey)
        changed = true
        this.logRoute("replacing model in new task fallback chain", requestedModel, exceeded)
      }

      if (replacements.size === 0) {
        appendUniqueFallback(fallbackChain, entry, seen, excludedModels)
        continue
      }

      let untouchedProviders: string[] = []
      const flushUntouched = (): void => {
        if (untouchedProviders.length === 0) return
        appendUniqueFallback(fallbackChain, { ...entry, providers: untouchedProviders }, seen, excludedModels)
        untouchedProviders = []
      }
      for (const providerID of entry.providers) {
        const replacement = replacements.get(providerID)
        if (!replacement) {
          untouchedProviders.push(providerID)
          continue
        }
        flushUntouched()
        for (const replacementEntry of replacement) {
          appendUniqueFallback(fallbackChain, replacementEntry, seen, excludedModels)
        }
      }
      flushUntouched()
    }

    return changed ? { ...input, fallbackChain } : input
  }

  private async findExceededWindow(
    requestedModel: string,
    rule: QuotaRoutingRule,
  ): Promise<ExceededQuotaWindow | undefined> {
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
      return undefined
    }
    if (!snapshot) return undefined

    const nowMs = this.now()
    const decisions: ExceededQuotaWindow[] = []
    for (const window of rule.windows) {
      const matchingWindows = snapshot.windows.filter(
        (candidate) => candidate.windowSeconds === window.windowSeconds,
      )
      if (matchingWindows.length !== 1) return undefined
      const observed = matchingWindows[0]
      const decision = evaluateQuotaPace({
        snapshot: observed,
        nowMs,
        gracePeriodSeconds: window.gracePeriodSeconds,
        paceThresholdRatio: window.paceThresholdRatio,
      })
      if (decision.reason === "invalid-snapshot") return undefined
      decisions.push({ windowSeconds: window.windowSeconds, decision })
    }
    return decisions.find(({ decision }) => decision.shouldRoute)
  }

  private logRoute(
    action: string,
    requestedModel: string,
    exceeded: ExceededQuotaWindow,
    routedModel?: string,
  ): void {
    this.logger?.(`[background-agent] Quota pace limit reached; ${action}`, {
      requestedModel,
      ...(routedModel ? { routedModel } : {}),
      windowSeconds: exceeded.windowSeconds,
      usedPercent: exceeded.decision.usedPercent,
      expectedUsedPercent: exceeded.decision.expectedUsedPercent,
      routeAtPercent: exceeded.decision.routeAtPercent,
      elapsedSeconds: exceeded.decision.elapsedSeconds,
    })
  }

}
