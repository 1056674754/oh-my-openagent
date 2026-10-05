import { readFileSync } from "node:fs"
import { createOpencodeClient } from "@opencode-ai/sdk"
import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { z } from "zod"
import { isRecord } from "@oh-my-opencode/utils"
import { log } from "./logger"

/**
 * OpenCode 2.0.x (v2) plugin-host compatibility adapter.
 *
 * The v2 host loads plugins as `{ id, setup(context) }` and no longer provides
 * the legacy `PluginInput` (`client`/`directory`/`serverUrl`/`$`). Plugins also
 * register hooks through the `setup` context instead of returning a `Hooks`
 * object, which the v2 host treats as a cleanup function.
 *
 * This module:
 * 1. detects which host shape the plugin received,
 * 2. projects the v2 setup context onto the legacy `PluginInput` so the
 *    existing plugin core runs unchanged,
 * 3. bridges the legacy `Hooks` object onto v2 context registrations.
 *
 * The v2 event stream is normalized before dispatch: the wire envelope's
 * `data` fields become the legacy properties bag, and events without a v1
 * namesake are synthesized from their v2 sources (step lifecycle ->
 * `message.updated`, `session.execution.failed` -> `session.error`).
 * `message.removed` has no v2 source and is never emitted.
 *
 * Hooks without a faithful v2 equivalent are skipped and reported via `log`
 * rather than silently dropped.
 */

const MANAGED_AUTH_FILE = `${process.env.HOME ?? ""}/.config/openchamber/managed-opencode-auth.json`
const DEFAULT_SERVER_BASE_URL = "http://127.0.0.1:4096"

type BasicLogger = (message: string, data?: Record<string, unknown>) => void

export function isLegacyPluginInput(input: unknown): boolean {
  if (!isRecord(input)) return false
  return typeof input.directory === "string" && input.client !== null && typeof input.client === "object"
}

function resolveServerPort(argv: readonly string[]): number | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (typeof arg !== "string") continue
    if (arg === "--port") {
      const value = argv[index + 1]
      const port = Number.parseInt(value ?? "", 10)
      if (Number.isInteger(port) && port > 0) return port
    }
    if (arg.startsWith("--port=")) {
      const port = Number.parseInt(arg.slice("--port=".length), 10)
      if (Number.isInteger(port) && port > 0) return port
    }
  }
  return undefined
}

export function resolveServerBaseUrl(argv: readonly string[] = process.argv): string {
  const port = resolveServerPort(argv) ?? Number.parseInt(process.env.OPENCODE_PORT ?? "", 10)
  if (Number.isInteger(port) && port > 0) return `http://127.0.0.1:${port}`
  return DEFAULT_SERVER_BASE_URL
}

let cachedManagedAuth: { header?: string } | undefined

/**
 * Managed (OpenChamber-embedded) OpenCode instances require HTTP Basic auth.
 * Vanilla OpenCode has no auth file; absence must stay compatible, so any read
 * failure simply yields no header.
 */
function readManagedAuthHeader(): string | undefined {
  if (cachedManagedAuth) return cachedManagedAuth.header
  let header: string | undefined
  try {
    const raw = readFileSync(MANAGED_AUTH_FILE, "utf8")
    const parsed: unknown = JSON.parse(raw)
    const password = isRecord(parsed) && typeof parsed.password === "string" ? parsed.password : undefined
    if (password) {
      header = `Basic ${Buffer.from(`opencode:${password}`, "utf8").toString("base64")}`
      process.env.OPENCODE_SERVER_USERNAME = process.env.OPENCODE_SERVER_USERNAME ?? "opencode"
      process.env.OPENCODE_SERVER_PASSWORD = process.env.OPENCODE_SERVER_PASSWORD ?? password
    }
  } catch {
    header = undefined
  }
  cachedManagedAuth = { header }
  return header
}

function createAuthedFetch(authHeader: string): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const headers = new Headers(request.headers)
    headers.set("Authorization", authHeader)
    return fetch(new Request(request, { headers }))
  }
}

// ---------------------------------------------------------------------------
// v2 host context (structural types; the fork's effect-plugin types are not a
// dependency of this package, so the shapes are kept minimal and permissive).
// ---------------------------------------------------------------------------

type V2Registration = { dispose?: () => Promise<void> | void }

type V2PermissionRule = { action: string; resource: string; effect: string }

type V2AgentMutable = {
  model?: unknown
  fallbacks?: unknown
  request?: { headers?: Record<string, unknown>; body?: Record<string, unknown> }
  system?: string
  description?: string
  mode?: string
  hidden?: boolean
  color?: string
  steps?: number
  permissions: V2PermissionRule[]
}

