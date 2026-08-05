import type { AutoRetryHelpers } from "./auto-retry"
import type { AutoRetryDispatchOutcome, HookDeps, FallbackState } from "./types"
import { HOOK_NAME } from "./constants"
import { log } from "../../shared/logger"
import { prepareFallback } from "./fallback-state"
import { restoreFallbackState, snapshotFallbackState } from "./fallback-state-snapshot"
import { getFallbackApprovalRequester } from "./fallback-approval"

type DispatchFallbackRetryOptions = {
  sessionID: string
  state: FallbackState
  fallbackModels: string[]
  resolvedAgent?: string
  source: string
  abortBeforeDispatch?: boolean
  abortSource?: string
}

function resolveDispatchMessage(result: AutoRetryDispatchOutcome, newModel: string): string {
  const modelName = newModel.split("/").pop() || newModel
  if (result.status === "queued") return `Fallback queued for ${modelName}`
  if (result.status === "possibly-accepted") return `Fallback dispatch may have been accepted for ${modelName}`
  return `Switched to ${modelName} for next request`
}

export async function dispatchFallbackRetry(
  deps: HookDeps,
  helpers: AutoRetryHelpers,
  options: DispatchFallbackRetryOptions,
): Promise<void> {
  const snapshot = snapshotFallbackState(options.state)
  const unavailableModels = new Set<string>()
  let exhaustedAllCandidates = false

  while (true) {
    const result = prepareFallback(
      options.sessionID,
      options.state,
      options.fallbackModels,
      deps.config,
    )

    if (!result.success || !result.newModel) {
      log(`[${HOOK_NAME}] Fallback preparation failed`, {
        sessionID: options.sessionID,
        source: options.source,
        error: result.error,
      })
      exhaustedAllCandidates = true
      break
    }

    const approval = await getFallbackApprovalRequester(deps).request(
      options.sessionID,
      snapshot.currentModel,
      result.newModel,
      options.source,
    )
    if (approval.action === "skip") {
      unavailableModels.add(result.newModel)
      restoreFallbackState(options.state, snapshot)
      const failedAt = Date.now()
      for (const model of unavailableModels) {
        options.state.failedModels.set(model, failedAt)
      }
      log(`[${HOOK_NAME}] Skipping fallback candidate after quota preflight`, {
        sessionID: options.sessionID,
        model: result.newModel,
      })
      continue
    }
    if (approval.action === "cancel") {
      restoreFallbackState(options.state, snapshot)
      log(`[${HOOK_NAME}] Fallback cancelled by user or resumed model progress`, {
        sessionID: options.sessionID,
        source: options.source,
        reason: approval.reason,
      })
      return
    }

    if (options.abortBeforeDispatch) {
      await helpers.abortSessionRequest(
        options.sessionID,
        options.abortSource ?? `${options.source}.approved-fallback`,
      )
      deps.sessionRetryInFlight.delete(options.sessionID)
    }

    const rawDispatchOutcome = await helpers.autoRetryWithFallback(
      options.sessionID,
      result.newModel,
      options.resolvedAgent,
      options.source,
    )
    const dispatchOutcome = rawDispatchOutcome ?? {
      accepted: true,
      status: "dispatched",
    }
    if (rawDispatchOutcome === undefined) {
      log(`[${HOOK_NAME}] Fallback dispatch returned no outcome; treating as accepted for compatibility`, {
        sessionID: options.sessionID,
        source: options.source,
      })
    }
    if (!dispatchOutcome.accepted) {
      restoreFallbackState(options.state, snapshot)
      const failedAt = Date.now()
      for (const model of unavailableModels) {
        options.state.failedModels.set(model, failedAt)
      }
      log(`[${HOOK_NAME}] Fallback dispatch was not accepted`, {
        sessionID: options.sessionID,
        source: options.source,
        status: dispatchOutcome.status,
        reason: dispatchOutcome.reason,
      })
      if (deps.config.notify_on_fallback) {
        await deps.ctx.client.tui
          .showToast({
            body: {
              title: "Fallback Dispatch Failed",
              message: `Could not switch to ${result.newModel}: ${dispatchOutcome.reason ?? dispatchOutcome.status}. Please retry or select a model manually.`,
              variant: "error",
              duration: 10000,
            },
          })
          .catch(() => {})
      }
      return
    }
    if (deps.config.notify_on_fallback) {
      await deps.ctx.client.tui
        .showToast({
          body: {
            title: "Model Fallback",
            message: resolveDispatchMessage(dispatchOutcome, result.newModel),
            variant: "warning",
            duration: 5000,
          },
        })
        .catch(() => {})
    }
    return
  }

  // All fallback candidates exhausted — never silence this from the user.
  if (exhaustedAllCandidates) {
    const exhaustedList =
      unavailableModels.size > 0
        ? Array.from(unavailableModels).join(", ")
        : "no fallback models were available"
    log(`[${HOOK_NAME}] All fallback candidates exhausted`, {
      sessionID: options.sessionID,
      source: options.source,
      unavailableModels: Array.from(unavailableModels),
    })
    if (deps.config.notify_on_fallback) {
      await deps.ctx.client.tui
        .showToast({
          body: {
            title: "All Fallback Models Exhausted",
            message: `Primary model and all fallback candidates failed (${exhaustedList}). Please recharge quota or select a different model manually.`,
            variant: "error",
            duration: 15000,
          },
        })
        .catch(() => {})
    }
  }
}
