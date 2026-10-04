import { describe, expect, test } from "bun:test"

import type { ChildEventListener } from "../types"
import { createHandleListeners } from "./handle-listeners"

type ChildEvent = Parameters<ChildEventListener>[0]

const fallbackApplied = {
  type: "retry_fallback_applied",
  from: "mock/dead-primary",
  to: "mock/healthy-fallback",
} as unknown as ChildEvent
const turnEnded = { type: "agent_end", willRetry: false, messages: [] } as unknown as ChildEvent

function collect(listeners: ReturnType<typeof createHandleListeners>): ChildEvent[] {
  const seen: ChildEvent[] = []
  listeners.registrations.subscribe((event) => void seen.push(event))
  return seen
}

describe("events a warm host delivers before the manager subscribes (#9512)", () => {
  test("#given a first turn that finished before anyone subscribed #when the manager attaches its observers together #then each of them sees that turn's events in order", () => {
    // given
    const listeners = createHandleListeners()
    listeners.emitEvent(fallbackApplied)
    listeners.emitEvent(turnEnded)

    // when
    const transcript = collect(listeners)
    const stats = collect(listeners)

    // then
    expect(transcript).toEqual([fallbackApplied, turnEnded])
    expect(stats).toEqual([fallbackApplied, turnEnded])
  })

  test("#given early events were handed to the first observers #when another observer subscribes on a later tick #then it does not see them again", async () => {
    // given
    const listeners = createHandleListeners()
    listeners.emitEvent(fallbackApplied)
    collect(listeners)
    await Promise.resolve()

    // when
    const late = collect(listeners)

    // then
    expect(late).toEqual([])
  })

  test("#given an observer is attached #when events arrive #then they are delivered live and never replayed to a later observer", async () => {
    // given
    const listeners = createHandleListeners()
    const first = collect(listeners)
    await Promise.resolve()

    // when
    listeners.emitEvent(turnEnded)
    const later = collect(listeners)

    // then
    expect(first).toEqual([turnEnded])
    expect(later).toEqual([])
  })

  test("#given a long first turn whose fallback hop is its first event #when the manager subscribes after thousands of updates #then the hop and every later event still arrive", () => {
    // given
    const listeners = createHandleListeners()
    listeners.emitEvent(fallbackApplied)
    for (let index = 0; index < 5_000; index += 1) {
      listeners.emitEvent({ type: "message_update", index } as unknown as ChildEvent)
    }
    listeners.emitEvent(turnEnded)

    // when
    const seen = collect(listeners)

    // then
    expect(seen).toHaveLength(5_002)
    expect(seen[0]).toBe(fallbackApplied)
    expect(seen.at(-1)).toBe(turnEnded)
  })
})
