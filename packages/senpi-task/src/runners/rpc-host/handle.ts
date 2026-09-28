import type { RunnerOutcome } from "../in-process/child-handle"
import { isBusyChildRejection, type RpcStreamingBehavior } from "../rpc/delivery-semantics"
import { exitTurnOutcome, promptFailureOutcome } from "../rpc/turn-outcome"
import { createTurnSettlement, sessionIsIdle } from "../rpc/turn-settlement"
import type { ChildEventListener, ChildExitOutcome, RpcTerminalAssistantMessage } from "../types"
import {
  classifySessionExit,
  type SessionCloseIntent,
  type SessionExitCause,
  type SessionExitClassification,
} from "./exit-mapping"
import type {
  HostSessionChildHandle,
  HostSessionHandleOptions,
  HostSessionIdentity,
  HostSessionOpenDisposition,
  HostSessionPort,
} from "./handle-port"
import { startHostHeartbeat } from "./handle-heartbeat"
import { createHandleRecovery } from "./handle-recovery"
import { endSessionOnHost } from "./handle-teardown"
import type { HostSessionParked } from "./session-client"
import { extractTerminalAssistantMessage } from "./terminal-message"

/**
 * The steerable child handle over ONE daemon session: identical turn semantics to
 * `runners/rpc/handle.ts` (steer with followUp fallback, agent_end outcome tracking, idle/outcome
 * waiters, get_state heartbeat), with process facts replaced by session facts. `pid` is ALWAYS
 * undefined - the daemon's pid belongs to no child - and nothing here signals a process:
 * `terminate()` is `abort` then `close_session`, both bounded.
 */