type V2AgentEditor = {
  list(): readonly unknown[]
  get(id: string): unknown
  update(id: string, fn: (agent: V2AgentMutable) => void): void
  remove(id: string): void
  default(id: string | undefined): void
}

type V2McpEditor = {
  set(name: string, config: unknown): void
}

type V2ToolExecuteContext = {
  sessionID: string
  agent: string
  messageID: string
  id: string
  signal?: AbortSignal
  progress: (update: Record<string, unknown>) => Promise<void>
}

type V2ToolInfo = {
  name: string
  input: unknown
  description: string
  execute: (input: unknown, context: V2ToolExecuteContext) => Promise<unknown>
}

type V2ToolEditor = {
  list(): readonly { readonly id: string }[]
  add(tool: V2ToolInfo): void
  remove(id: string): void
}

type V2SessionContextEvent = {
  sessionID: string
  agent: string
  model: { id?: string; providerID?: string; variant?: string }
  system: Array<{ type: string; text: string }>
  options: Record<string, unknown>
}

type V2ModelRequestEvent = {
  sessionID: string
  agent: string
  model: { id?: string; providerID?: string }
  headers: Record<string, string>
}

type V2SessionPromptEvent = {
  sessionID: string
  messageID: string
  prompt: { text?: string; files?: unknown; agents?: unknown; skills?: unknown }
  metadata?: Record<string, unknown>
  delivery?: string
}

export type V2HostContext = {
  location?: { directory?: unknown }
  options?: Record<string, unknown>
  agent?: { transform: (callback: (editor: V2AgentEditor) => void) => Promise<V2Registration> }
  mcp?: { transform: (callback: (editor: V2McpEditor) => void) => Promise<V2Registration> }
  tool?: {
    transform: (callback: (editor: V2ToolEditor) => void) => Promise<V2Registration>
    hook: (
      name: "execute.before" | "execute.after",
      callback: (event: Record<string, unknown>) => Promise<void> | void,
    ) => Promise<V2Registration>
  }
  event?: { subscribe: (options?: { signal?: AbortSignal }) => AsyncIterable<unknown> }
  session?: {
    hook: (
      name: string,
      callback: (event: unknown) => Promise<void> | void,
    ) => Promise<V2Registration>
    get?: (input: { sessionID: string }) => Promise<unknown>
    switchModel?: (input: {
      sessionID: string
      model: { providerID: string; id: string; variant?: string }
    }) => Promise<unknown>
  }
}

// ---------------------------------------------------------------------------
// Legacy input projection
// ---------------------------------------------------------------------------

const unusedShellStub = (() => {
  throw new Error("[oh-my-openagent] the $ Bun shell is not available on the OpenCode v2 host")
}) as unknown as PluginInput["$"]

export function buildV2LegacyInput(hostContext: unknown, logger: BasicLogger): PluginInput {
  const context = (isRecord(hostContext) ? hostContext : {}) as V2HostContext
  const locationDirectory = isRecord(context.location) ? context.location.directory : undefined
  const directory = typeof locationDirectory === "string" && locationDirectory.length > 0
    ? locationDirectory
    : process.cwd()
  logger("[v2-host] plugin input projection", {
    locationType: typeof locationDirectory,
    directoryFallback: typeof locationDirectory === "string" ? undefined : "process.cwd()",
    directory,
  })

  const baseUrl = resolveServerBaseUrl()
  const authHeader = readManagedAuthHeader()
  logger("[v2-host] legacy client target", { baseUrl, managedAuth: authHeader !== undefined })

  const client = createOpencodeClient({
    baseUrl,
    ...(authHeader !== undefined ? { fetch: createAuthedFetch(authHeader) } : {}),
  })

  return {
    client,
    // OMO does not read input.project (verified by source inventory); the v2
    // host exposes no project object, so it stays unset.
    project: undefined as unknown as PluginInput["project"],
    directory,
    worktree: directory,
    experimental_workspace: { register: () => {} },
    serverUrl: new URL(baseUrl),
    $: unusedShellStub,
  }
}

// ---------------------------------------------------------------------------
// Hooks bridge: legacy Hooks object -> v2 context registrations
// ---------------------------------------------------------------------------

type V1AgentDefinition = Record<string, unknown>

