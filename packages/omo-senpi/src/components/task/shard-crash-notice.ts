import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { join, win32 } from "node:path"

import {
  parseShardBasename,
  type HostShardEvents,
  type ReattachOutcome,
  type ReattachOutcomeInfo,
  type TransportLostInfo,
} from "@oh-my-opencode/senpi-task"

import type { HostNotices } from "./host-execution-mode"
import type { CapturedUi } from "./runtime-context"

/**
 * ONE parent-visible notice per task-host crash, and one closing line once its children are back.
 *
 * Every child that loses the same host generation (socket + instanceId) belongs to one episode - a
 * key, never a time window. The episode is announced at its first child that had a turn in flight
 * (a host that dies with nothing running is re-ensured silently by the next spawn) and closed when
 * its last outstanding child reports how its recovery ended. Both lines go to the session's notice
 * list (`task_output`) AND to `ui.notify`, which a host-attached session forwards as an
 * `extension_ui_request` notify the Desktop renders as a thread row.
 */

export const SHARD_CRASH_TOKEN = "host_shard_crash"
export const SHARD_CRASH_DONE_TOKEN = "host_shard_crash_done"

export interface ShardCrashFacts {
  readonly pid?: number
  readonly cause?: string
}

export interface ShardCrashNoticeDeps {
  readonly agentDir: string
  readonly notices: HostNotices
  readonly ui: () => CapturedUi | undefined
  readonly now?: () => number
  readonly readCrash?: (agentDir: string, socket: string, instanceId: string, now: number) => ShardCrashFacts
}

interface Episode {
  readonly id: string
  readonly key: string
  readonly outstanding: Set<string>
  readonly outcomes: ReattachOutcome[]
  announced: boolean
}

export function createShardCrashNotices(deps: ShardCrashNoticeDeps): Required<HostShardEvents> {
  const readCrash = deps.readCrash ?? readNewestHostCrash
  const now = deps.now ?? Date.now
  const open = new Map<string, Episode>()
  const closed = new Set<string>()
  const episodeOfTask = new Map<string, Episode>()

  const emit = (token: string, text: string, type: "warning" | "info"): void => {
    deps.notices.add(text, token)
    deps.ui()?.notify(text, type)
  }

  const announce = (episode: Episode, info: TransportLostInfo): void => {
    episode.announced = true
    const crash = readCrash(deps.agentDir, info.socket, info.instanceId, now())
    const text = `${SHARD_CRASH_TOKEN}:${episode.key} Background task host crashed (shard ${episode.key}, pid ${crash.pid ?? "unknown"}, ${crash.cause ?? "cause unknown"}): reattaching ${episode.outstanding.size} children...`
    emit(`${SHARD_CRASH_TOKEN}:${episode.id}`, text, "warning")
  }

  const close = (episode: Episode): void => {
    open.delete(episode.id)
    closed.add(episode.id)
    if (!episode.announced) return
    const continued = episode.outcomes.filter((outcome) => outcome === "continued").length
    const lost = episode.outcomes.filter((outcome) => outcome === "lost" || outcome === "host_incompatible").length
    const text = `${SHARD_CRASH_DONE_TOKEN}:${episode.key} ${episode.outcomes.length} reattached: ${continued} continued mid-turn, ${lost} lost`
    emit(`${SHARD_CRASH_DONE_TOKEN}:${episode.id}`, text, "info")
  }

  return {
    onTransportLost: (info) => {
      const id = `${info.socket}\u0000${info.instanceId}`
      // A straggler of an episode that already closed is not a new crash.
      if (closed.has(id)) return
      let episode = open.get(id)
      if (episode === undefined) {
        episode = { id, key: endpointKey(info.socket), outstanding: new Set(), outcomes: [], announced: false }
        open.set(id, episode)
      }
      episode.outstanding.add(info.taskId)
      episodeOfTask.set(info.taskId, episode)
      if (info.turnWasInFlight && !episode.announced) announce(episode, info)
    },
    onReattachOutcome: (info: ReattachOutcomeInfo) => {
      const episode = episodeOfTask.get(info.taskId)
      if (episode === undefined || !episode.outstanding.delete(info.taskId)) return
      episodeOfTask.delete(info.taskId)
      episode.outcomes.push(info.outcome)
      if (episode.outstanding.size === 0) close(episode)
    },
  }
}

function endpointKey(socket: string): string {
  return parseShardBasename(socket)?.key ?? daemonDirectoryName(socket)
}

/** senpi's `daemonDirectoryName`: `sha256(socket)[:16]`, over the case-folded normalized path on win32. */
function daemonDirectoryName(socket: string): string {
  const canonical = process.platform === "win32" ? win32.normalize(socket).toLowerCase() : socket
  return createHash("sha256").update(canonical, "utf8").digest("hex").slice(0, 16)
}

/** A record older than this belongs to an earlier crash of the endpoint, not the one being announced. */
const CRASH_RECORD_FRESH_MS = 5 * 60_000

// The generation's pid survives only when the crash path has not cleaned its record yet.
export function readNewestHostCrash(agentDir: string, socket: string, instanceId: string, now: number): ShardCrashFacts {
  const dir = join(agentDir, "rpc-host-daemon", daemonDirectoryName(socket))
  const pid = readPid(join(dir, "generations", instanceId, "host.pid"))
  const newest = readLines(join(dir, "crashes.jsonl")).map(parseRecord).findLast((record) => record !== undefined)
  const fresh = newest !== undefined && now - Date.parse(newest.at) <= CRASH_RECORD_FRESH_MS
  const cause = fresh ? newest.cause : undefined
  return { ...(pid === undefined ? {} : { pid }), ...(cause === undefined ? {} : { cause }) }
}

function parseRecord(line: string): { readonly at: string; readonly cause?: string } | undefined {
  const value = parseJson(line)
  if (value === undefined || typeof value.at !== "string" || Number.isNaN(Date.parse(value.at))) return undefined
  if (typeof value.signal === "string") return { at: value.at, cause: value.signal }
  if (typeof value.code === "number") return { at: value.at, cause: `exit code ${value.code}` }
  return { at: value.at }
}

function readPid(file: string): number | undefined {
  const pid = parseJson(readText(file) ?? "")?.pid
  return typeof pid === "number" && Number.isInteger(pid) && pid > 0 ? pid : undefined
}

function readLines(file: string): readonly string[] {
  return (readText(file) ?? "").split("\n").filter((line) => line.trim().length > 0)
}

function readText(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8")
  } catch {
    return undefined
  }
}

function parseJson(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text)
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}
