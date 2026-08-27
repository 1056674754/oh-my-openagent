import { describe, expect, test } from "bun:test"

import type { BackgroundTask } from "../../features/background-agent"
import type { BackgroundOutputClient } from "./clients"
import { formatTaskResult } from "./task-result-format"

function createTask(overrides: Partial<BackgroundTask> = {}): BackgroundTask {
  return {
    id: "task-1",
    sessionId: "ses-1",
    parentSessionId: "main-1",
    parentMessageId: "msg-1",
    description: "background task",
    prompt: "do work",
    agent: "test-agent",
    status: "completed",
    startedAt: new Date("2026-01-01T00:00:00.000Z"),
    completedAt: new Date("2026-01-01T00:00:05.000Z"),
    ...overrides,
  }
}

describe("formatTaskResult", () => {
  test("returns assistant session errors instead of masking them as success text", async () => {
    const task = createTask()
    const client: BackgroundOutputClient = {
      session: {
        messages: async () => ({
          data: [
            {
              info: {
                role: "assistant",
                time: { created: 1 },
                error: { data: { message: "Forbidden: Selected provider is forbidden" } },
              },
              parts: [],
            },
          ],
        }),
      },
    }

    const output = await formatTaskResult(task, client)

    expect(output).toContain("Session error")
    expect(output).toContain("Forbidden: Selected provider is forbidden")
  })

  test("#given a completed task with tool results, reasoning, and a final assistant text #when the default result is fetched #then only the final deliverable returns with a summary note", async () => {
    const task = createTask({ sessionId: "ses-summary-default" })
    const client: BackgroundOutputClient = {
      session: {
        messages: async () => ({
          data: [
            {
              info: { role: "tool", time: "2026-01-01T00:00:01Z" },
              parts: [{ type: "tool_result", content: "RAW-TOOL-OUTPUT-LEAK-CHECK" }],
            },
            {
              info: { role: "assistant", time: "2026-01-01T00:00:02Z" },
              parts: [
                { type: "reasoning", text: "CHAIN-OF-THOUGHT-LEAK-CHECK" },
                { type: "tool_result", content: "TOOL-IN-ASSISTANT-LEAK-CHECK" },
              ],
            },
            {
              info: { role: "assistant", time: "2026-01-01T00:00:03Z" },
              parts: [{ type: "text", text: "FINAL DELIVERABLE: found 3 matches in auth.ts" }],
            },
          ],
        }),
      },
    }

    const output = await formatTaskResult(task, client)

    expect(output).toContain("FINAL DELIVERABLE: found 3 matches in auth.ts")
    expect(output).toContain("(final-message summary: 3 new messages, 2 tool results omitted")
    expect(output).not.toContain("RAW-TOOL-OUTPUT-LEAK-CHECK")
    expect(output).not.toContain("CHAIN-OF-THOUGHT-LEAK-CHECK")
    expect(output).not.toContain("TOOL-IN-ASSISTANT-LEAK-CHECK")
  })

  test("#given a final deliverable over the truncation budget #when the default result is fetched #then middle content is elided with a full_session hint", async () => {
    const task = createTask({ sessionId: "ses-summary-truncate" })
    const longText = "S".repeat(200) + "M".repeat(10_000) + "E-marker-tail"
    const client: BackgroundOutputClient = {
      session: {
        messages: async () => ({
          data: [
            {
              info: { role: "assistant", time: "2026-01-01T00:00:01Z" },
              parts: [{ type: "text", text: longText }],
            },
          ],
        }),
      },
    }

    const output = await formatTaskResult(task, client)

    expect(output).toContain("chars truncated — call background_output again with full_session=true for complete output")
    expect(output).toContain("E-marker-tail")
    expect(output).not.toContain("M".repeat(5_801))
  })

  test("#given a completed task whose messages carry no assistant text #when the default result is fetched #then it reports the absence without dumping the transcript", async () => {
    const task = createTask({ sessionId: "ses-summary-empty" })
    const client: BackgroundOutputClient = {
      session: {
        messages: async () => ({
          data: [
            {
              info: { role: "tool", time: "2026-01-01T00:00:01Z" },
              parts: [{ type: "tool_result", content: "ONLY-TOOL-OUTPUT-LEAK-CHECK" }],
            },
            {
              info: { role: "assistant", time: "2026-01-01T00:00:02Z" },
              parts: [{ type: "reasoning", text: "ONLY-REASONING-LEAK-CHECK" }],
            },
          ],
        }),
      },
    }

    const output = await formatTaskResult(task, client)

    expect(output).toContain("(No final assistant text — call background_output again with full_session=true")
    expect(output).not.toContain("ONLY-TOOL-OUTPUT-LEAK-CHECK")
    expect(output).not.toContain("ONLY-REASONING-LEAK-CHECK")
  })
})