function parseModelRef(input: unknown, variant?: unknown): Record<string, unknown> | undefined {
  if (typeof input !== "string" || input.length === 0) return undefined
  const hashIndex = input.indexOf("#")
  const base = hashIndex >= 0 ? input.slice(0, hashIndex) : input
  const inlineVariant = hashIndex >= 0 ? input.slice(hashIndex + 1) : undefined
  const slashIndex = base.indexOf("/")
  if (slashIndex <= 0) return undefined
  const resolvedVariant = typeof variant === "string" && variant.length > 0
    ? variant
    : typeof inlineVariant === "string" && inlineVariant.length > 0
      ? inlineVariant
      : undefined
  return {
    providerID: base.slice(0, slashIndex),
    id: base.slice(slashIndex + 1),
    ...(resolvedVariant !== undefined ? { variant: resolvedVariant } : {}),
  }
}

/** Mirrors the fork's ConfigMigrateV1.normalizeAction mapping. */
function normalizePermissionAction(action: string): string {
  if (action === "write" || action === "patch") return "edit"
  if (action === "task") return "subagent"
  if (action === "bash") return "shell"
  return action
}

function convertV1Permissions(permission: unknown, tools: unknown): V2PermissionRule[] | undefined {
  const rules: V2PermissionRule[] = []
  if (isRecord(tools)) {
    for (const [tool, enabled] of Object.entries(tools)) {
      rules.push({
        action: normalizePermissionAction(tool),
        resource: "*",
        effect: enabled === false ? "deny" : "allow",
      })
    }
  }
  if (isRecord(permission)) {
    for (const [key, rule] of Object.entries(permission)) {
      if (rule === undefined || rule === null) continue
      const action = normalizePermissionAction(key)
      if (typeof rule === "string") {
        rules.push({ action, resource: "*", effect: rule })
        continue
      }
      if (isRecord(rule)) {
        for (const [resource, effect] of Object.entries(rule)) {
          rules.push({ action, resource, effect: String(effect) })
        }
      }
    }
  }
  return rules.length > 0 ? rules : undefined
}

/** Ports the fork's ConfigMigrateV1.migrateAgent onto an AgentEditor mutator. */
function applyV1AgentToEditor(id: string, definition: V1AgentDefinition, editor: V2AgentEditor): void {
  if (definition.disable === true || definition.disabled === true) {
    editor.remove(id)
    return
  }
  editor.update(id, (agent) => {
    const model = parseModelRef(definition.model, definition.variant)
    if (model !== undefined) agent.model = model

    const body: Record<string, unknown> = {}
    if (isRecord(definition.options)) Object.assign(body, definition.options)
    if (typeof definition.temperature === "number") body.temperature = definition.temperature
    if (typeof definition.top_p === "number") body.top_p = definition.top_p
    if (Object.keys(body).length > 0) {
      agent.request = agent.request ?? { headers: {}, body: {} }
      agent.request.body = { ...(agent.request.body ?? {}), ...body }
    }

    if (typeof definition.prompt === "string") agent.system = definition.prompt
    if (typeof definition.description === "string") agent.description = definition.description
    if (definition.mode === "subagent" || definition.mode === "primary" || definition.mode === "all") {
      agent.mode = definition.mode
    }
    if (typeof definition.hidden === "boolean") agent.hidden = definition.hidden
    if (typeof definition.color === "string") {
      agent.color = definition.color.startsWith("#") ? definition.color : "#aaaaaa"
    }
    if (typeof definition.steps === "number") agent.steps = definition.steps
    else if (typeof definition.maxSteps === "number") agent.steps = definition.maxSteps

    const permissions = convertV1Permissions(definition.permission, definition.tools)
    if (permissions !== undefined) agent.permissions.push(...permissions)
  })
}

function normalizeMcpTimeout(value: unknown): { catalog: number; execution: number } | undefined {
  if (typeof value === "number") return { catalog: value, execution: value }
  if (isRecord(value) && typeof value.catalog === "number" && typeof value.execution === "number") {
    return { catalog: value.catalog, execution: value.execution }
  }
  return undefined
}

/** Ports the fork's ConfigMigrateV1.migrateMcp (oauth fields deferred). */
function convertMcpEntry(entry: unknown): Record<string, unknown> | undefined {
  if (!isRecord(entry)) return undefined
  const type = entry.type
  if (type !== "local" && type !== "remote") return undefined
  const disabled = entry.enabled === false || entry.disabled === true ? true : undefined
  const timeout = normalizeMcpTimeout(entry.timeout)
  const base: Record<string, unknown> = { type, ...(disabled !== undefined ? { disabled } : {}) }
  if (timeout !== undefined) base.timeout = timeout
  if (type === "local") {
    return {
      ...base,
      command: entry.command,
      ...(entry.cwd !== undefined ? { cwd: entry.cwd } : {}),
      ...(isRecord(entry.environment) ? { environment: entry.environment } : {}),
    }
  }
  return {
    ...base,
    url: entry.url,
    ...(isRecord(entry.headers) ? { headers: entry.headers } : {}),
  }
}

