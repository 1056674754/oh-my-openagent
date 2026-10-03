import { asSenpiThinkingLevel } from "../../senpi/thinking-level"
import {
  SESSION_START_FAILURE_REASONS,
  isTaskStartFailureReason,
  type TaskStartFailureReason,
} from "../../state"
import { RunnerError } from "../in-process/runner-error"
import type { RpcRunnerSpec } from "../types"
import { HostUnavailableError } from "./daemon"
import {
  HostSessionOpenError,
  SessionHeldElsewhereError,
  type OpenedHostSession,
} from "./session-client"
import { buildChildContext } from "./session-context"
import type { HostRetryFallbackProfile, HostSessionOpenInput } from "./session-transport"

const SESSION_FAILURE_REASONS = new Set<TaskStartFailureReason>(SESSION_START_FAILURE_REASONS)

export async function openTaskHostSession(input: {
  readonly client: { open(request: HostSessionOpenInput): Promise<OpenedHostSession> }
  readonly spec: RpcRunnerSpec
  readonly sessionPath: string
}): Promise<OpenedHostSession> {
  const model = splitModelRef(input.spec.model)
  const thinkingLevel = asSenpiThinkingLevel(input.spec.reasoning ?? input.spec.variant)
  try {
    return await input.client.open({
      sessionPath: input.sessionPath,
      cwd: input.spec.cwd,
      ...(model === undefined ? {} : model),
      ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
      ...buildChildContext(input.spec),
      retainOnDisconnect: true,
      autoTitle: false,
      retryFallback: childRetryFallback(input.spec),
    })
  } catch (error) {
    if (error instanceof HostUnavailableError) throw error
    const reason = sessionFailureReason(error)
    throw new RunnerError({
      kind: "session_unavailable",
      message: error instanceof Error ? error.message : String(error),
      ...(reason === undefined ? {} : { reason }),
      cause: error,
    })
  }
}

function sessionFailureReason(error: unknown): TaskStartFailureReason | undefined {
  if (error instanceof SessionHeldElsewhereError) return "session_path_in_use"
  if (
    error instanceof HostSessionOpenError &&
    isTaskStartFailureReason(error.code) &&
    SESSION_FAILURE_REASONS.has(error.code)
  ) {
    return error.code
  }
  if (error instanceof Error && error.message.startsWith("Timeout waiting for response to open_session.")) {
    return "open_timed_out"
  }
  return undefined
}

/**
 * The child's own fallback policy, as the in-process runner builds it (#6478): the chain after its model
 * when it has one, otherwise fallback off - never the host's settings, which are the user's, not the child's.
 */
function childRetryFallback(spec: RpcRunnerSpec): HostRetryFallbackProfile {
  const chain = spec.fallbackModels ?? []
  if (spec.model === undefined || chain.length === 0) return { modelFallback: false, fallbackChains: {} }
  return { modelFallback: true, fallbackChains: { [spec.model]: [...chain] } }
}

function splitModelRef(model: string | undefined): { readonly provider: string; readonly modelId: string } | undefined {
  if (model === undefined) return undefined
  const separator = model.indexOf("/")
  if (separator <= 0 || separator === model.length - 1) return undefined
  return { provider: model.slice(0, separator), modelId: model.slice(separator + 1) }
}
