import type { PluginInput } from "@opencode-ai/plugin"
import { createOpencodeClient } from "@opencode-ai/sdk"
import { isSqliteBackend } from "../../shared/opencode-storage-detection"
import { log } from "../../shared"
import { getFileAllSessions, getFileMainSessions, fileSessionExists, getFileSessionInfo, getFileSessionMessages, getFileSessionTodos, getFileSessionTranscript } from "./file-storage"
import { getSdkAllSessions, getSdkMainSessions, getSdkSessionMessages, getSdkSessionTodos, sdkSessionExists, shouldFallbackFromSdkError } from "./sdk-storage"
import type { SessionInfo, SessionMessage, SessionMetadata, TodoItem } from "./types"

export interface GetMainSessionsOptions {
  directory?: string
  serverUrl?: URL
}

export interface SetStorageClientOptions {
  /**
   * When provided, a directory-corrected SDK client is built from this URL and used
   * for session.list() queries. OpenChamber's embedded launcher injects a server-
   * relative ctx.directory (e.g. "<workdir>/current", "/") that the OpenCode server
   * cannot match against session.directory, silently emptying every list/search call.
   * When `serverUrl` + `directory` are provided, a new client is built with the
   * normalized real-workdir directory, so the server-side ?directory= filter returns
   * the correct project's sessions.
   */
  serverUrl?: URL
  directory?: string
}

// OpenChamber embedded multi-server launcher appends these to ctx.directory; real
// session.directory never has them. Stripped by normalizeProjectFilter.
const OPENCHAMBER_DIRECTORY_SUFFIXES = ["current", "root"] as const

// In multi-project server mode (opencode web / opencode serve / OpenChamber embedded)
// ctx.directory is either the filesystem root "/" or an OpenChamber server-relative
// path like "<workdir>/current". Neither matches a stored session.directory, so every
// session would be silently dropped — normalize these cases before filtering.
export function normalizeProjectFilter(directory?: string): string | undefined {
  if (!directory) return undefined
  if (directory === "/") return undefined

  for (const suffix of OPENCHAMBER_DIRECTORY_SUFFIXES) {
    const suffixSegment = `/${suffix}`
    if (directory.endsWith(suffixSegment)) {
      const stripped = directory.slice(0, -suffixSegment.length)
      return stripped || undefined
    }
  }

  return directory
}

function mergeSessionMetadataLists(
  sdkSessions: SessionMetadata[],
  fileSessions: SessionMetadata[],
): SessionMetadata[] {
  const merged = new Map<string, SessionMetadata>()

  for (const session of fileSessions) {
    merged.set(session.id, session)
  }

  for (const session of sdkSessions) {
    merged.set(session.id, session)
  }

  return [...merged.values()].sort((a, b) => b.time.updated - a.time.updated)
}

function mergeSessionIds(sdkSessionIds: string[], fileSessionIds: string[]): string[] {
  return [...new Set([...sdkSessionIds, ...fileSessionIds])]
}

// SDK client reference for beta mode
let sdkClient: PluginInput["client"] | null = null
// OpenChamber embedded mode loads OMO once per project, and each setStorageClient
// call overwrites the previous ctx. A single directory-corrected client cannot
// serve all queries, so we cache the server URL + auth/fetch pieces here and build
// per-query-directory clients on demand.
let listClientBase: { serverUrl?: URL; headers?: Record<string, string>; fetch?: typeof fetch } = {}
const directoryClientCache = new Map<string, PluginInput["client"]>()

