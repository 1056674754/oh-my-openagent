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
    }, {
      type: "session.status",
      properties: { sessionID: "ses_1", status: { type: "idle" } },
    }])
  })

  test("#given session.execution.failed without an error object #when mapped #then the error degrades to unknown", () => {
    const events = mapV2EventToLegacyEvents("session.execution.failed", { sessionID: "ses_1" })

    expect(events).toEqual([{
      type: "session.error",
      properties: { sessionID: "ses_1", error: { name: "unknown", message: "" } },
    }, {
      type: "session.status",
      properties: { sessionID: "ses_1", status: { type: "idle" } },
    }])
  })

  test("#given session.execution.succeeded #when mapped #then an idle status companion follows the raw event", () => {
    const events = mapV2EventToLegacyEvents("session.execution.succeeded", { sessionID: "ses_1" })

    expect(events).toEqual([
      { type: "session.execution.succeeded", properties: { sessionID: "ses_1" } },
      { type: "session.status", properties: { sessionID: "ses_1", status: { type: "idle" } } },
    ])
  })

  test("#given session.execution.interrupted for shutdown #when mapped #then no idle companion is emitted", () => {
    const events = mapV2EventToLegacyEvents("session.execution.interrupted", {
      sessionID: "ses_1",
      reason: "shutdown",
    })

    expect(events).toEqual([
      { type: "session.execution.interrupted", properties: { sessionID: "ses_1", reason: "shutdown" } },
    ])
  })

  test("#given session.execution.interrupted for a user abort #when mapped #then an idle status companion follows", () => {
    const events = mapV2EventToLegacyEvents("session.execution.interrupted", {
      sessionID: "ses_1",
      reason: "user",
    })

    expect(events).toEqual([
      { type: "session.execution.interrupted", properties: { sessionID: "ses_1", reason: "user" } },
      { type: "session.status", properties: { sessionID: "ses_1", status: { type: "idle" } } },
    ])
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

describe("registerV2Hooks tool registration", () => {
  test("#given a tool hook #when bridged #then the legacy tool context carries no ask", async () => {
    let added: { name: string; execute: (input: unknown, ctx: Record<string, unknown>) => Promise<unknown> } | undefined
    const hostContext = {
      tool: {
        transform: async (
          callback: (editor: {
            add: (tool: unknown) => void
            list: () => readonly { readonly id: string }[]
            remove: (id: string) => void
          }) => void,
        ) => {
          callback({
            add: (tool) => {
              added = tool as typeof added
            },
            list: () => [],
            remove: () => {},
          })
        },
      },
    }
    const hooks = {
      tool: {
        demo: {
          description: "demo",
          args: {},
          execute: async (_args: unknown, ctx: Record<string, unknown>) => ("ask" in ctx ? "has-ask" : "no-ask"),
        },
      },
    } as unknown as Hooks

    await registerV2Hooks(hooks, hostContext, { directory: "/tmp", logger: () => {} })

    expect(added).toBeDefined()
    const result = (await added!.execute({}, {
      sessionID: "ses_1",
      agent: "sisyphus",
      messageID: "msg_1",
      id: "call_1",
      progress: async () => {},
    })) as { content: string }

    expect(result.content).toBe("no-ask")
    expect("output" in result).toBe(false)
  })

  test("#given v1-shimmed arg fields #when bridged #then input is a plain JSON Schema without the shim", async () => {
    let added: { input: unknown } | undefined
    const hostContext = {
      tool: {
        transform: async (
          callback: (editor: { add: (tool: unknown) => void; list: () => []; remove: (id: string) => void }) => void,
        ) => {
          callback({
            add: (tool) => {
              added = tool as typeof added
            },
            list: () => [],
            remove: () => {},
          })
        },
      },
    }
    const { z } = await import("zod")
    const command = z.string().describe("Shell command to run in the background monitor")
    const label = z.string().optional().describe("Safe human-facing label")
    // Reproduce normalizeToolArgSchemas' v1-host compat shim, which crashes
    // the v2 host's standard-interface conversion ("seen.ref" TypeError).
    for (const schema of [command, label]) {
      ;(schema as unknown as { _zod: { toJSONSchema: () => unknown } })._zod.toJSONSchema = () => ({})
    }
    const hooks = {
      tool: {
        monitor_start: {
          description: "start a monitor",
          args: { command, label },
          execute: async () => "",
        },
      },
    } as unknown as Hooks

    await registerV2Hooks(hooks, hostContext, { directory: "/tmp", logger: () => {} })

    expect(added).toBeDefined()
    const input = added!.input as Record<string, unknown>
    expect("~standard" in input).toBe(false)
    expect("$schema" in input).toBe(false)
    expect(input.type).toBe("object")
    const properties = input.properties as Record<string, { type: string; description?: string }>
    expect(properties.command?.type).toBe("string")
    expect(properties.command?.description).toBe("Shell command to run in the background monitor")
    expect(properties.label?.type).toBe("string")
    expect((command as unknown as { _zod: { toJSONSchema?: unknown } })._zod.toJSONSchema).toBeUndefined()
  })
})

describe("registerV2Hooks tool result bridging", () => {
  function toolHost(captured: { added?: { execute: (input: unknown, ctx: unknown) => Promise<unknown> } }) {
    return {
      tool: {
        transform: async (
          callback: (editor: { add: (tool: unknown) => void; list: () => []; remove: (id: string) => void }) => void,
        ) => {
          callback({
            add: (tool) => {
              captured.added = tool as typeof captured.added
            },
            list: () => [],
            remove: () => {},
          })
        },
      },
    }
  }

  test("#given a legacy record result with attachments #when bridged #then output folds into content parts and metadata", async () => {
    const captured: { added?: { execute: (input: unknown, ctx: unknown) => Promise<unknown> } } = {}
    const hooks = {
      tool: {
        demo: {
          description: "demo",
          args: {},
          execute: async () => ({
            output: "done",
            title: "Demo",
            metadata: { foo: 1 },
            attachments: [
              { type: "file", url: "file:///tmp/a.png", mime: "image/png", filename: "a.png" },
            ],
          }),
        },
      },
    } as unknown as Hooks

    await registerV2Hooks(hooks, toolHost(captured), { directory: "/tmp", logger: () => {} })
    const result = (await captured.added!.execute({}, {})) as Record<string, unknown>

    expect("output" in result).toBe(false)
    expect(result.content).toEqual([
      { type: "text", text: "done" },
      { type: "file", uri: "file:///tmp/a.png", mime: "image/png", name: "a.png" },
    ])
    expect(result.metadata).toEqual({ foo: 1, title: "Demo" })
  })

  test("#given a legacy result with no output #when bridged #then content degrades to an empty string", async () => {
    const captured: { added?: { execute: (input: unknown, ctx: unknown) => Promise<unknown> } } = {}
    const hooks = {
      tool: {
        demo: { description: "demo", args: {}, execute: async () => undefined },
      },
    } as unknown as Hooks

    await registerV2Hooks(hooks, toolHost(captured), { directory: "/tmp", logger: () => {} })
    const result = (await captured.added!.execute({}, {})) as Record<string, unknown>

    expect(result.content).toBe("")
    expect("metadata" in result).toBe(false)
  })
})

describe("registerV2Hooks tool.execute.after bridge", () => {
  function afterHost(registrations: Map<string, (event: unknown) => Promise<void>>) {
    return {
      tool: {
        hook: async (name: string, callback: (event: unknown) => Promise<void>) => {
          registrations.set(name, callback)
          return {}
        },
      },
    }
  }

  test("#given a no-op legacy handler #when bridged #then the result reference stays untouched", async () => {
    const registrations = new Map<string, (event: unknown) => Promise<void>>()
    const hooks = {
      "tool.execute.after": async (_input: unknown, _output: unknown) => {},
    } as unknown as Hooks

    await registerV2Hooks(hooks, afterHost(registrations), { directory: "/tmp", logger: () => {} })
    const result = { content: [{ type: "text", text: "kept" }], metadata: { untouched: true } }
    await registrations.get("execute.after")?.({ status: "completed", tool: "foreign", sessionID: "ses_1", id: "call_1", result })

    expect((result as Record<string, unknown>).content).toEqual([{ type: "text", text: "kept" }])
  })

  test("#given a handler rewrite #when bridged #then content is patched without an output key", async () => {
    const registrations = new Map<string, (event: unknown) => Promise<void>>()
    const hooks = {
      "tool.execute.after": async (
        _input: unknown,
        output: { output: string; title?: string; metadata: Record<string, unknown> },
      ) => {
        output.output = "rewritten"
        output.metadata.recovered = true
      },
    } as unknown as Hooks

    await registerV2Hooks(hooks, afterHost(registrations), { directory: "/tmp", logger: () => {} })
    const event = {
      status: "completed",
      tool: "omo_tool",
      sessionID: "ses_1",
      id: "call_1",
      result: { content: "original", metadata: { a: 1 } },
    }
    await registrations.get("execute.after")?.(event)

    expect((event.result as Record<string, unknown>).content).toBe("rewritten")
    expect((event.result as Record<string, unknown>).metadata).toEqual({ a: 1, recovered: true })
    expect("output" in (event.result as Record<string, unknown>)).toBe(false)
  })
})

describe("registerV2Hooks chat.message bridge", () => {
  function promptHost(options?: {
    getSession?: (input: { sessionID: string }) => Promise<unknown>
  }) {
    const registrations = new Map<string, (event: unknown) => Promise<void>>()
    const switchCalls: Array<Record<string, unknown>> = []
    const hostContext = {
      session: {
        hook: async (name: string, callback: (event: unknown) => Promise<void>) => {
          registrations.set(name, callback)
          return {}
        },
        get: options?.getSession ?? (async () => ({
          agent: "sisyphus",
          model: { providerID: "moonshotai", id: "kimi-k3" },
        })),
        switchModel: async (input: Record<string, unknown>) => {
          switchCalls.push(input)
        },
      },
    }
    return { registrations, switchCalls, hostContext }
  }

  test("#given a prompt event #when bridged #then text mutations round-trip and agent/model come from session.get", async () => {
    const { registrations, switchCalls, hostContext } = promptHost()
    const seenInputs: Array<Record<string, unknown>> = []
    const hooks = {
      "chat.message": async (input: Record<string, unknown>, output: { message: Record<string, unknown>; parts: Array<{ type: string; text?: string }> }) => {
        seenInputs.push(input)
        output.parts.push({ type: "text", text: "[omo]" })
      },
    } as unknown as Hooks

    await registerV2Hooks(hooks, hostContext, { directory: "/tmp", logger: () => {} })
    const prompt = { text: "hello" }
    await registrations.get("prompt")?.({ sessionID: "ses_1", messageID: "msg_1", prompt, delivery: "steer" })

    expect(prompt.text).toBe("hello\n[omo]")
    expect(seenInputs[0]?.sessionID).toBe("ses_1")
    expect(seenInputs[0]?.agent).toBe("sisyphus")
    expect(seenInputs[0]?.model).toEqual({ providerID: "moonshotai", modelID: "kimi-k3" })
    expect(switchCalls).toEqual([])
  })

  test("#given a model override on output.message #when bridged #then switchModel receives the v2 object shape", async () => {
    const { registrations, switchCalls, hostContext } = promptHost()
    const hooks = {
      "chat.message": async (_input: unknown, output: { message: Record<string, unknown>; parts: unknown[] }) => {
        output.message.model = { providerID: "anthropic", modelID: "claude-x" }
      },
    } as unknown as Hooks

    await registerV2Hooks(hooks, hostContext, { directory: "/tmp", logger: () => {} })
    await registrations.get("prompt")?.({ sessionID: "ses_1", messageID: "msg_1", prompt: { text: "hi" } })

    expect(switchCalls).toEqual([
      { sessionID: "ses_1", model: { providerID: "anthropic", id: "claude-x" } },
    ])
  })

  test("#given handler-injected non-text parts #when bridged #then they are dropped and the text still round-trips", async () => {
    const { registrations, hostContext } = promptHost()
    const logs: string[] = []
    const hooks = {
      "chat.message": async (_input: unknown, output: { message: Record<string, unknown>; parts: Array<{ type: string; text?: string }> }) => {
        output.parts.push({ type: "file", uri: "file:///tmp/x" })
        output.parts.push({ type: "text", text: "extra" })
      },
    } as unknown as Hooks

    await registerV2Hooks(hooks, hostContext, { directory: "/tmp", logger: (message) => logs.push(message) })
    const prompt = { text: "base" }
    await registrations.get("prompt")?.({ sessionID: "ses_1", messageID: "msg_1", prompt })

    expect(prompt.text).toBe("base\nextra")
    expect(logs.some((line) => line.includes("non-text parts"))).toBe(true)
  })

  test("#given a failing session.get #when bridged #then the handler still runs with agent/model undefined", async () => {
    const { registrations, hostContext } = promptHost({
      getSession: async () => {
        throw new Error("boom")
      },
    })
    const seenInputs: Array<Record<string, unknown>> = []
    const hooks = {
      "chat.message": async (input: Record<string, unknown>, _output: unknown) => {
        seenInputs.push(input)
      },
    } as unknown as Hooks

    await registerV2Hooks(hooks, hostContext, { directory: "/tmp", logger: () => {} })
    const prompt = { text: "hello" }
    await registrations.get("prompt")?.({ sessionID: "ses_1", messageID: "msg_1", prompt })

    expect(seenInputs[0]?.agent).toBeUndefined()
    expect(seenInputs[0]?.model).toBeUndefined()
    expect(prompt.text).toBe("hello")
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
        if (received.length === 5) release()
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
      "session.status",
    ])
    expect(received[0]?.properties).toEqual({ sessionID: "ses_1", title: "t" })
    expect((received[3]?.properties as { error: { name: string } }).error.name).toBe("api_error")
    expect(received[4]?.properties).toEqual({ sessionID: "ses_1", status: { type: "idle" } })

    await dispose()
  })
})
