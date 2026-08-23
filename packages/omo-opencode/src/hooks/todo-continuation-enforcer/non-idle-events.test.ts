/// <reference types="bun-types" />
import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import { OMO_INTERNAL_INITIATOR_MARKER } from "../../shared/internal-initiator-marker"
import { handleNonIdleEvent } from "./non-idle-events"
import { createSessionStateStore, type SessionStateStore } from "./session-state"

describe("handleNonIdleEvent", () => {
  let sessionStateStore: SessionStateStore

  beforeEach(() => {
    sessionStateStore = createSessionStateStore()
  })

  afterEach(() => {
    sessionStateStore.shutdown()
  })

  test("given synthetic user message update, keeps continuation countdown state intact", () => {
    // given
    const sessionID = "ses_synthetic_user_event"
    const state = sessionStateStore.getState(sessionID)
    state.countdownStartedAt = Date.now() - 10_000
    state.wasCancelled = true
    state.tokenLimitDetected = true

    // when
    handleNonIdleEvent({
      eventType: "message.updated",
      properties: {
        sessionID,
        info: { role: "user" },
        parts: [{ type: "text", text: "internal wake", synthetic: true }],
      },
      sessionStateStore,
    })

    // then
    expect(state.countdownStartedAt).toBeDefined()
    expect(state.wasCancelled).toBe(true)
    expect(state.tokenLimitDetected).toBe(true)
  })

  test("given internally marked user message update, keeps continuation countdown state intact", () => {
    // given
    const sessionID = "ses_internal_user_event"
    const state = sessionStateStore.getState(sessionID)
    state.countdownStartedAt = Date.now() - 10_000
    state.wasCancelled = true
    state.tokenLimitDetected = true

    // when
    handleNonIdleEvent({
      eventType: "message.updated",
      properties: {
        sessionID,
        info: { role: "user" },
        parts: [
          { type: "text", text: `internal wake\n${OMO_INTERNAL_INITIATOR_MARKER}` },
        ],
      },
      sessionStateStore,
    })

    // then
    expect(state.countdownStartedAt).toBeDefined()
    expect(state.wasCancelled).toBe(true)
    expect(state.tokenLimitDetected).toBe(true)
  })

  test("given ultrawork loop continuation user message update, cancels stale todo continuation countdown", () => {
    // given
    const sessionID = "ses_ulw_todo_overlap"
    const state = sessionStateStore.getState(sessionID)
    state.countdownStartedAt = Date.now() - 10_000
    state.wasCancelled = true
    state.tokenLimitDetected = true

    // when
    handleNonIdleEvent({
      eventType: "message.updated",
      properties: {
        sessionID,
        info: { role: "user" },
        parts: [
          {
            type: "text",
            text: `ultrawork [SYSTEM DIRECTIVE: OH-MY-OPENCODE - RALPH LOOP 2/500]\ncontinue\n${OMO_INTERNAL_INITIATOR_MARKER}`,
            synthetic: true,
          },
        ],
      },
      sessionStateStore,
    })

    // then
    expect(state.countdownStartedAt).toBeUndefined()
    expect(state.wasCancelled).toBe(true)
    expect(state.tokenLimitDetected).toBe(true)
  })

  test("given assistant activity after abort, preserves the manual stop marker", () => {
    // given
    const sessionID = "ses_assistant_after_abort"
    const state = sessionStateStore.getState(sessionID)
    state.abortDetectedAt = Date.now()
    state.wasCancelled = true
    state.countdownStartedAt = Date.now() - 10_000

    // when
    handleNonIdleEvent({
      eventType: "message.updated",
      properties: {
        sessionID,
        info: { role: "assistant" },
      },
      sessionStateStore,
    })

    // then
    expect(state.countdownStartedAt).toBeUndefined()
    expect(state.abortDetectedAt).toBeDefined()
    expect(state.wasCancelled).toBe(true)
  })

  test("given assistant activity after abort window, clears stale manual stop marker", () => {
    // given
    const sessionID = "ses_assistant_after_stale_abort"
    const state = sessionStateStore.getState(sessionID)
    state.abortDetectedAt = Date.now() - 10_000
    state.wasCancelled = true
    state.countdownStartedAt = Date.now() - 10_000

    // when
    handleNonIdleEvent({
      eventType: "message.updated",
      properties: {
        sessionID,
        info: { role: "assistant" },
      },
      sessionStateStore,
    })

    // then
    expect(state.countdownStartedAt).toBeUndefined()
    expect(state.abortDetectedAt).toBeUndefined()
    expect(state.wasCancelled).toBe(false)
  })

  test("given tool activity after abort, preserves the manual stop marker", () => {
    // given
    const sessionID = "ses_tool_after_abort"
    const state = sessionStateStore.getState(sessionID)
    state.abortDetectedAt = Date.now()
    state.wasCancelled = true
    state.countdownStartedAt = Date.now() - 10_000

    // when
    handleNonIdleEvent({
      eventType: "tool.execute.before",
      properties: { sessionID },
      sessionStateStore,
    })

    // then
    expect(state.countdownStartedAt).toBeUndefined()
    expect(state.abortDetectedAt).toBeDefined()
    expect(state.wasCancelled).toBe(true)
  })

  test("given tool activity after abort window, clears stale manual stop marker", () => {
    // given
    const sessionID = "ses_tool_after_stale_abort"
    const state = sessionStateStore.getState(sessionID)
    state.abortDetectedAt = Date.now() - 10_000
    state.wasCancelled = true
    state.countdownStartedAt = Date.now() - 10_000

    // when
    handleNonIdleEvent({
      eventType: "tool.execute.before",
      properties: { sessionID },
      sessionStateStore,
    })

    // then
    expect(state.countdownStartedAt).toBeUndefined()
    expect(state.abortDetectedAt).toBeUndefined()
    expect(state.wasCancelled).toBe(false)
  })

  test("given message delta after abort, preserves the manual stop marker", () => {
    // given
    const sessionID = "ses_delta_after_abort"
    const state = sessionStateStore.getState(sessionID)
    state.abortDetectedAt = Date.now()
    state.wasCancelled = true
    state.countdownStartedAt = Date.now() - 10_000

    // when
    handleNonIdleEvent({
      eventType: "message.part.delta",
      properties: { sessionID },
      sessionStateStore,
    })

    // then
    expect(state.countdownStartedAt).toBeUndefined()
    expect(state.abortDetectedAt).toBeDefined()
    expect(state.wasCancelled).toBe(true)
  })

  test("given message delta after abort window, clears stale manual stop marker", () => {
    // given
    const sessionID = "ses_delta_after_stale_abort"
    const state = sessionStateStore.getState(sessionID)
    state.abortDetectedAt = Date.now() - 10_000
    state.wasCancelled = true
    state.countdownStartedAt = Date.now() - 10_000

    // when
    handleNonIdleEvent({
      eventType: "message.part.delta",
      properties: { sessionID },
      sessionStateStore,
    })

    // then
    expect(state.countdownStartedAt).toBeUndefined()
    expect(state.abortDetectedAt).toBeUndefined()
    expect(state.wasCancelled).toBe(false)
  })
})