// The OpencodeClient class keeps its raw SDK config behind a protected `_client`
// field. We reflect into it to clone the auth headers + fetch wrapper from the
// ctx-injected client (OpenCode injects ServerAuth headers there) so per-directory
// list clients can authenticate against the same server. Without those headers the
// server returns 401 and the SDK surfaces a non-Error rejection that tool callers
// stringify as "Error: [object Object]".
function extractClientConfig(client: PluginInput["client"]): {
  headers?: Record<string, string>
  fetch?: typeof fetch
} {
  const inner = (client as unknown as { _client?: { getConfig?: () => Record<string, unknown> } })?._client
  const config = inner?.getConfig?.() ?? {}
  const rawHeaders = config.headers as Headers | Record<string, string> | undefined
  const entries = rawHeaders instanceof Headers
    ? Array.from(rawHeaders.entries())
    : Object.entries(rawHeaders ?? {})
  const headers: Record<string, string> = {}
  for (const [key, value] of entries) {
    if (key.toLowerCase() === "x-opencode-directory") continue
    headers[key] = String(value)
  }
  // Robustness fallback: if no Authorization header was extracted from the client
  // (e.g. ServerAuth.headers() returned undefined at plugin load time), construct
  // Basic auth from the environment. This keeps session-manager functional even
  // when ctx.client has no auth headers.
  const hasAuthorization = Object.keys(headers).some((k) => k.toLowerCase() === "authorization")
  if (!hasAuthorization) {
    const password = process.env.OPENCODE_SERVER_PASSWORD
    if (password) {
      const username = process.env.OPENCODE_SERVER_USERNAME ?? "opencode"
      headers["Authorization"] = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`
    }
  }
  return { headers, fetch: config.fetch as typeof fetch | undefined }
}

export function setStorageClient(
  client: PluginInput["client"],
  options?: SetStorageClientOptions,
): void {
  sdkClient = client
  listClientBase = {}
  directoryClientCache.clear()
  if (options?.serverUrl) {
    try {
      const { headers, fetch: fetchFn } = extractClientConfig(client)
      listClientBase = { serverUrl: options.serverUrl, headers, fetch: fetchFn }
    } catch (error) {
      log("[session-manager] failed to extract auth headers from ctx.client; falling back to ctx client for session.list()", {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
}

// Build (or fetch from cache) a list client for the given query directory, so the
// server-side ?directory= filter matches session.directory for that project.
// overrideServerUrl lets each tool invocation pass its own ctx.serverUrl,
// preventing a remote-instance load from hijacking the module-level singleton.
function pickListClient(queryDirectory?: string, overrideServerUrl?: URL): PluginInput["client"] | null {
  if (!sdkClient) return null
  const effectiveServerUrl = overrideServerUrl ?? listClientBase.serverUrl
  if (!effectiveServerUrl) return sdkClient
  const normalized = queryDirectory !== undefined ? normalizeProjectFilter(queryDirectory) : undefined
  if (!normalized) return sdkClient
  const cacheKey = `${normalized}::${effectiveServerUrl.toString()}`
  const cached = directoryClientCache.get(cacheKey)
  if (cached) return cached
  try {
    const cfg: { baseUrl: string; headers?: Record<string, string>; fetch?: typeof fetch; directory: string } = {
      baseUrl: effectiveServerUrl.toString(),
      directory: normalized,
    }
    // When the override server differs from the module-level one, the stored
    // headers may be for the wrong server. Reconstruct auth from env in that case.
    let hdrs = listClientBase.headers
    const serverMismatch = !!overrideServerUrl
      && !!listClientBase.serverUrl
      && effectiveServerUrl.toString() !== listClientBase.serverUrl.toString()
    if (serverMismatch) {
      hdrs = undefined
    }
    if (hdrs && Object.keys(hdrs).length > 0) {
      cfg.headers = hdrs
    }
    // Env-based auth fallback (also covers serverMismatch case where hdrs was cleared)
    const hasAuth = cfg.headers && Object.keys(cfg.headers).some((k) => k.toLowerCase() === "authorization")
    if (!hasAuth) {
      const password = process.env.OPENCODE_SERVER_PASSWORD
      if (password) {
        const username = process.env.OPENCODE_SERVER_USERNAME ?? "opencode"
        cfg.headers = {
          ...(cfg.headers ?? {}),
          Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`,
        }
      }
    }
    if (listClientBase.fetch) cfg.fetch = listClientBase.fetch
    const client = createOpencodeClient(cfg) as PluginInput["client"]
    directoryClientCache.set(cacheKey, client)
    return client
  } catch (error) {
    log("[session-manager] failed to build directory-corrected list client; falling back to ctx client", {
      directory: normalized,
      error: error instanceof Error ? error.message : String(error),
    })
    return sdkClient
  }
}

export function resetStorageClient(): void {
  sdkClient = null
  listClientBase = {}
  directoryClientCache.clear()
}

