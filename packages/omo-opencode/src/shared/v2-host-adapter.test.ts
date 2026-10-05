import { describe, expect, test } from "bun:test"
import type { Hooks } from "@opencode-ai/plugin"

import { mapV2EventToLegacyEvents, registerV2Hooks } from "./v2-host-adapter"

function envelope(type: string, data: Record<string, unknown>): Record<string, unknown> {
  return { id: "evt_test", type, created: 1, data }
}

describe("mapV2EventToLegacyEvents", () => {
  test("#given session.step.started #when mapped #then it becomes message.updated with assistant info", () => {
    const events = mapV2EventToLegacyEvents("session.step.started", {
      sessionID: "ses_1",
      assistantMessageID: "msg_1",
      agent: "sisyphus",
      model: { id: "kimi-k3", providerID: "moonshotai" },
      started: 100,
    })

    expect(events).toEqual([{
      type: "message.updated",
      properties: {
        info: {
          id: "msg_1",
          sessionID: "ses_1",
          role: "assistant",
          agent: "sisyphus",
          providerID: "moonshotai",
          modelID: "kimi-k3",
        },
      },
    }])
  })

  test("#given session.step.ended #when mapped #then message.updated carries the finish reason", () => {
    const events = mapV2EventToLegacyEvents("session.step.ended", {
      sessionID: "ses_1",
      assistantMessageID: "msg_1",
      finish: "stop",
      cost: 0,
      tokens: {},
    })

    expect(events).toEqual([{
      type: "message.updated",
      properties: {
        info: { id: "msg_1", sessionID: "ses_1", role: "assistant", finish: "stop" },
      },
    }])
  })

  test("#given session.execution.failed #when mapped #then it becomes session.error with a named error", () => {
    const events = mapV2EventToLegacyEvents("session.execution.failed", {
      sessionID: "ses_1",
      error: { type: "provider_error", message: "boom", status: 502 },
    })

    expect(events).toEqual([{
      type: "session.error",
      properties: {
        sessionID: "ses_1",
        error: { name: "provider_error", message: "boom", data: { status: 502 } },
      },
    }])
  })

  test("#given session.execution.failed without an error object #when mapped #then the error degrades to unknown", () => {
    const events = mapV2EventToLegacyEvents("session.execution.failed", { sessionID: "ses_1" })

    expect(events).toEqual([{
      type: "session.error",
      properties: { sessionID: "ses_1", error: { name: "unknown", message: "" } },
    }])
  })

  test("#given a v2 event without a v1 namesake #when mapped #then the data bag passes through unchanged", () => {
    const data = { sessionID: "ses_1", status: { type: "idle" } }
    const events = mapV2EventToLegacyEvents("session.status", data)

    expect(events).toEqual([{ type: "session.status", properties: data }])
  })

  test("#given message.removed #when mapped #then it is not synthesized", () => {
    expect(mapV2EventToLegacyEvents("message.removed", { sessionID: "ses_1", messageID: "msg_1" })).toEqual([
      { type: "message.removed", properties: { sessionID: "ses_1", messageID: "msg_1" } },
    ])
  })
})

describe("registerV2Hooks event stream", () => {
  test("#given a v2 envelope stream #when bridged #then the legacy handler receives normalized events", async () => {
    const stream = [
      envelope("session.created", { sessionID: "ses_1", title: "t" }),
      envelope("session.step.started", {
        sessionID: "ses_1",
        assistantMessageID: "msg_1",
        agent: "sisyphus",
        model: { id: "kimi-k3", providerID: "moonshotai" },
        started: 1,
      }),
      envelope("session.step.ended", { sessionID: "ses_1", assistantMessageID: "msg_1", finish: "stop" }),
      envelope("session.execution.failed", { sessionID: "ses_1", error: { type: "api_error", message: "x" } }),
    ]
    const received: Array<{ type: string; properties: unknown }> = []
    let release: () => void = () => {}
    const drained = new Promise<void>((resolve) => {
      release = resolve
    })
    const hooks = {
      event: async (input: { event: { type: string; properties: unknown } }) => {
        received.push({ type: input.event.type, properties: input.event.properties })
        if (received.length === 4) release()
      },
    } as unknown as Hooks
    const hostContext = {
      event: {
        subscribe: async function* (_options?: { signal?: AbortSignal }) {
          for (const event of stream) yield event
          await new Promise<void>(() => {})
        },
      },
    }

    const dispose = await registerV2Hooks(hooks, hostContext, { directory: "/tmp", logger: () => {} })

    await Promise.race([drained, new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 2000))])

    expect(received.map((event) => event.type)).toEqual([
      "session.created",
      "message.updated",
      "message.updated",
      "session.error",
    ])
    expect(received[0]?.properties).toEqual({ sessionID: "ses_1", title: "t" })
    expect((received[3]?.properties as { error: { name: string } }).error.name).toBe("api_error")

    await dispose()
  })
})
