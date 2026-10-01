import { CHILD_PERMISSION_EVENT, parseChildExtensionEvent, readSessionAncestry, type ChildExtensionEvent } from "@oh-my-opencode/senpi-task"
import * as z from "zod"
import type { SenpiExtensionAPI } from "../../extension/types"
import { computerUseSessionId } from "../telemetry/omo-native-computer-use"

export const TASK_CHILD_EXTENSION_EVENT = "omo.task.child_extension_event"
const ROOT_PERMISSION_EVENT = "omo.computer.permission_required"
const forwardedSchema = z.object({
  parent_session_id: z.string(),
  root_session_id: z.string(),
  event: z.unknown(),
})
const markerSchema = z.object({
  type: z.literal("custom"),
  customType: z.literal(ROOT_PERMISSION_EVENT),
  data: z.object({ session_id: z.string(), permission: z.enum(["screen_recording", "accessibility"]) }),
})

/** Root identity belongs to session_start, never to a shared tool's in-process child context. */
export function wireComputerPermissionEvents(pi: SenpiExtensionAPI, env: NodeJS.ProcessEnv) {
  const seen = new Map<string, Set<ChildExtensionEvent["permission"]>>()
  let sessionId: string | undefined
  let unsubscribe: (() => void) | undefined
  const report = (permission: Omit<ChildExtensionEvent, "type">): void => {
    if (sessionId === undefined || pi.rpc === undefined) return
    const event: ChildExtensionEvent = { type: CHILD_PERMISSION_EVENT, ...permission }
    if (readSessionAncestry(pi, env) !== undefined) {
      pi.rpc.emit(CHILD_PERMISSION_EVENT, event)
      return
    }
    const permissions = seen.get(sessionId) ?? new Set<ChildExtensionEvent["permission"]>()
    if (permissions.has(event.permission)) return
    permissions.add(event.permission)
    seen.set(sessionId, permissions)
    const data = { session_id: sessionId, permission: event.permission, ...(event.app === undefined ? {} : { app: event.app }) }
    pi.appendEntry?.(ROOT_PERMISSION_EVENT, { session_id: sessionId, permission: event.permission })
    pi.rpc.emit(ROOT_PERMISSION_EVENT, data)
  }
  pi.on("session_start", (_payload, context) => {
    sessionId = computerUseSessionId(context)
    if (sessionId === undefined) return
    const permissions = seen.get(sessionId) ?? new Set<ChildExtensionEvent["permission"]>()
    if (typeof context === "object" && context !== null && "sessionManager" in context) {
      const manager = context.sessionManager
      if (typeof manager === "object" && manager !== null && "getEntries" in manager && typeof manager.getEntries === "function") {
        const entries: unknown = manager.getEntries()
        if (Array.isArray(entries)) for (const entry of entries) {
          const marker = markerSchema.safeParse(entry)
          if (marker.success && marker.data.data.session_id === sessionId) permissions.add(marker.data.data.permission)
        }
      }
    }
    seen.set(sessionId, permissions)
    unsubscribe?.()
    unsubscribe = pi.events?.on(TASK_CHILD_EXTENSION_EVENT, (value) => {
      const parsed = forwardedSchema.safeParse(value)
      if (!parsed.success || parsed.data.parent_session_id !== sessionId) return
      const root = readSessionAncestry(pi, env)?.rootSessionId ?? sessionId
      if (parsed.data.root_session_id !== root) return
      const event = parseChildExtensionEvent(parsed.data.event)
      if (event !== undefined) report(event)
    })
  })
  pi.on("session_shutdown", () => {
    unsubscribe?.()
    unsubscribe = undefined
    sessionId = undefined
  })
  return report
}