export async function getMainSessions(options: GetMainSessionsOptions): Promise<SessionMetadata[]> {
  const directory = normalizeProjectFilter(options.directory)
  const listClient = pickListClient(options.directory, options.serverUrl)
  if (isSqliteBackend() && listClient) {
    try {
      const sdkSessions = await getSdkMainSessions(listClient, directory)
      const fileSessions = await getFileMainSessions(directory)
      return mergeSessionMetadataLists(sdkSessions, fileSessions)
    } catch (error) {
      if (!shouldFallbackFromSdkError(error)) throw error
      log("[session-manager] falling back to file session list after SDK unavailable error", { error: String(error) })
    }
  }

  return getFileMainSessions(directory)
}

export async function getAllSessions(queryDirectory?: string, overrideServerUrl?: URL): Promise<string[]> {
  const listClient = pickListClient(queryDirectory, overrideServerUrl) ?? sdkClient
  if (isSqliteBackend() && listClient) {
    try {
      const sdkSessionIds = await getSdkAllSessions(listClient)
      const fileSessionIds = await getFileAllSessions()
      return mergeSessionIds(sdkSessionIds, fileSessionIds)
    } catch (error) {
      if (!shouldFallbackFromSdkError(error)) throw error
      log("[session-manager] falling back to file session ids after SDK unavailable error", { error: String(error) })
    }
  }

  return getFileAllSessions()
}

export { getMessageDir } from "../../shared/opencode-message-dir"

export async function sessionExists(sessionID: string): Promise<boolean> {
  if (isSqliteBackend() && sdkClient) {
    try {
      const existsInSdk = await sdkSessionExists(sdkClient, sessionID)
      if (existsInSdk) return true
    } catch (error) {
      if (!shouldFallbackFromSdkError(error)) throw error
      log("[session-manager] falling back to file sessionExists after SDK unavailable error", { error: String(error), sessionID })
    }
  }
  return fileSessionExists(sessionID)
}

export async function readSessionMessages(sessionID: string): Promise<SessionMessage[]> {
  if (isSqliteBackend() && sdkClient) {
    try {
      const sdkMessages = await getSdkSessionMessages(sdkClient, sessionID)
      if (sdkMessages.length > 0) return sdkMessages
    } catch (error) {
      if (!shouldFallbackFromSdkError(error)) throw error
      log("[session-manager] falling back to file session messages after SDK unavailable error", { error: String(error), sessionID })
    }
  }

  return getFileSessionMessages(sessionID)
}

export async function readSessionTodos(sessionID: string): Promise<TodoItem[]> {
  if (isSqliteBackend() && sdkClient) {
    try {
      const sdkTodos = await getSdkSessionTodos(sdkClient, sessionID)
      if (sdkTodos.length > 0) return sdkTodos
    } catch (error) {
      if (!shouldFallbackFromSdkError(error)) throw error
      log("[session-manager] falling back to file session todos after SDK unavailable error", { error: String(error), sessionID })
    }
  }

  return getFileSessionTodos(sessionID)
}

export async function readSessionTranscript(sessionID: string): Promise<number> {
  return getFileSessionTranscript(sessionID)
}

export async function getSessionInfo(sessionID: string): Promise<SessionInfo | null> {
  if (isSqliteBackend() && sdkClient) {
    try {
      const sdkMessages = await getSdkSessionMessages(sdkClient, sessionID)
      if (sdkMessages.length > 0) {
        const agentsUsed = new Set<string>()
        let firstMessage: Date | undefined
        let lastMessage: Date | undefined

        for (const msg of sdkMessages) {
          if (msg.agent) agentsUsed.add(msg.agent)
          if (msg.time?.created) {
            const date = new Date(msg.time.created)
            if (!firstMessage || date < firstMessage) firstMessage = date
            if (!lastMessage || date > lastMessage) lastMessage = date
          }
        }

        const todos = await readSessionTodos(sessionID)
        const transcriptEntries = await readSessionTranscript(sessionID)

        return {
          id: sessionID,
          message_count: sdkMessages.length,
          first_message: firstMessage,
          last_message: lastMessage,
          agents_used: Array.from(agentsUsed),
          has_todos: todos.length > 0,
          has_transcript: transcriptEntries > 0,
          todos,
          transcript_entries: transcriptEntries,
        }
      }
    } catch (error) {
      if (!shouldFallbackFromSdkError(error)) throw error
      log("[session-manager] falling back to file session info after SDK unavailable error", { error: String(error), sessionID })
    }
  }

  return getFileSessionInfo(sessionID)
}
