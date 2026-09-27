import { createHash } from "node:crypto"
import { mkdirSync, realpathSync } from "node:fs"
import { basename, join } from "node:path"

import { RunnerError } from "../in-process/runner-error"

/**
 * WHERE a process task child's host listens: one host per parent session tree, at
 * `<shardRoot>/p-<shardKey("p", rootSessionId)>.sock`. The Desktop's per-thread hosts use kind `i`.
 *
 * The naming is byte-identical to senpi's `shardKey` / `shardSocketPathForKey` / `shardSocketPath`
 * (`host-daemon-paths.ts`), so every client finds a shard from the owner id alone. The legacy socket
 * overrides (`TASK_HOST_SOCKET_ENV_NAMES`) are deliberately NOT read here: they name the operator's
 * machine-wide host, which `resolveTaskHostSocket` keeps serving for the thread tools only.
 */

export const SHARD_ROOT_ENV = "OMO_RPC_SHARD_ROOT"

/** `sun_path` is 104 bytes on macOS including its terminator (senpi `MAX_SOCKET_PATH_BYTES`). */
export const MAX_SHARD_BIND_PATH = 103

/** `open_session.context` fields: the tree's key and the key of the shard the session opened on. */
export const SHARD_KEY_CONTEXT = "shard_key"
export const TREE_KEY_CONTEXT = "tree_key"

export const NOTICE_TOKENS = { shard_alt_root: "host_notice:shard_alt_root" } as const

export type ShardKind = "p" | "i"

export type ShardNotice = keyof typeof NOTICE_TOKENS

type Env = Readonly<Record<string, string | undefined>>

// A FIXED short prefix, never `os.tmpdir()`: on darwin that is a ~48-byte `/var/folders/.../T` path,
// which pushes a shard's handoff sibling past the bind limit - the very case this root exists for.
const ALT_ROOT_PARENT = "/tmp"
const ALT_ROOT_MODE = 0o700

// The longest names a host ever binds beside its public socket: the handoff successor's
// `.next-<generation>` (senpi `generationBindPath`) and the close shield's `.shield-<pid>`.
const HANDOFF_SIBLING_SUFFIX = ".next-99"
const CLOSE_SIBLING_SUFFIX = `.shield-${"9".repeat(7)}`

const SHARD_BASENAME = /^([pi])-([0-9a-f]{16})\.sock$/

export interface ShardIdentity {
  readonly kind: "p"
  readonly key: string
  readonly ownerSessionId: string
  readonly ownerSessionFile?: string
  /** The key came from the session context (a child reusing its tree's shard), not from its own id. */
  readonly inherited: boolean
}

export interface ShardResolution {
  readonly socket: string
  readonly shard: ShardIdentity
  readonly root: "primary" | "alt"
  readonly notice?: ShardNotice
}

export interface ResolveShardSocketInput {
  readonly agentDir: string
  readonly env: Env
  readonly identity: ShardIdentity
}

export function shardRoot(env: Env, agentDir: string): string {
  return env[SHARD_ROOT_ENV]?.trim() || join(agentDir, "rpc", "shards")
}

export function altRoot(agentDir: string): string {
  return join(ALT_ROOT_PARENT, `omo-rpc-${sha256Hex(agentDir).slice(0, 8)}`)
}

/** The socket AND the siblings a host binds beside it (handoff, close shield) all fit `sun_path`. */
export function validateBindPath(socket: string): boolean {
  return (
    Buffer.byteLength(socket + HANDOFF_SIBLING_SUFFIX) <= MAX_SHARD_BIND_PATH &&
    Buffer.byteLength(socket + CLOSE_SIBLING_SUFFIX) <= MAX_SHARD_BIND_PATH
  )
}

/** Hashes a RAW owner id, exactly once: a key is never fed back into this function. */
export function shardKey(kind: ShardKind, ownerId: string): string {
  return sha256Hex(`${kind}:${ownerId}`).slice(0, 16)
}

export function shardSocketPathForKey(root: string, kind: ShardKind, key: string): string {
  return join(root, `${kind}-${key}.sock`)
}

export function shardSocketPath(root: string, kind: ShardKind, ownerId: string): string {
  return shardSocketPathForKey(root, kind, shardKey(kind, ownerId))
}

export function shardMetaPath(root: string, kind: ShardKind, key: string): string {
  return join(root, `${kind}-${key}.meta.json`)
}

export function parseShardBasename(socket: string): { readonly kind: ShardKind; readonly key: string } | null {
  const match = SHARD_BASENAME.exec(basename(socket))
  if (match === null) return null
  const [, kind, key] = match
  if ((kind !== "p" && kind !== "i") || key === undefined) return null
  return { kind, key }
}

/**
 * The shard socket for an identity: under the primary root when the socket and its siblings fit,
 * else the SAME basename under the alternate root with a `shard_alt_root` notice. Never truncates,
 * never falls back to another endpoint.
 */
export function resolveShardSocket(input: ResolveShardSocketInput): ShardResolution {
  const { identity } = input
  const primary = shardSocketPathForKey(shardRoot(input.env, input.agentDir), identity.kind, identity.key)
  if (validateBindPath(primary)) return { socket: primary, shard: identity, root: "primary" }

  const alternate = shardSocketPathForKey(ensureAltRoot(input.agentDir), identity.kind, identity.key)
  if (!validateBindPath(alternate)) {
    // Impossible for the fixed prefix; reaching it is a bug, and a bind would truncate silently.
    throw new RunnerError({
      kind: "host_unavailable",
      message: `shard_socket_too_long: ${Buffer.byteLength(alternate)}-byte shard socket under the alternate root`,
    })
  }
  return { socket: alternate, shard: identity, root: "alt", notice: "shard_alt_root" }
}

// Created 0700 on first use, then resolved through the `/tmp -> /private/tmp` symlink so every
// spelling of the root names one endpoint (senpi keys a daemon directory by the socket string).
function ensureAltRoot(agentDir: string): string {
  const root = altRoot(agentDir)
  mkdirSync(root, { recursive: true, mode: ALT_ROOT_MODE })
  return realpathSync(root)
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex")
}
