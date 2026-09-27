import { createHash } from "node:crypto"
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { afterEach, describe, expect, test } from "bun:test"

import type { RpcSpawnSpec } from "../rpc/spawn"
import { buildChildContext } from "./session-context"
import {
  MAX_SHARD_BIND_PATH,
  NOTICE_TOKENS,
  SHARD_KEY_CONTEXT,
  SHARD_ROOT_ENV,
  TREE_KEY_CONTEXT,
  altRoot,
  parseShardBasename,
  resolveShardSocket,
  shardKey,
  shardMetaPath,
  shardRoot,
  shardSocketPath,
  shardSocketPathForKey,
  validateBindPath,
  type AltRootFs,
  type ShardIdentity,
} from "./shard-socket"

// Shared naming vectors: senpi's `shardSocketPath` and the Desktop mirror pin the same literals.
const VECTORS = [
  { kind: "p", owner: "01a0e28d-40e4-7402-bac7-8de6e76ad84c", key: "6d410ba846ba1550", socket: "/r/p-6d410ba846ba1550.sock" },
  { kind: "i", owner: "thread-0001", key: "da99f196e11b1cf9", socket: "/r/i-da99f196e11b1cf9.sock" },
  { kind: "p", owner: "", key: "3ba7290d74188485", socket: "/r/p-3ba7290d74188485.sock" },
] as const

const OWNER = VECTORS[0].owner
const OWNER_KEY = VECTORS[0].key
const LONG_ROOT = `/${"r".repeat(119)}`
const LEGACY_OVERRIDES = { OMO_RPC_SOCKET: "/legacy/brand.sock", OMO_RPC_SOCKET_PATH: "/legacy/desktop.sock" }

const createdAgentDirs: string[] = []

function freshAgentDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "shard-socket-test-"))
  createdAgentDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of createdAgentDirs.splice(0)) {
    rmSync(altRoot(dir), { recursive: true, force: true })
    rmSync(dir, { recursive: true, force: true })
  }
})

function rootIdentity(): ShardIdentity {
  return { kind: "p", key: shardKey("p", OWNER), ownerSessionId: OWNER, inherited: false }
}

function inheritedIdentity(): ShardIdentity {
  return { kind: "p", key: OWNER_KEY, ownerSessionId: "child-session-0002", inherited: true }
}

function currentUid(): number {
  return process.getuid?.() ?? -1
}

const actualFs: AltRootFs = { mkdirSync, lstatSync, realpathSync, getuid: currentUid }

// senpi `daemonDirectoryName` on POSIX: the endpoint directory is keyed by the socket string.
function daemonDirectoryName(socket: string): string {
  return createHash("sha256").update(socket, "utf8").digest("hex").slice(0, 16)
}

describe("shard naming", () => {
  test("#given the shared vectors #when naming #then the key, socket and key-only socket equal the pinned literals", () => {
    for (const vector of VECTORS) {
      // when
      const key = shardKey(vector.kind, vector.owner)

      // then
      expect(key).toBe(vector.key)
      expect(key).toMatch(/^[0-9a-f]{16}$/)
      expect(shardSocketPath("/r", vector.kind, vector.owner)).toBe(vector.socket)
      expect(shardSocketPathForKey("/r", vector.kind, key)).toBe(vector.socket)
    }
  })

  test("#given one owner id #when naming under both kinds #then the sockets differ", () => {
    expect(shardSocketPath("/r", "p", OWNER)).not.toBe(shardSocketPath("/r", "i", OWNER))
  })

  test("#given a key #when naming by key #then it is used verbatim and never hashed again", () => {
    expect(shardSocketPathForKey("/r", "p", OWNER_KEY)).toBe(`/r/p-${OWNER_KEY}.sock`)
    expect(shardMetaPath("/r", "p", OWNER_KEY)).toBe(`/r/p-${OWNER_KEY}.meta.json`)
  })

  test("#given shard and foreign basenames #when parsing #then only kind-key sockets parse", () => {
    expect(parseShardBasename(`/r/p-${OWNER_KEY}.sock`)).toEqual({ kind: "p", key: OWNER_KEY })
    expect(parseShardBasename("i-da99f196e11b1cf9.sock")).toEqual({ kind: "i", key: "da99f196e11b1cf9" })
    for (const foreign of ["/r/rpc.sock", "/r/p-6d410ba8.sock", `/r/x-${OWNER_KEY}.sock`, `/r/p-${OWNER_KEY}.meta.json`, `/r/p-${OWNER_KEY.toUpperCase()}.sock`]) {
      expect(parseShardBasename(foreign)).toBeNull()
    }
  })

  test("#given the context key names and the notice token #when read #then they are the wire literals", () => {
    expect(SHARD_KEY_CONTEXT).toBe("shard_key")
    expect(TREE_KEY_CONTEXT).toBe("tree_key")
    expect(NOTICE_TOKENS.shard_alt_root).toBe("host_notice:shard_alt_root")
  })
})

