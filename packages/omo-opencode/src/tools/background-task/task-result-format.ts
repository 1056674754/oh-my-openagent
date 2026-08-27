import type { BackgroundTask } from "../../features/background-agent"
import { extractErrorMessage } from "../../features/background-agent/error-classifier"
import { consumeNewMessages } from "../../shared/session-cursor"
import type { BackgroundOutputClient, BackgroundOutputMessage, BackgroundOutputMessagesResult } from "./clients"
import { extractMessages, getErrorMessage } from "./session-messages"
import { formatDuration } from "./time-format"
import { getBackgroundOutputFetchTimeoutMs, withSdkCallTimeout } from "./with-sdk-call-timeout"

function getTimeString(value: unknown): string {
  return typeof value === "string" ? value : ""
}

const DELIVERABLE_MAX_CHARS = 8_000
const DELIVERABLE_HEAD_CHARS = 6_000
const DELIVERABLE_TAIL_CHARS = 1_500

function truncateMiddleDeliverable(text: string): string {
  if (text.length <= DELIVERABLE_MAX_CHARS) return text
  const omittedChars = text.length - DELIVERABLE_HEAD_CHARS - DELIVERABLE_TAIL_CHARS
  const head = text.slice(0, DELIVERABLE_HEAD_CHARS)
  const tail = text.slice(text.length - DELIVERABLE_TAIL_CHARS)
  return `${head}\n\n[... ${omittedChars} chars truncated — call background_output again with full_session=true for complete output ...]\n\n${tail}`
}

export async function formatTaskResult(task: BackgroundTask, client: BackgroundOutputClient): Promise<string> {
  if (!task.sessionId) {
    return `Error: Task has no sessionID`
  }

  let messagesResult: BackgroundOutputMessagesResult
  try {
    messagesResult = await withSdkCallTimeout(
      client.session.messages({ path: { id: task.sessionId } }),
      getBackgroundOutputFetchTimeoutMs(),
    )
  } catch (error) {
    return `Error fetching messages: ${error instanceof Error ? error.message : String(error)}`
  }

  const errorMessage = getErrorMessage(messagesResult)
  if (errorMessage) {
    return `Error fetching messages: ${errorMessage}`
  }

  const messages = extractMessages(messagesResult)
  if (!Array.isArray(messages) || messages.length === 0) {
    return `Task Result

Task ID: ${task.id}
Description: ${task.description}
Duration: ${formatDuration(task.startedAt ?? new Date(), task.completedAt)}
Session ID: ${task.sessionId}

---

(No messages found)`
  }

  const relevantMessages = messages.filter((m) => m.info?.role === "assistant" || m.info?.role === "tool")
  if (relevantMessages.length === 0) {
    return `Task Result

Task ID: ${task.id}
Description: ${task.description}
Duration: ${formatDuration(task.startedAt ?? new Date(), task.completedAt)}
Session ID: ${task.sessionId}

---

(No assistant or tool response found)`
  }

  const sortedMessages = [...relevantMessages].sort((a, b) => {
    const timeA = getTimeString(a.info?.time)
    const timeB = getTimeString(b.info?.time)
    return timeA.localeCompare(timeB)
  })

  const sessionError = sortedMessages
    .filter((message) => message.info?.role === "assistant" && message.info?.error)
    .map((message) => extractErrorMessage(message.info?.error))
    .find((message): message is string => typeof message === "string" && message.length > 0)
  if (sessionError) {
    return `Task Result

Task ID: ${task.id}
Description: ${task.description}
Duration: ${formatDuration(task.startedAt ?? new Date(), task.completedAt)}
Session ID: ${task.sessionId}

---

Session error: ${sessionError}`
  }

  const newMessages = consumeNewMessages(task.sessionId, sortedMessages)
  if (newMessages.length === 0) {
    const duration = formatDuration(task.startedAt ?? new Date(), task.completedAt)
    return `Task Result

Task ID: ${task.id}
Description: ${task.description}
Duration: ${duration}
Session ID: ${task.sessionId}

---

(No new output since last check)`
  }

  function messageTextParts(message: BackgroundOutputMessage): string[] {
    return (message.parts ?? [])
      .filter((part) => part.type === "text" && typeof part.text === "string" && part.text.length > 0)
      .map((part) => part.text as string)
  }

  let deliverableText: string | undefined
  for (let i = newMessages.length - 1; i >= 0; i -= 1) {
    const message = newMessages[i]
    if (message.info?.role !== "assistant") continue
    const text = messageTextParts(message).join("\n\n").trim()
    if (text) {
      deliverableText = text
      break
    }
  }

  if (!deliverableText) {
    for (const message of newMessages.slice(-2).reverse()) {
      const text = messageTextParts(message).join("\n\n").trim()
      if (text) {
        deliverableText = text
        break
      }
    }
  }

  const toolResultCount = newMessages.reduce((count, message) => {
    return count + (message.parts ?? []).filter((part) => part.type === "tool_result").length
  }, 0)
  const duration = formatDuration(task.startedAt ?? new Date(), task.completedAt)

  if (!deliverableText) {
    return `Task Result

Task ID: ${task.id}
Description: ${task.description}
Duration: ${duration}
Session ID: ${task.sessionId}

---

(No final assistant text — call background_output again with full_session=true for the full transcript)`
  }

  const summaryNote = `(final-message summary: ${newMessages.length} new messages, ${toolResultCount} tool results omitted — use full_session=true for the full transcript)`

  return `Task Result

Task ID: ${task.id}
Description: ${task.description}
Duration: ${duration}
Session ID: ${task.sessionId}

---

${truncateMiddleDeliverable(deliverableText)}

${summaryNote}`
}
