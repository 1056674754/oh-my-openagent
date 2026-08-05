import { HOOK_NAME } from "./constants"
import { log } from "../../shared/logger"
import type { HookDeps } from "./types"

const APPROVAL_TIMEOUT_MS = 30_000

export type FallbackApprovalDecision =
  | { action: "proceed"; reason: "approved" | "timeout" | "bridge-unavailable" }
  | { action: "skip"; reason: "quota-exhausted" }
  | { action: "cancel"; reason: "rejected" | "request-cancelled" }

type RuntimeFallbackApprovalResponse = {
  decision?: unknown
  preflight?: {
    status?: unknown
  }
}

type RuntimeFallbackApprovalEnvironment = {
  OPENCHAMBER_RUNTIME_FALLBACK_URL?: string
  OPENCHAMBER_AGENT_TOOL_TOKEN?: string
}

type FallbackApprovalRequester = ReturnType<typeof createFallbackApprovalRequester>
const requesters = new WeakMap<HookDeps, FallbackApprovalRequester>()

function defaultEnvironment(): RuntimeFallbackApprovalEnvironment {
  if (typeof process === "undefined") return {}
  return {
    OPENCHAMBER_RUNTIME_FALLBACK_URL: process.env.OPENCHAMBER_RUNTIME_FALLBACK_URL,
    OPENCHAMBER_AGENT_TOOL_TOKEN: process.env.OPENCHAMBER_AGENT_TOOL_TOKEN,
  }
}

export function createFallbackApprovalRequester(
  deps: HookDeps,
  fetchFn: typeof fetch = fetch,
  environment: RuntimeFallbackApprovalEnvironment = defaultEnvironment(),
) {
  const controllers = new Map<string, AbortController>()

  const cancel = (sessionID: string) => {
    const controller = controllers.get(sessionID)
    if (!controller) return
    controllers.delete(sessionID)
    controller.abort()
  }

  const request = async (
    sessionID: string,
    currentModel: string,
    candidateModel: string,
    source: string,
  ): Promise<FallbackApprovalDecision> => {
    const endpoint = environment.OPENCHAMBER_RUNTIME_FALLBACK_URL
    const token = environment.OPENCHAMBER_AGENT_TOOL_TOKEN
    if (!endpoint || !token) {
      return { action: "proceed", reason: "bridge-unavailable" }
    }

    cancel(sessionID)
    const controller = new AbortController()
    controllers.set(sessionID, controller)

    try {
      const response = await fetchFn(endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          sessionID,
          directory: deps.ctx.directory,
          currentModel,
          candidateModel,
          source,
          timeoutMs: APPROVAL_TIMEOUT_MS,
        }),
        signal: controller.signal,
      })
      if (!response.ok) {
        log(`[${HOOK_NAME}] OpenChamber fallback approval bridge returned ${response.status}`, {
          sessionID,
          candidateModel,
        })
        return { action: "proceed", reason: "bridge-unavailable" }
      }

      const result = await response.json() as RuntimeFallbackApprovalResponse
      if (result.decision === "unavailable" && result.preflight?.status === "exhausted") {
        return { action: "skip", reason: "quota-exhausted" }
      }
      if (result.decision === "rejected") {
        return { action: "cancel", reason: "rejected" }
      }
      if (result.decision === "cancelled") {
        return { action: "cancel", reason: "request-cancelled" }
      }
      if (result.decision === "timeout") {
        return { action: "proceed", reason: "timeout" }
      }
      if (result.decision === "approved") {
        return { action: "proceed", reason: "approved" }
      }

      return { action: "proceed", reason: "bridge-unavailable" }
    } catch (error) {
      if (controller.signal.aborted) {
        return { action: "cancel", reason: "request-cancelled" }
      }
      log(`[${HOOK_NAME}] OpenChamber fallback approval bridge failed`, {
        sessionID,
        candidateModel,
        error: error instanceof Error ? error.message : String(error),
      })
      return { action: "proceed", reason: "bridge-unavailable" }
    } finally {
      if (controllers.get(sessionID) === controller) {
        controllers.delete(sessionID)
      }
    }
  }

  return {
    request,
    cancel,
    dispose: () => {
      for (const controller of controllers.values()) {
        controller.abort()
      }
      controllers.clear()
    },
  }
}

export function getFallbackApprovalRequester(deps: HookDeps): FallbackApprovalRequester {
  const existing = requesters.get(deps)
  if (existing) return existing
  const requester = createFallbackApprovalRequester(deps)
  requesters.set(deps, requester)
  return requester
}

export function cancelFallbackApproval(deps: HookDeps, sessionID: string): void {
  requesters.get(deps)?.cancel(sessionID)
}

export function disposeFallbackApprovalRequester(deps: HookDeps): void {
  const requester = requesters.get(deps)
  if (!requester) return
  requester.dispose()
  requesters.delete(deps)
}