export function createHostSessionHandle(options: HostSessionHandleOptions): HostSessionChildHandle {
  const { taskId, heartbeatIntervalMs, now, closeGraceMs, reattach, shardEvents } = options
  // Both move on a reattach: a recovered transport is a new port, and a reopened session a new
  // routing handle on a possibly new host generation. The session PATH is the child's identity.
  let client: HostSessionPort = options.client
  let session: HostSessionIdentity = options.session
  let openDisposition: HostSessionOpenDisposition = options.openDisposition
  const idleWaiters: Array<() => void> = []
  const outcomeWaiters: Array<(settled: RunnerOutcome) => void> = []
  const exitWaiters: Array<(outcome: ChildExitOutcome) => void> = []
  const eventListeners = new Set<ChildEventListener>()
  const parkedListeners = new Set<(event: HostSessionParked) => void>()
  const turnResumedListeners = new Set<() => void>()
  const resumedListeners = new Set<() => void>()
  let reachedIdle = false
  let sessionId: string | undefined
  let finalText: string | undefined
  let turnBaseline: string | undefined
  let turnOutcome: RunnerOutcome | undefined
  let terminalAssistantMessage: RpcTerminalAssistantMessage | undefined
  let abortedByUser = false
  let lastSeenAt: number | undefined
  let outcome: ChildExitOutcome | undefined
  let intent: SessionCloseIntent = "running"
  let parked = false
  let detached = false

  const settleTurn = (settled: RunnerOutcome): void => {
    if (turnOutcome !== undefined) return
    turnOutcome = settled
    reachedIdle = true
    flush(idleWaiters)
    for (const waiter of outcomeWaiters.splice(0)) waiter(settled)
  }

  const settlement = createTurnSettlement({
    settle: settleTurn,
    abortedByUser: () => abortedByUser,
    baseline: () => turnBaseline,
    finalText: () => finalText,
  })

  const onSessionEvent = (event: Parameters<ChildEventListener>[0]): void => {
    // A run the child starts on its own after its turn settled (a monitor or background job woke it)
    // is a new turn: the next outcome is that run's, never the settled one again (omo#9069).
    if (event.type === "agent_start" && turnOutcome !== undefined && outcome === undefined) {
      beginTurn()
      for (const listener of resumedListeners) listener()
    }
    if (event.type === "message_end") {
      const terminal = extractTerminalAssistantMessage(event.message)
      if (terminal !== undefined) {
        terminalAssistantMessage = terminal
        finalText = terminal.text ?? finalText
      }
    }
    settlement.observe(event)
  }

  const stopHeartbeat = startHostHeartbeat({
    taskId,
    intervalMs: heartbeatIntervalMs,
    paused: () => outcome !== undefined || parked || detached,
    port: () => client,
    onState: (state) => {
      lastSeenAt = now()
      sessionId = state.sessionId
    },
  })

  const settleExit = (built: ChildExitOutcome): void => {
    if (outcome) return
    outcome = built
    eventListeners.clear()
    turnResumedListeners.clear()
    resumedListeners.clear()
    stopHeartbeat()
    flush(idleWaiters)
    if (turnOutcome === undefined) settleTurn(settlement.pending() ?? exitTurnOutcome(built, finalText))
    for (const waiter of exitWaiters.splice(0)) waiter(built)
  }

  // A parked session is NOT an exit: the child keeps its status and its transcript, and the manager
  // parks the record (`rpc_detached`) until a later turn reopens the session from its JSONL.
  const park = (event: HostSessionParked): void => {
    // A parked session is idle on the host: an outcome held for `agent_idle` is final (omo#9069).
    const held = settlement.pending()
    if (turnOutcome === undefined && held !== undefined) settleTurn(held)
    parked = true
    stopHeartbeat()
    for (const listener of parkedListeners) listener(event)
  }

  const settleClassified = (classified: SessionExitClassification): void => {
    switch (classified.disposition) {
      case "exit":
        return settleExit(classified.outcome)
      case "parked":
        return park({ sessionId: session.routingId, sessionPath: session.sessionPath, reason: classified.cause })
      default:
        return unreachable(classified)
    }
  }

  /**
   * A session that ends while this child still holds it is the child's exit. Once the session was
   * parked or this client detached, nothing the host says afterwards is this child's death.
   */
  const endSession = (cause: SessionExitCause): void => {
    if (parked || detached || outcome !== undefined) return
    settleClassified(classifySessionExit({ cause, intent }))
  }

  const alive = (): boolean => intent === "running" && !parked && !detached && outcome === undefined

  const recovery = createHandleRecovery({
    taskId,
    reattach,
    events: shardEvents,
    port: () => client,
    identity: () => session,
    alive,
    turnSettled: () => turnOutcome !== undefined || reachedIdle,
    adopt: (next) => {
      client = next.client
      session = next.session
      openDisposition = next.attached ? "attached" : "reopened"
      bindClient(client)
    },
    turnResumed: () => {
      for (const listener of turnResumedListeners) listener()
    },
    endLost: () => endSession({ kind: "transport_gone" }),
    park: (reason) => park({ sessionId: session.routingId, sessionPath: session.sessionPath, reason }),
  })

  const bindClient = (port: HostSessionPort): void => {
    port.onEvent((event) => {
      if (client !== port) return
      onSessionEvent(event)
      for (const listener of eventListeners) listener(event)
    })
    port.onParked((event) => {
      if (client !== port || parked || detached || outcome !== undefined) return
      park(event)
    })
    port.onClosed((event) => {
      if (client === port) endSession({ kind: "session_closed", reason: event.reason })
    })
    void port.transportGone.then(() => recovery.onTransportGone(port))
  }

  bindClient(client)

  const beginTurn = (): void => {
    if (outcome !== undefined) return
    if (reachedIdle || turnOutcome !== undefined) {
      reachedIdle = false
      turnOutcome = undefined
    }
    terminalAssistantMessage = undefined
    abortedByUser = false
    turnBaseline = finalText
  }

  // Same queueing contract as the child-process runner: a delivery that lands mid-run is retried
  // as followUp instead of failing the child (`rpc/delivery-semantics.ts`).
  const deliverPrompt = async (text: string, streamingBehavior: RpcStreamingBehavior): Promise<void> => {
    try {
      await recovery.issue({ type: "prompt", message: text, streamingBehavior })
    } catch (error) {
      if (streamingBehavior === "followUp" || !isBusyChildRejection(error)) throw error
      await recovery.issue({ type: "prompt", message: text, streamingBehavior: "followUp" })
    }
  }

  const runPrompt = async (text: string, streamingBehavior: RpcStreamingBehavior = "steer"): Promise<void> => {
    beginTurn()
    try {
      await deliverPrompt(text, streamingBehavior)
    } catch (error) {
      settleTurn(promptFailureOutcome(error))
      throw error
    }
  }

  const endOnHost = async (next: "closed" | "terminated"): Promise<void> => {
    if (outcome !== undefined) return
    intent = next
    // close() drops the connection before its reply, so stop polling before teardown starts.
    stopHeartbeat()
    await endSessionOnHost({ taskId, closeGraceMs, port: () => client }, next)
    // A teardown this client asked for always ends the child - including a session the daemon had
    // parked, which the manager cancels exactly the same way.
    const reason = next === "terminated" ? "terminated" : "client_close"
    settleClassified(classifySessionExit({ cause: { kind: "session_closed", reason }, intent }))
  }

  // Queries follow the child to whichever port it holds now; one issued mid-reattach waits for it.
  const currentPort = async (): Promise<HostSessionPort> => {
    await recovery.settled()
    return client
  }

  const detach = async (): Promise<void> => {
    detached = true
    eventListeners.clear()
    turnResumedListeners.clear()
    resumedListeners.clear()
    stopHeartbeat()
    await client.detach()
  }

  return {
    task_id: taskId,
    kind: "host-session",
    get hostSession() {
      return { socket: client.socketPath, ...session }
    },
    get sessionId() {
      return sessionId
    },
    pid: undefined,
    get attached() {
      return outcome === undefined && !parked && !detached
    },
    get openDisposition() {
      return openDisposition
    },
    getEntries: async (since) => (await currentPort()).getEntries(since),
    switchSession: async (sessionPath) => (await currentPort()).switchSession(sessionPath),
    steer: async (text) => {
      beginTurn()
      try {
        await recovery.issue({ type: "steer", message: text })
      } catch (error) {
        if (!isBusyChildRejection(error)) throw error
        await deliverPrompt(text, "followUp")
      }
    },
    followUp: (text) => runPrompt(text, "followUp"),
    abort: () => {
      abortedByUser = true
      return recovery.issue({ type: "abort" })
    },
    subscribe: (listener: ChildEventListener) => {
      eventListeners.add(listener)
      return () => eventListeners.delete(listener)
    },
    onParked: (listener) => {
      parkedListeners.add(listener)
      return () => parkedListeners.delete(listener)
    },
    onTurnResumed: (listener) => {
      turnResumedListeners.add(listener)
      return () => turnResumedListeners.delete(listener)
    },
    adoptFinishedTurn: async (finalResponse) => {
      if (turnOutcome !== undefined || settlement.pending() !== undefined) return
      // A state read that fails is not proof of idleness, and must never cost the reattach: stay busy.
      const state = await client.getState().catch(() => undefined)
      if (state === undefined || !sessionIsIdle(state)) return
      if (turnOutcome === undefined && settlement.pending() === undefined) settleTurn({ status: "completed", finalResponse })
    },
    onSelfResumed: (listener) => {
      resumedListeners.add(listener)
      return () => resumedListeners.delete(listener)
    },
    waitForIdle: () =>
      reachedIdle || outcome ? Promise.resolve() : new Promise<void>((resolve) => idleWaiters.push(resolve)),
    hasExited: () => outcome !== undefined,
    waitForOutcome: () =>
      turnOutcome !== undefined
        ? Promise.resolve(turnOutcome)
        : outcome === undefined
          ? new Promise<RunnerOutcome>((resolve) => outcomeWaiters.push(resolve))
          : Promise.resolve(exitTurnOutcome(outcome, finalText)),
    lastAssistantText: () => finalText,
    terminalAssistantMessage: () => terminalAssistantMessage,
    wasAbortedByUser: () => abortedByUser,
    lastSeen: () => lastSeenAt,
    exitOutcome: () => outcome,
    waitForExit: () =>
      outcome ? Promise.resolve(outcome) : new Promise<ChildExitOutcome>((resolve) => exitWaiters.push(resolve)),
    dispose: detach,
    detach,
    close: () => endOnHost("closed"),
    terminate: () => endOnHost("terminated"),
    startInitialPrompt: (text) => runPrompt(text),
  }
}

function flush(waiters: Array<() => void>): void {
  for (const waiter of waiters.splice(0)) waiter()
}

function unreachable(value: never): never {
  throw new Error(`unhandled session exit classification: ${JSON.stringify(value)}`)
}