/**
 * Builds the legacy config seed the config hook mutates. Seeds from the v2
 * merged config (`GET /api/config` entries) so host settings survive, with
 * v2-only shapes normalized to the v1 keys OMO reads.
 */
async function buildConfigSeed(baseUrl: string, authHeader: string | undefined): Promise<Record<string, unknown>> {
  const seed: Record<string, unknown> = {}
  try {
    const response = await fetch(`${baseUrl}/api/config`, {
      headers: authHeader !== undefined ? { Authorization: authHeader } : undefined,
    })
    if (!response.ok) throw new Error(`GET /api/config -> ${response.status}`)
    const entries: unknown = await response.json()
    if (Array.isArray(entries)) {
      for (const entry of entries) {
        if (isRecord(entry) && isRecord(entry.info)) Object.assign(seed, entry.info)
      }
    }
  } catch (error) {
    log("[v2-host] config seed fetch failed; continuing with an empty seed", {
      error: error instanceof Error ? error.message : String(error),
    })
  }
  // v2 `model` object -> v1 "provider/model" string (OMO treats it as a string).
  if (isRecord(seed.model)) {
    const providerID = seed.model.providerID
    const modelID = seed.model.model ?? seed.model.id
    seed.model = typeof providerID === "string" && typeof modelID === "string" ? `${providerID}/${modelID}` : undefined
  }
  // v2 `mcp: { servers: {...} }` -> v1 flat record so OMO's merge stays flat.
  if (isRecord(seed.mcp) && isRecord(seed.mcp.servers)) {
    seed.mcp = { ...seed.mcp.servers }
  }
  // v2 config-file agents are applied natively by the host; do not double-apply.
  delete seed.agents
  return seed
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function wildcardToRegex(pattern: string): RegExp {
  return new RegExp(`^${pattern.split("*").map(escapeRegex).join(".*")}$`, "i")
}

/**
 * Projects a legacy tool result onto a v2 Tool.Result for a tool registered
 * without an output schema. `output` must stay absent - the host treats a
 * result that "declares output without an output schema" as a defect and dies
 * the whole call - so everything the legacy tool produced is folded into
 * `content`, which the host accepts as a plain string or as Content parts.
 */
function bridgeToolResult(result: unknown): Record<string, unknown> {
  if (typeof result === "string") return { content: result }
  if (!isRecord(result)) return { content: "" }
  const metadata: Record<string, unknown> = { ...(isRecord(result.metadata) ? result.metadata : {}) }
  if (typeof result.title === "string") metadata.title = result.title

  const parts: Array<Record<string, unknown>> = []
  if (typeof result.output === "string") parts.push({ type: "text", text: result.output })
  if (Array.isArray(result.attachments)) {
    for (const attachment of result.attachments) {
      if (!isRecord(attachment) || attachment.type !== "file") continue
      parts.push({
        type: "file",
        uri: attachment.url,
        mime: attachment.mime,
        ...(typeof attachment.filename === "string" ? { name: attachment.filename } : {}),
      })
    }
  }

  return {
    // An empty part list would stringify to the text "undefined" during host
    // normalization; an empty string normalizes to an empty text part.
    content: parts.length > 0 ? parts : "",
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
  }
}

/** The textual projection of a v2 tool result, wherever the text lives. */
function resultText(result: Record<string, unknown>): string {
  if (typeof result.output === "string") return result.output
  if (typeof result.content === "string") return result.content
  if (Array.isArray(result.content)) {
    return result.content
      .filter((part) => isRecord(part) && part.type === "text")
      .map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : ""))
      .join("\n")
  }
  return ""
}

function shallowRecordEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  if (Object.keys(a).length !== Object.keys(b).length) return false
  for (const [key, value] of Object.entries(a)) {
    if (!(key in b) || b[key] !== value) return false
  }
  return true
}

// ---------------------------------------------------------------------------
// Tool args -> plain JSON Schema
// ---------------------------------------------------------------------------

/**
 * v1 hosts consume the per-field `_zod.toJSONSchema` compat shim that
 * `normalizeToolArgSchemas` installs on every registered tool. The v2 host
 * converts tool input through zod's standard interface instead, which crashes
 * on that override ("seen.ref" TypeError in flattenRef) — and the host then
 * drops the whole registration with only a server-log ERROR, invisible to the
 * plugin. The shim is v1-only dead weight in a v2 process, so it is removed
 * before conversion, and the args are handed over as a plain JSON Schema
 * (the branch of v2 `inputJsonSchema` that returns the object verbatim) to
 * keep the host's own zod out of the path entirely.
 */
