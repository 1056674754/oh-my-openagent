import { getSessionModel, type SessionModel } from "../../shared/session-model-state"
import { readVisionCapableModelsCache } from "../../shared/vision-capable-models-cache"

export type LookAtRoute = "direct" | "delegated"

export interface LookAtRouteDecision {
  readonly route: LookAtRoute
  readonly model?: SessionModel
}

export function resolveLookAtRoute(sessionID: string): LookAtRouteDecision {
  const model = getSessionModel(sessionID)
  if (!model) {
    return { route: "delegated" }
  }

  const supportsImageInput = readVisionCapableModelsCache().some(
    (candidate) => candidate.providerID === model.providerID && candidate.modelID === model.modelID,
  )

  return {
    route: supportsImageInput ? "direct" : "delegated",
    model,
  }
}
