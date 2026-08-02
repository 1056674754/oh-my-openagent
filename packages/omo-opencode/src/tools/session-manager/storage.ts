import type { PluginInput } from "@opencode-ai/plugin"
import { createOpencodeClient } from "@opencode-ai/sdk"
import { isSqliteBackend } from "../../shared/opencode-storage-detection"
import { log } from "../../shared"
import { getFileAllSessions, getFileMainSessions, fileSessionExists, getFileSessionInfo, getFileSessionMessages, getFileSessionTodos, getFileSessionTranscript } from "./file-storage"
import { getSdkAllSessions, getSdkMainSessions, getSdkSessionMessages, getSdkSessionTodos, sdkSessionExists, shouldFallbackFromSdkError } from "./sdk-storage"
import type { SessionInfo, SessionMessage, SessionMetadata, TodoItem } from "./types"

export interface GetMainSessionsOptions {
  directory?: string
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
// Directory-corrected SDK client used for session.list(). Built from
// SetStorageClientOptions.{serverUrl, directory} with OpenChamber suffixes stripped,
// so the server-side ?directory= filter matches session.directory. Falls back to sdkClient.
let directoryLessListClient: PluginInput["client"] | null = null

// The OpencodeClient class keeps its raw SDK config behind a protected `_client`
// field. We reflect into it to clone the auth headers + fetch wrapper from the
// ctx-injected client (OpenCode injects ServerAuth headers there) so the
// directory-corrected client can authenticate against the same server. Without those
// headers the server returns 401 and the SDK surfaces a non-Error rejection that
// tool callers stringify as "Error: [object Object]".
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
  return { headers, fetch: config.fetch as typeof fetch | undefined }
}

export function setStorageClient(
  client: PluginInput["client"],
  options?: SetStorageClientOptions,
): void {
  sdkClient = client
  directoryLessListClient = null
  if (options?.serverUrl) {
    try {
      const { headers, fetch: fetchFn } = extractClientConfig(client)
      const realDirectory = options.directory !== undefined
        ? normalizeProjectFilter(options.directory)
        : undefined
      const cfg: { baseUrl: string; headers?: Record<string, string>; fetch?: typeof fetch; directory?: string } = {
        baseUrl: options.serverUrl.toString(),
      }
      if (headers && Object.keys(headers).length > 0) cfg.headers = headers
      if (fetchFn) cfg.fetch = fetchFn
      if (realDirectory) cfg.directory = realDirectory
      directoryLessListClient = createOpencodeClient(cfg) as PluginInput["client"]
    } catch (error) {
      log("[session-manager] failed to build directory-corrected list client; falling back to ctx client for session.list()", {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
}

export function resetStorageClient(): void {
  sdkClient = null
  directoryLessListClient = null
}

// Pick the client for session.list(). Prefer the directory-less client so the server
// does not silently filter sessions by the (possibly mismatched) ctx.directory.
function pickListClient(): PluginInput["client"] | null {
  return directoryLessListClient ?? sdkClient
}

export async function getMainSessions(options: GetMainSessionsOptions): Promise<SessionMetadata[]> {
  const directory = normalizeProjectFilter(options.directory)
  const listClient = pickListClient()
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

export async function getAllSessions(): Promise<string[]> {
  const listClient = pickListClient()
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