function toolInputJsonSchema(args: unknown): Record<string, unknown> {
  const fields: Record<string, z.ZodType> = {}
  for (const [key, field] of Object.entries(isRecord(args) ? args : {})) {
    const schema = field as z.ZodType & { _zod?: { toJSONSchema?: unknown } }
    if (
      schema !== null &&
      typeof schema === "object" &&
      schema._zod !== undefined &&
      typeof schema._zod.toJSONSchema === "function"
    ) {
      delete schema._zod.toJSONSchema
    }
    fields[key] = schema
  }
  try {
    const { $schema: _root, ...rest } = z.toJSONSchema(z.object(fields)) as Record<string, unknown>
    return rest
  } catch (error) {
    log("[v2-host] tool arg conversion failed; registering with an unvalidated input schema", {
      error: error instanceof Error ? error.message : String(error),
    })
    return {}
  }
}

// ---------------------------------------------------------------------------
// v2 event stream -> legacy event normalization
// ---------------------------------------------------------------------------

type LegacyEvent = { type: string; properties: Record<string, unknown> }

function assistantMessageInfo(data: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const model = isRecord(data.model) ? data.model : {}
  return {
    id: data.assistantMessageID,
    sessionID: data.sessionID,
    role: "assistant",
    ...(typeof data.agent === "string" ? { agent: data.agent } : {}),
    ...(typeof model.providerID === "string" ? { providerID: model.providerID } : {}),
    ...(typeof model.id === "string" ? { modelID: model.id } : {}),
    ...(typeof model.variant === "string" ? { variant: model.variant } : {}),
    ...patch,
  }
}

/**
 * Projects the native v2 event vocabulary onto the legacy (v1) event shapes
 * OMO's handlers consume.
 *
 * v2 has no message-entity events: assistant message birth and finish are
 * derived from the step lifecycle, and session errors surface through
 * `session.execution.failed` (v1 `session.error`). `message.removed` has no
 * v2 source at all and is never synthesized.
 */
export function mapV2EventToLegacyEvents(type: string, data: Record<string, unknown>): LegacyEvent[] {
  if (type === "session.step.started") {
    return [{ type: "message.updated", properties: { info: assistantMessageInfo(data, {}) } }]
  }
  if (type === "session.step.ended") {
    return [{ type: "message.updated", properties: { info: assistantMessageInfo(data, { finish: data.finish }) } }]
  }
  if (type === "session.execution.failed") {
    const error = isRecord(data.error) ? data.error : {}
    const details: Record<string, unknown> = {}
    if (error.status !== undefined) details.status = error.status
    if (error.response !== undefined) details.response = error.response
    return [{
      type: "session.error",
      properties: {
        sessionID: data.sessionID,
        error: {
          name: typeof error.type === "string" ? error.type : "unknown",
          message: typeof error.message === "string" ? error.message : "",
          ...(Object.keys(details).length > 0 ? { data: details } : {}),
        },
      },
    }]
  }
  return [{ type, properties: data }]
}