describe("shardRoot", () => {
  test("#given no override #when resolving #then the root is <agentDir>/rpc/shards", () => {
    expect(shardRoot({}, "/h/.omo/agent")).toBe("/h/.omo/agent/rpc/shards")
    expect(shardRoot({ [SHARD_ROOT_ENV]: "   " }, "/h/.omo/agent")).toBe("/h/.omo/agent/rpc/shards")
  })

  test("#given OMO_RPC_SHARD_ROOT #when resolving the socket #then the override moves it", () => {
    // when
    const resolution = resolveShardSocket({ agentDir: "/h/.omo/agent", env: { [SHARD_ROOT_ENV]: " /tmp/x " }, identity: rootIdentity() })

    // then
    expect(resolution).toEqual({ socket: `/tmp/x/p-${OWNER_KEY}.sock`, shard: rootIdentity(), root: "primary" })
  })
})

describe("validateBindPath", () => {
  test("#given a darwin os.tmpdir()-shaped root #when validating #then the handoff and shield siblings overflow and it is rejected", () => {
    // given
    const socket = `/var/folders/xx/${"a".repeat(30)}/T/omo-rpc-shards/abcdef01/p-${OWNER_KEY}.sock`

    // then
    expect(Buffer.byteLength(`${socket}.next-1`)).toBe(103)
    expect(Buffer.byteLength(`${socket}.next-99`)).toBe(104)
    expect(Buffer.byteLength(`${socket}.shield-9999999`)).toBe(111)
    expect(validateBindPath(socket)).toBe(false)
  })

  test("#given a socket whose longest sibling is exactly 103 bytes #when validating #then it holds, one byte more does not", () => {
    // given
    const fits = `/${"s".repeat(MAX_SHARD_BIND_PATH - "/.shield-9999999".length)}`
    const over = `${fits}s`

    // then
    expect(Buffer.byteLength(`${fits}.shield-9999999`)).toBe(MAX_SHARD_BIND_PATH)
    expect(validateBindPath(fits)).toBe(true)
    expect(validateBindPath(over)).toBe(false)
  })
})

describe("altRoot", () => {
  test("#given any agent dir #when deriving the alternate root #then it is the fixed /tmp prefix, never os.tmpdir()", () => {
    // given
    const previous = process.env["TMPDIR"]
    process.env["TMPDIR"] = `/var/folders/xx/${"a".repeat(30)}/T`
    try {
      // when
      const root = altRoot("/h/.omo/agent")

      // then
      expect(root).toMatch(/^\/tmp\/omo-rpc-[0-9a-f]{8}$/)
      expect(root).toBe(join("/tmp", `omo-rpc-${createHash("sha256").update("/h/.omo/agent").digest("hex").slice(0, 8)}`))
      expect(root.startsWith(tmpdir())).toBe(false)
    } finally {
      if (previous === undefined) delete process.env["TMPDIR"]
      else process.env["TMPDIR"] = previous
    }
  })
})

