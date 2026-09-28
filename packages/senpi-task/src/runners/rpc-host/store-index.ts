import { join, resolve } from "node:path"

import { withTaskRecordLockAsync } from "../../store/record-lock"
import { DURABLE_JSON_FS, isRecord, type DurableJsonFs } from "./durable-json"

/**
 * The agent-dir STORE INDEX: every task store that ever opened a child on a host of this agent dir.
 * It is append-only and outlives every endpoint - a dead shard's records and transcripts stay in
 * their stores and still need migrating on a rollback - so no idle exit or gc ever touches it.
 * Registering is an admission precondition: a child is opened only once its store reads back here.
 */

export const TASK_STORE_INDEX_VERSION = 1

interface StoreIndexEntry {
  readonly first_seen: string
  // Written equal to first_seen: an entry is never rewritten, but version 1 readers require the field.
  readonly last_seen: string
}

export interface TaskStoreIndex {
  readonly version: typeof TASK_STORE_INDEX_VERSION
  readonly stores: Readonly<Record<string, StoreIndexEntry>>
}

export class StoreIndexUnavailableError extends Error {
  override readonly name = "StoreIndexUnavailableError"
  readonly indexPath: string

  constructor(indexPath: string, cause: unknown) {
    super(`store_index_unavailable: ${indexPath}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause })
    this.indexPath = indexPath
  }
}

export function taskStoreIndexPath(agentDir: string): string {
  return join(agentDir, "rpc", "task-stores.json")
}

export interface RegisterStoreIndexInput {
  readonly indexPath: string
  readonly storeDir: string
  readonly now: () => number
  readonly fs?: DurableJsonFs
}

export async function registerStoreIndex(input: RegisterStoreIndexInput): Promise<void> {
  const fs = input.fs ?? DURABLE_JSON_FS
  const storeDir = resolve(input.storeDir)
  try {
    await withTaskRecordLockAsync(input.indexPath, async () => {
      const current = parseStoreIndex(fs.read(input.indexPath))
      // Already registered: the entry is durable (it read back under this lock), so an admission for a
      // known store costs one read and never a rewrite and fsync of the whole index.
      if (current.stores[storeDir] !== undefined) return
      const seenAt = new Date(input.now()).toISOString()
      const next: TaskStoreIndex = {
        version: TASK_STORE_INDEX_VERSION,
        stores: { ...current.stores, [storeDir]: { first_seen: seenAt, last_seen: seenAt } },
      }
      fs.write(input.indexPath, `${JSON.stringify(next, null, 2)}\n`)
      if (parseStoreIndex(fs.read(input.indexPath)).stores[storeDir] === undefined) {
        throw new Error("the written index does not read back the store")
      }
    })
  } catch (error) {
    throw new StoreIndexUnavailableError(input.indexPath, error)
  }
}

export function readTaskStoreIndex(indexPath: string, fs: DurableJsonFs = DURABLE_JSON_FS): TaskStoreIndex {
  return parseStoreIndex(fs.read(indexPath))
}

// A missing index is empty; an index that does not parse is NOT - rewriting it would drop every
// store it named, so a corrupt file fails the admission instead.
function parseStoreIndex(text: string | undefined): TaskStoreIndex {
  if (text === undefined) return { version: TASK_STORE_INDEX_VERSION, stores: {} }
  const parsed: unknown = JSON.parse(text)
  if (!isRecord(parsed) || parsed.version !== TASK_STORE_INDEX_VERSION || !isRecord(parsed.stores)) {
    throw new Error("the store index is not a version 1 index")
  }
  const stores: Record<string, StoreIndexEntry> = {}
  for (const [dir, entry] of Object.entries(parsed.stores)) {
    if (!isRecord(entry) || typeof entry.first_seen !== "string" || typeof entry.last_seen !== "string") {
      throw new Error(`the store index entry for ${dir} is malformed`)
    }
    stores[dir] = { first_seen: entry.first_seen, last_seen: entry.last_seen }
  }
  return { version: TASK_STORE_INDEX_VERSION, stores }
}