export async function registerV2Hooks(
  hooks: Hooks,
  hostContext: unknown,
  deps: { directory: string; logger: BasicLogger },
): Promise<() => Promise<void>> {  const context = (isRecord(hostContext) ? hostContext : {}) as V2HostContext
  // Legacy hook handlers validate their own inputs (createChatParamsHandler and
  // friends normalize unknown payloads), so the bridge calls them through the
  // untyped boundary and passes the defensively-shaped objects they expect.
  type LegacyInputOutputHandler = (input: unknown, output: unknown) => Promise<void>
  const asHandler = (handler: unknown): LegacyInputOutputHandler => handler as LegacyInputOutputHandler
  const disposers: Array<() => Promise<void> | void> = []
  const register = async (name: string, task: () => Promise<V2Registration | void>): Promise<void> => {
    try {
      const registration = await task()
      if (registration?.dispose) disposers.push(registration.dispose)
    } catch (error) {
      deps.logger(`[v2-host] failed to bridge ${name}`, {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  // --- config hook: agents, default agent, MCP, tool disables ----------------
  if (typeof hooks.config === "function") {
    await register("config hook", async () => {
      const baseUrl = resolveServerBaseUrl()
      const seed = await buildConfigSeed(baseUrl, readManagedAuthHeader())
      await hooks.config?.(seed as Parameters<NonNullable<Hooks["config"]>>[0])
      deps.logger("[v2-host] config hook applied", {
        agents: isRecord(seed.agent) ? Object.keys(seed.agent).length : 0,
        commands: isRecord(seed.command) ? Object.keys(seed.command).length : 0,
        mcp: isRecord(seed.mcp) ? Object.keys(seed.mcp).length : 0,
      })

      if (isRecord(seed.agent) && context.agent) {
        await register("agent transform", async () => {
          const definitions = seed.agent as Record<string, V1AgentDefinition>
          await context.agent?.transform((editor) => {
            for (const [id, definition] of Object.entries(definitions)) {
              if (!isRecord(definition)) continue
              applyV1AgentToEditor(id, definition, editor)
            }
            if (typeof seed.default_agent === "string") editor.default(seed.default_agent)
          })
        })
      }

      if (isRecord(seed.mcp) && context.mcp) {
        await register("mcp transform", async () => {
          const servers = seed.mcp as Record<string, unknown>
          await context.mcp?.transform((editor) => {
            for (const [name, entry] of Object.entries(servers)) {
              const converted = convertMcpEntry(entry)
              if (converted !== undefined) editor.set(name, converted)
            }
          })
        })
      }

      if (isRecord(seed.tools) && context.tool) {
        await register("tool disable transform", async () => {
          const disables = seed.tools as Record<string, unknown>
          await context.tool?.transform((editor) => {
            for (const [pattern, enabled] of Object.entries(disables)) {
              if (enabled !== false) continue
              if (pattern.includes("*")) {
                const regex = wildcardToRegex(pattern)
                for (const tool of editor.list()) {
                  if (regex.test(tool.id)) editor.remove(tool.id)
                }
              } else {
                editor.remove(pattern)
              }
            }
          })
        })
      }
    })
  }

  // --- tool registration -----------------------------------------------------
  if (hooks.tool && context.tool) {
    await register("tool registration", async () => {
      const definitions = hooks.tool as Record<string, { description: string; args: unknown; execute: unknown }>
      await context.tool?.transform((editor) => {
        for (const [name, definition] of Object.entries(definitions)) {
          if (!isRecord(definition) || typeof definition.execute !== "function") continue
          const execute = definition.execute as (
            args: unknown,
            toolContext: Record<string, unknown>,
          ) => Promise<unknown>
          editor.add({
            name,
            description: typeof definition.description === "string" ? definition.description : "",
            input: toolInputJsonSchema(definition.args),
            execute: async (input: unknown, toolContext: V2ToolExecuteContext) => {
              const directory = deps.directory
              const legacyContext = {
                sessionID: toolContext.sessionID,
                messageID: toolContext.messageID,
                agent: toolContext.agent,
                directory,
                worktree: directory,
                abort: toolContext.signal ?? new AbortController().signal,
                metadata: (update: { title?: string; metadata?: Record<string, unknown> }) =>
                  toolContext.progress({
                    ...(update.title !== undefined ? { title: update.title } : {}),
                    ...(update.metadata ?? {}),
                  }),
                // v2 Tool.Context has no ask: tools cannot create permission
                // requests. Leaving it absent makes monitor_start fall back to
                // its allowlist and skill skip its prompt, instead of the
                // silent-approve stub this bridge used to install.
              }
              return bridgeToolResult(await execute(input, legacyContext))
            },
          })
        }
      })
      deps.logger("[v2-host] tools registered", { count: Object.keys(hooks.tool ?? {}).length })
    })
  }

  // --- event hook ------------------------------------------------------------
  const eventDomain = context.event
  if (typeof hooks.event === "function" && eventDomain) {
    await register("event stream", async () => {
      const handler = hooks.event as (input: { event: Record<string, unknown> }) => Promise<void>
      const subscribe = eventDomain.subscribe
      const controller = new AbortController()
      void (async () => {
        try {
          for await (const raw of subscribe({ signal: controller.signal })) {
            if (!isRecord(raw)) continue
            const type = typeof raw.type === "string" ? raw.type : ""
            if (type.length === 0) continue
            // v2 frames events as { id, type, created, data, ... }; legacy
            // handlers expect the data fields as the properties bag.
            const data = isRecord(raw.data) ? raw.data : raw
            for (const event of mapV2EventToLegacyEvents(type, data)) {
              try {
                await handler({ event: { type: event.type, properties: event.properties } })
              } catch (error) {
                deps.logger("[v2-host] event handler failed", {
                  type: event.type,
                  error: error instanceof Error ? error.message : String(error),
                })
              }
            }
          }
        } catch (error) {
          if (!controller.signal.aborted) {
            deps.logger("[v2-host] event stream ended", {
              error: error instanceof Error ? error.message : String(error),
            })
          }
        }
      })()
      disposers.push(() => controller.abort())
    })
  }

  // --- tool execute before/after ---------------------------------------------
  if (typeof hooks["tool.execute.before"] === "function" && context.tool) {
    const handler = asHandler(hooks["tool.execute.before"])
    await register("tool.execute.before hook", async () =>
      context.tool?.hook("execute.before", async (event) => {
        const output = { args: event.input }
        await handler(
          {
            tool: String(event.tool ?? ""),
            sessionID: String(event.sessionID ?? ""),
            callID: String(event.id ?? ""),
          },
          output,
        )
        event.input = output.args
      }),
    )
  }

  if (typeof hooks["tool.execute.after"] === "function" && context.tool) {
    const handler = asHandler(hooks["tool.execute.after"])
    await register("tool.execute.after hook", async () =>
      context.tool?.hook("execute.after", async (event) => {
        if (event.status !== "completed") return
        const result = isRecord(event.result) ? event.result : {}
        const originalMetadata = isRecord(result.metadata) ? result.metadata : {}
        const originalText = resultText(result)
        const output = {
          title: typeof result.title === "string" ? result.title : undefined,
          output: originalText,
          metadata: { ...originalMetadata },
        }
        await handler(
          {
            tool: String(event.tool ?? ""),
            sessionID: String(event.sessionID ?? ""),
            callID: String(event.id ?? ""),
            args: event.input,
          },
          output,
        )
        const metadata = { ...output.metadata }
        if (output.title !== undefined) metadata.title = output.title
        // Write back only what the legacy handler changed, and never through
        // an `output` key: this hook fires for every tool on the host, and a
        // v2 result must not declare output for a tool without an output
        // schema. Untouched results keep their reference so foreign tools
        // preserve typed output and content.
        const patch: Record<string, unknown> = {}
        if (output.output !== originalText) patch.content = output.output
        if (!shallowRecordEqual(metadata, originalMetadata)) patch.metadata = metadata
        if (Object.keys(patch).length > 0) event.result = { ...result, ...patch }
      }),
    )
  }

  // --- chat.params -> session.hook("context") generation options --------------
  if (typeof hooks["chat.params"] === "function" && context.session) {
    const handler = asHandler(hooks["chat.params"])
    await register("chat.params hook", async () =>
      context.session?.hook("context", async (raw) => {
        const event = raw as V2SessionContextEvent
        if (!event || typeof event.sessionID !== "string" || !isRecord(event.options)) return
        const output: Record<string, unknown> = {
          temperature: event.options.temperature,
          topP: event.options.topP,
          topK: event.options.topK,
          maxOutputTokens: event.options.maxTokens,
          options: event.options,
        }
        const message: { variant?: string } = {
          variant: typeof event.model?.variant === "string" ? event.model.variant : undefined,
        }
        await handler(
          {
            sessionID: event.sessionID,
            agent: { name: event.agent },
            model: { providerID: event.model?.providerID ?? "", modelID: event.model?.id ?? "" },
            provider: { id: event.model?.providerID ?? "" },
            message,
          },
          output,
        )
        for (const key of ["temperature", "topP", "topK"] as const) {
          if (typeof output[key] === "number") event.options[key] = output[key]
          else delete event.options[key]
        }
        if (typeof output.maxOutputTokens === "number") event.options.maxTokens = output.maxOutputTokens
        else delete event.options.maxTokens
      }),
    )
  }

  // --- chat.headers -> session.hook("model.request") --------------------------
  if (typeof hooks["chat.headers"] === "function" && context.session) {
    const handler = asHandler(hooks["chat.headers"])
    await register("chat.headers hook", async () =>
      context.session?.hook("model.request", async (raw) => {
        const event = raw as V2ModelRequestEvent
        if (!event || typeof event.sessionID !== "string") return
        const output = { headers: event.headers }
        await handler(
          {
            sessionID: event.sessionID,
            agent: event.agent,
            model: { providerID: event.model?.providerID ?? "", modelID: event.model?.id ?? "" },
            provider: { id: event.model?.providerID ?? "" },
            message: {},
          },
          output,
        )
      }),
    )
  }

  // --- chat.message -> session.hook("prompt") --------------------------------
  //
  // v2 has no chat.message namesake. The user prompt's mutable pre-generation
  // projection is `session.hook("prompt")`, which fires for typed prompts and
  // rendered command prompts alike. The prompt text is projected onto the
  // legacy parts array (one text part); the session agent/model are fetched
  // best-effort because SessionPrompt carries neither. A model override set on
  // output.message.model is applied through session.switchModel, i.e. as a
  // session-level selection effective from this prompt onward — v2 has no
  // single-message model override.
  if (typeof hooks["chat.message"] === "function" && context.session) {
    const handler = asHandler(hooks["chat.message"])
    await register("chat.message hook", async () =>
      context.session?.hook("prompt", async (raw) => {
        const event = raw as V2SessionPromptEvent
        if (!event || typeof event.sessionID !== "string" || !isRecord(event.prompt)) return
        const originalText = typeof event.prompt.text === "string" ? event.prompt.text : ""

        let agent: string | undefined
        let model: { providerID: string; modelID: string } | undefined
        try {
          const info = await context.session?.get?.({ sessionID: event.sessionID })
          if (isRecord(info)) {
            if (typeof info.agent === "string") agent = info.agent
            const ref = isRecord(info.model) ? info.model : undefined
            const refModel = ref ? (typeof ref.model === "string" ? ref.model : typeof ref.id === "string" ? ref.id : undefined) : undefined
            if (ref && typeof ref.providerID === "string" && refModel !== undefined) {
              model = { providerID: ref.providerID, modelID: refModel }
            }
          }
        } catch {
          // agent/model stay undefined; legacy handlers treat both as optional
        }

        const output: Record<string, unknown> = {
          message: {},
          parts: [{ type: "text", text: originalText }],
        }
        await handler({ sessionID: event.sessionID, agent, model }, output)

        const parts = Array.isArray(output.parts) ? output.parts : []
        const textParts = parts.filter((part) => isRecord(part) && part.type === "text")
        if (parts.length !== textParts.length) {
          deps.logger("[v2-host] chat.message injected non-text parts with no v2 prompt sink", {
            sessionID: event.sessionID,
            dropped: parts.length - textParts.length,
          })
        }
        const nextText = textParts.map((part) => (typeof part.text === "string" ? part.text : "")).join("\n")
        if (nextText !== originalText) event.prompt.text = nextText

        const override = isRecord(output.message) ? output.message.model : undefined
        if (isRecord(override) && typeof override.providerID === "string" && typeof override.modelID === "string") {
          try {
            await context.session?.switchModel?.({
              sessionID: event.sessionID,
              model: { providerID: override.providerID, id: override.modelID },
            })
          } catch (error) {
            deps.logger("[v2-host] chat.message model override failed", {
              sessionID: event.sessionID,
              error: error instanceof Error ? error.message : String(error),
            })
          }
        }
      }),
    )
  }

  // --- experimental.chat.system.transform -> session.hook("context") ---------
  if (typeof hooks["experimental.chat.system.transform"] === "function" && context.session) {
    const handler = asHandler(hooks["experimental.chat.system.transform"])
    await register("system transform hook", async () =>
      context.session?.hook("context", async (raw) => {
        const event = raw as V2SessionContextEvent
        if (!event || !Array.isArray(event.system)) return
        const before = event.system.map((part) => (isRecord(part) ? String(part.text ?? "") : ""))
        const output = { system: [...before] }
        await handler(
          {
            sessionID: typeof event.sessionID === "string" ? event.sessionID : undefined,
            model: { id: event.model?.id ?? "", providerID: event.model?.providerID ?? "" },
          },
          output,
        )
        for (let index = 0; index < before.length; index += 1) {
          const next = output.system[index]
          if (typeof next !== "string" || next === before[index]) continue
          if (isRecord(event.system[index])) event.system[index] = { ...event.system[index], text: next }
        }
        for (let index = before.length; index < output.system.length; index += 1) {
          if (typeof output.system[index] === "string") {
            event.system.push({ type: "text", text: output.system[index] })
          }
        }
      }),
    )
  }

  // --- experimental.session.compacting -> session.hook("compaction") ---------
  if (typeof hooks["experimental.session.compacting"] === "function" && context.session) {
    const handler = asHandler(hooks["experimental.session.compacting"])
    await register("session.compacting hook", async () =>
      context.session?.hook("compaction", async (raw) => {
        const event = raw as V2SessionContextEvent
        if (!event || typeof event.sessionID !== "string" || !Array.isArray(event.system)) return
        const output = { context: [] as string[], prompt: undefined as string | undefined }
        await handler({ sessionID: event.sessionID }, output)
        for (const text of output.context) {
          if (typeof text === "string" && text.length > 0) event.system.push({ type: "text", text })
        }
      }),
    )
  }

  // --- hooks without a v2 equivalent ------------------------------------------
  const skipped = (["command.execute.before", "experimental.chat.messages.transform", "tool.definition", "experimental.compaction.autocontinue", "auth", "provider"] as const).filter(
    (key) => hooks[key] !== undefined,
  )
  if (skipped.length > 0) {
    log("[v2-host] hooks without a v2 equivalent were skipped", { hooks: skipped })
  }

  return async () => {
    for (const dispose of disposers) {
      try {
        await dispose()
      } catch (error) {
        deps.logger("[v2-host] registration dispose failed", {
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }
}