describe("resolveShardSocket", () => {
  test("#given a fresh alternate root #when resolving #then it is created as a private directory and accepted", () => {
    const agentDir = freshAgentDir()

    const resolution = resolveShardSocket({ agentDir, env: { [SHARD_ROOT_ENV]: LONG_ROOT }, identity: rootIdentity() })

    expect(resolution.root).toBe("alt")
    expect(statSync(dirname(resolution.socket)).mode & 0o777).toBe(0o700)
  })

  test("#given a pre-existing alternate root with broad permissions #when resolving #then it throws shard_alt_root_unsafe", () => {
    const agentDir = freshAgentDir()
    const root = altRoot(agentDir)
    mkdirSync(root, { recursive: true, mode: 0o700 })
    chmodSync(root, 0o755)

    expect(() => resolveShardSocket({ agentDir, env: { [SHARD_ROOT_ENV]: LONG_ROOT }, identity: rootIdentity() })).toThrow(
      "shard_alt_root_unsafe",
    )
  })

  test("#given a symlink at the alternate root path #when resolving #then it throws shard_alt_root_unsafe", () => {
    const agentDir = freshAgentDir()
    const root = altRoot(agentDir)
    symlinkSync(agentDir, root)

    expect(() => resolveShardSocket({ agentDir, env: { [SHARD_ROOT_ENV]: LONG_ROOT }, identity: rootIdentity() })).toThrow(
      "shard_alt_root_unsafe",
    )
  })

  for (const shape of ["file", "dangling symlink"] as const) {
    test(`#given a ${shape} at the alternate root path #when resolving #then it throws shard_alt_root_unsafe`, () => {
      const agentDir = freshAgentDir()
      const root = altRoot(agentDir)
      if (shape === "file") writeFileSync(root, "occupied")
      else symlinkSync(join(agentDir, "absent"), root)

      expect(() => resolveShardSocket({ agentDir, env: { [SHARD_ROOT_ENV]: LONG_ROOT }, identity: rootIdentity() })).toThrow(
        "shard_alt_root_unsafe",
      )
    })
  }

  test("#given the created alternate root is replaced by a symlink before validation #when resolving #then it refuses the replacement", () => {
    const agentDir = freshAgentDir()
    const root = altRoot(agentDir)
    const fs: AltRootFs = {
      ...actualFs,
      lstatSync(path) {
        const stat = actualFs.lstatSync(path)
        if (path === root) {
          rmSync(root, { recursive: true })
          symlinkSync(agentDir, root)
        }
        return stat
      },
    }

    expect(() => resolveShardSocket({ agentDir, env: { [SHARD_ROOT_ENV]: LONG_ROOT }, identity: rootIdentity(), fs })).toThrow(
      "shard_alt_root_unsafe",
    )
  })

  test("#given an alternate root owned by another uid through the injected port #when resolving #then it throws shard_alt_root_unsafe", () => {
    const agentDir = freshAgentDir()
    const fs: AltRootFs = {
      ...actualFs,
      lstatSync(path) {
        const stat = actualFs.lstatSync(path)
        Object.defineProperty(stat, "uid", { value: actualFs.getuid() + 1 })
        return stat
      },
    }

    expect(() => resolveShardSocket({ agentDir, env: { [SHARD_ROOT_ENV]: LONG_ROOT }, identity: rootIdentity(), fs })).toThrow(
      "shard_alt_root_unsafe",
    )
  })

  test("#given a root and an inherited identity for one owner #when resolving #then socket, meta, parse and child context agree on one key", () => {
    // given
    const agentDir = "/h/.omo/agent"
    const baseSpec: RpcSpawnSpec = { task_id: "st_1a2b3c4d", cwd: "/tmp/project", state_dir: "/tmp/project/.omo/senpi-task", prompt: "go" }

    // when
    const root = resolveShardSocket({ agentDir, env: {}, identity: rootIdentity() })
    const inherited = resolveShardSocket({ agentDir, env: {}, identity: inheritedIdentity() })
    const context = buildChildContext({ ...baseSpec, treeKey: root.shard.key, shardKey: inherited.shard.key }).context

    // then
    expect(root.socket).toBe(`/h/.omo/agent/rpc/shards/p-${OWNER_KEY}.sock`)
    expect(inherited.socket).toBe(root.socket)
    expect(root.root).toBe("primary")
    expect(root.notice).toBeUndefined()
    expect(parseShardBasename(root.socket)?.key).toBe(OWNER_KEY)
    expect(basename(shardMetaPath(dirname(root.socket), "p", root.shard.key))).toBe(`p-${OWNER_KEY}.meta.json`)
    expect(context[SHARD_KEY_CONTEXT]).toBe(OWNER_KEY)
    expect(context[TREE_KEY_CONTEXT]).toBe(OWNER_KEY)
  })

  test("#given a 120-byte root #when resolving #then the same basename lands under the alternate root with a notice and its siblings fit", () => {
    // given
    const agentDir = freshAgentDir()

    // when
    const resolution = resolveShardSocket({ agentDir, env: { [SHARD_ROOT_ENV]: LONG_ROOT }, identity: rootIdentity() })

    // then
    expect(Buffer.byteLength(LONG_ROOT)).toBe(120)
    expect(resolution.root).toBe("alt")
    expect(resolution.notice).toBe("shard_alt_root")
    expect(resolution.shard).toEqual(rootIdentity())
    expect(basename(resolution.socket)).toBe(`p-${OWNER_KEY}.sock`)
    expect(dirname(resolution.socket)).toBe(realpathSync(altRoot(agentDir)))
    expect(validateBindPath(resolution.socket)).toBe(true)
    expect(Buffer.byteLength(`${resolution.socket}.next-99`)).toBeLessThanOrEqual(MAX_SHARD_BIND_PATH)
    expect(Buffer.byteLength(`${resolution.socket}.shield-9999999`)).toBeLessThanOrEqual(MAX_SHARD_BIND_PATH)
    expect(statSync(dirname(resolution.socket)).mode & 0o777).toBe(0o700)
  })

  test.if(process.platform === "darwin")(
    "#given darwin #when resolving under the alternate root #then it goes through /private/tmp and both spellings name one endpoint dir",
    () => {
      // given
      const agentDir = freshAgentDir()
      const alt = altRoot(agentDir)

      // when
      const resolution = resolveShardSocket({ agentDir, env: { [SHARD_ROOT_ENV]: LONG_ROOT }, identity: rootIdentity() })

      // then
      const name = basename(resolution.socket)
      expect(resolution.socket.startsWith("/private/tmp/omo-rpc-")).toBe(true)
      const viaTmp = join(realpathSync(alt), name)
      const viaPrivate = join(realpathSync(alt.replace(/^\/tmp\//, "/private/tmp/")), name)
      expect(daemonDirectoryName(viaTmp)).toBe(daemonDirectoryName(resolution.socket))
      expect(daemonDirectoryName(viaPrivate)).toBe(daemonDirectoryName(resolution.socket))
    },
  )

  test("#given the legacy socket overrides in env #when resolving under either root #then the result is unchanged", () => {
    // given
    const agentDir = freshAgentDir()

    // when / then (primary root)
    const primary = resolveShardSocket({ agentDir, env: {}, identity: rootIdentity() })
    expect(resolveShardSocket({ agentDir, env: LEGACY_OVERRIDES, identity: rootIdentity() })).toEqual(primary)

    // when / then (alternate root)
    const alt = resolveShardSocket({ agentDir, env: { [SHARD_ROOT_ENV]: LONG_ROOT }, identity: rootIdentity() })
    expect(alt.root).toBe("alt")
    expect(resolveShardSocket({ agentDir, env: { ...LEGACY_OVERRIDES, [SHARD_ROOT_ENV]: LONG_ROOT }, identity: rootIdentity() })).toEqual(alt)
  })
})
