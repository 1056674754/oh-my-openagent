import { DesktopEngineAbiMismatchError } from "@oh-my-opencode/senpi-desktop-engine"
import {
  DesktopEngineUnavailableError,
  DesktopService,
  type DesktopSessionOpenParams,
} from "@oh-my-opencode/senpi-desktop-service"

export type EngineDiagnostic = "native-unavailable" | "quarantined" | "abi-mismatch"

/** What `/computer status` reports as `engine:`; the engine is located and started on first use only. */
export type EngineState = "not started" | "ready" | EngineDiagnostic

export class ComputerEngineUnavailableError extends Error {
  readonly diagnostic: EngineDiagnostic

  constructor(diagnostic: EngineDiagnostic, cause: Error) {
    super(`Desktop engine unavailable (${diagnostic}): ${cause.message}`, { cause })
    this.name = "ComputerEngineUnavailableError"
    this.diagnostic = diagnostic
  }
}

function diagnosticOf(error: Error): EngineDiagnostic | undefined {
  if (error instanceof DesktopEngineUnavailableError) return error.diagnostic.code
  if (error instanceof DesktopEngineAbiMismatchError) return "abi-mismatch"
  return undefined
}

/** A `DesktopService` that remembers whether its engine started, so status can report it without starting one. */
export class TrackedDesktopService extends DesktopService {
  #engineState: EngineState = "not started"

  get engineState(): EngineState {
    return this.#engineState
  }

  override async open(params: DesktopSessionOpenParams): ReturnType<DesktopService["open"]> {
    try {
      const capabilities = await super.open(params)
      this.#engineState = "ready"
      return capabilities
    } catch (error) {
      if (!(error instanceof Error)) throw error
      const diagnostic = diagnosticOf(error)
      if (diagnostic === undefined) throw error
      this.#engineState = diagnostic
      throw new ComputerEngineUnavailableError(diagnostic, error)
    }
  }
}
