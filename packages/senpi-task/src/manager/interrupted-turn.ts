import { open } from "node:fs/promises"

const INITIAL_TAIL_BYTES = 64 * 1024

/**
 * Session entries that are not part of the conversation: extension state (`custom`), extension
 * context notes (`custom_message`) and session metadata. A live session appends them after its last
 * message - the hooks' stop state when a turn stops, the rules scan and memory binding a host writes
 * when it reopens the session - so they never decide whether the turn was answered.
 */
const BOOKKEEPING_ENTRY_TYPES = new Set([
  "custom",
  "custom_message",
  "session_info",
  "model_change",
  "thinking_level_change",
  "label",
  "compaction",
  "branch_summary",
])

export async function sessionTailNeedsContinuation(sessionPath: string): Promise<boolean> {
  try {
    const message = await readLastConversationMessage(sessionPath)
    if (message === undefined) return false
    if (message.role === "user" || message.role === "toolResult") return true
    if (message.role !== "assistant") return false
    if (message.stopReason === "aborted") return true
    if (!Array.isArray(message.content)) return false
    return message.content.some((part) => isRecord(part) && part.type === "toolCall")
  } catch {
    return false
  }
}

type TailVerdict =
  | { readonly kind: "message"; readonly message: SessionMessageEntry["message"] }
  | { readonly kind: "skip" }
  | { readonly kind: "stop" }

// Walk back from the ACTUAL final non-empty JSONL record over bookkeeping entries to the last
// conversation message. Start with the normal 64 KiB tail and grow backwards whenever the window's
// complete records are exhausted (an oversized record, or a long bookkeeping run). A malformed
// record or an entry of an unknown type ends the walk undecided: it is never skipped to
// reinterpret an earlier user message as unanswered.
async function readLastConversationMessage(sessionPath: string): Promise<SessionMessageEntry["message"] | undefined> {
  const file = await open(sessionPath, "r")
  try {
    const size = (await file.stat()).size
    if (size === 0) return undefined
    let bytes = Math.min(size, INITIAL_TAIL_BYTES)
    for (;;) {
      const start = size - bytes
      const buffer = Buffer.allocUnsafe(bytes)
      const { bytesRead } = await file.read(buffer, 0, bytes, start)
      const lines = buffer.subarray(0, bytesRead).toString("utf8").split("\n")
      // A window that does not begin the file may begin mid-record; that record is re-read whole
      // once the window grows past its start.
      const complete = start === 0 ? lines : lines.slice(1)
      for (let index = complete.length - 1; index >= 0; index -= 1) {
        const line = complete[index]?.trim() ?? ""
        if (line.length === 0) continue
        const verdict = classifyRecord(line)
        if (verdict.kind === "message") return verdict.message
        if (verdict.kind === "stop") return undefined
      }
      if (start === 0) return undefined
      bytes = Math.min(size, bytes * 2)
    }
  } finally {
    await file.close()
  }
}

function classifyRecord(line: string): TailVerdict {
  const parsed: unknown = JSON.parse(line)
  if (isSessionMessageEntry(parsed)) return { kind: "message", message: parsed.message }
  if (isRecord(parsed) && typeof parsed.type === "string" && BOOKKEEPING_ENTRY_TYPES.has(parsed.type)) return { kind: "skip" }
  return { kind: "stop" }
}

type SessionMessageEntry = {
  readonly type: "message"
  readonly message: {
    readonly role?: string
    readonly content?: readonly unknown[]
    readonly stopReason?: string
  }
}

function isSessionMessageEntry(value: unknown): value is SessionMessageEntry {
  return isRecord(value) && value.type === "message" && isRecord(value.message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
