// Compaction survival + trigger integration (plan todo 34).
//
// WIRING GAP (reported, not patched): createMemoryComponent (todo 18) registers only the
// entry renderer, the config-reload watcher, and the session binding/shutdown handlers. It
// does NOT compose the landed prompt handler (todo 20), journal wiring (todo 21), or trigger
// wiring (todo 22), and MemoryComponentOptions has no onLaunch injection point. These tests
// therefore compose the real factories on one FakeExtensionAPI exactly the way the extension
// registration (todo 36) must, injecting the launch spy through trigger-wiring's documented
// onLaunch option ("Todo 23's detached worker plugs in here"). Session state the component
// keeps private (identity context, pending ledger) is rebuilt over the SAME on-disk identity
// in a temp OMO_MEMORY_HOME, so every byte below flows through the real production modules:
// real component binding, real sentinel-block prompt audit, real reservation state machine.

import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { BeforeAgentStartEventResult } from "@code-yeongyu/senpi"
import {
  GitMemoryRepo,
  ReflectionReservationStore,
  TranscriptJournal,
  resolveMemoryIdentity,
  type MemoryIdentity,
  type ReflectionRequest,
} from "@oh-my-opencode/memory-core"

import { createMemoryBinding } from "./binding"
import {
  createMemoryIdentityContext,
  ensureIdentityRuntimeDirs,
  type MemoryPendingLedger,
} from "./context"
import { MEMORY_BINDING_CUSTOM_TYPE, createMemoryComponent } from "./index"
import {
  MemoryFakeExtensionAPI,
  componentContext,
  loadedMemoryConfig,
  memorySettings,
} from "./memory.test-support"
import { createMemoryPromptHandler } from "./prompt"
import {
  createReflectionTriggerWiring,
  resolveReflectionTriggerConfig,
  type ReflectionTriggerSession,
} from "./trigger-wiring"

const SESSION_ID = "session-compaction-survival"
const BASE_SYSTEM_PROMPT = "You are senpi, a coding agent."
const PERSONA_BODY = "Aria charts the tidal archives by lantern light."
const FIXED_CLOCK = () => new Date("2026-08-09T12:00:00.000Z")
const BRANCH = [{ id: "message-1" }, { id: "message-2" }, { id: "message-3" }] as const

const roots: string[] = []
const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

interface CompactionFixture {
  readonly pi: MemoryFakeExtensionAPI
  readonly identity: MemoryIdentity
  readonly ledger: MemoryPendingLedger
  readonly launches: ReflectionRequest[]
  readonly logs: Array<{ level: string; message: string; details?: unknown }>
}

async function compactionFixture(): Promise<CompactionFixture> {
  const root = await mkdtemp(join(tmpdir(), "omo-memory-compaction-"))
  roots.push(root)
  const cwd = join(root, "project")
  const env = { OMO_MEMORY_HOME: join(root, "memory") }
  const settings = memorySettings()
  const identity = resolveMemoryIdentity(settings.agent, cwd, env)

  // Memory content committed to the identity repo BEFORE the session binds.
  const repo = new GitMemoryRepo({ dir: identity.paths.repo, agentId: identity.id })
  await repo.init({
    seedFiles: [
      { relativePath: "system/persona.md", content: `---\ndescription: Persona\n---\n${PERSONA_BODY}\n` },
    ],
  })
  await ensureIdentityRuntimeDirs(identity.paths)

  // Real component factory (todo 18): binds the session to the identity above.
  const pi = new MemoryFakeExtensionAPI()
  createMemoryComponent({
    env,
    loadConfig: () => loadedMemoryConfig(settings),
    resolveCwd: () => cwd,
  }).register(pi, componentContext())
  await pi.dispatch("session_start", { type: "session_start" }, sessionEventContext())

  // Real prompt audit (todo 20) over the same on-disk identity, clock pinned so the compiled
  // block is byte-stable across dispatches.
  const memoryContext = createMemoryIdentityContext({
    identity: identity.id,
    identityPaths: identity.paths,
    binding: createMemoryBinding({ identity: identity.id, repoPath: identity.paths.repo, boundAt: 0 }),
  })
  pi.on(
    "before_agent_start",
    createMemoryPromptHandler({
      resolveContext: (sessionId) => (sessionId === SESSION_ID ? memoryContext : undefined),
      clock: FIXED_CLOCK,
    }),
  )

  // Real trigger wiring (todo 22) with a real reservation store; the launch spy plugs into
  // the documented onLaunch option.
  const ledger: MemoryPendingLedger = { pendingCompaction: false, configRestartNotified: false }
  const journals = new Map<string, TranscriptJournal>()
  let nextRunId = 0
  const store = new ReflectionReservationStore({
    identity,
    config: resolveReflectionTriggerConfig(settings),
    getJournal: async (conversationId) => {
      const cached = journals.get(conversationId)
      if (cached !== undefined) return cached
      const journal = new TranscriptJournal({ journalDir: join(identity.paths.transcripts, conversationId) })
      journals.set(conversationId, journal)
      return journal
    },
    createRunId: () => `reflection-run-${++nextRunId}`,
  })
  const session: ReflectionTriggerSession = { conversationId: SESSION_ID, ledger, engine: store }
  const launches: ReflectionRequest[] = []
  const logs: Array<{ level: string; message: string; details?: unknown }> = []
  createReflectionTriggerWiring({
    resolveSession: (eventCtx) => (readSessionId(eventCtx) === SESSION_ID ? session : undefined),
    onLaunch: (request) => {
      launches.push(request)
    },
    logger: {
      info: (message, details) => logs.push({ level: "info", message, details }),
      warn: (message, details) => logs.push({ level: "warn", message, details }),
      error: (message, details) => logs.push({ level: "error", message, details }),
    },
  }).register(pi)

  cleanups.push(async () => {
    await pi.dispatch("session_shutdown", { type: "session_shutdown" }, sessionEventContext())
  })
  return { pi, identity, ledger, launches, logs }
}

function sessionEventContext(): unknown {
  return {
    sessionManager: {
      getEntries: () => [],
      getSessionId: () => SESSION_ID,
      getBranch: () => [...BRANCH],
    },
    ui: { notify: () => {} },
  }
}

function readSessionId(eventCtx: unknown): string | undefined {
  if (!isRecord(eventCtx) || !isRecord(eventCtx.sessionManager)) return undefined
  const getSessionId = eventCtx.sessionManager.getSessionId
  if (typeof getSessionId !== "function") return undefined
  const id: unknown = Reflect.apply(getSessionId, eventCtx.sessionManager, [])
  return typeof id === "string" && id.length > 0 ? id : undefined
}

async function compact(pi: MemoryFakeExtensionAPI, accepted: boolean): Promise<void> {
  await pi.dispatch(
    "session_compact",
    accepted
      ? { type: "session_compact", reason: "auto", requestId: "compact-1", accepted: true, fromExtension: false, willRetry: true }
      : { type: "session_compact", reason: "manual", requestId: "compact-1", accepted: false, rejectionCause: "cancelled-by-extension", fromExtension: false, willRetry: false },
    sessionEventContext(),
  )
}

async function endRun(
  pi: MemoryFakeExtensionAPI,
  outcome: { readonly aborted?: boolean; readonly willRetry?: boolean } = {},
): Promise<void> {
  await pi.dispatch("agent_end", { type: "agent_end", messages: [], ...outcome }, sessionEventContext())
}

async function settle(pi: MemoryFakeExtensionAPI): Promise<void> {
  await pi.dispatch("agent_settled", { type: "agent_settled" }, sessionEventContext())
}

async function beforeAgentStart(pi: MemoryFakeExtensionAPI): Promise<string> {
  const results = await pi.dispatch(
    "before_agent_start",
    { type: "before_agent_start", prompt: "continue", systemPrompt: BASE_SYSTEM_PROMPT },
    sessionEventContext(),
  )
  const result = results[0] as BeforeAgentStartEventResult | undefined
  expect(result?.systemPrompt).toBeDefined()
  return result?.systemPrompt ?? ""
}

function memoryBlock(systemPrompt: string, identity: string): string {
  const begin = `<!-- senpi-memory:${identity}:begin -->`
  const end = `<!-- senpi-memory:${identity}:end -->`
  const start = systemPrompt.indexOf(begin)
  const stop = systemPrompt.indexOf(end)
  expect(start).toBeGreaterThanOrEqual(0)
  expect(stop).toBeGreaterThan(start)
  return systemPrompt.slice(start, stop + end.length)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

describe("compaction survival + trigger integration", () => {
  test("#given a bound session with committed memory #when an accepted compaction settles successfully #then exactly one reflection launches and the sentinel block survives byte-identical", async () => {
    const { pi, identity, ledger, launches } = await compactionFixture()

    // The real component bound this session to the same identity the repo was seeded under.
    expect(pi.entries).toHaveLength(1)
    expect(pi.entries[0]?.customType).toBe(MEMORY_BINDING_CUSTOM_TYPE)
    expect(pi.entries[0]?.data).toMatchObject({
      identity: identity.id,
      repoPathHash: createHash("sha256").update(identity.paths.repo, "utf8").digest("hex"),
    })

    const baseline = memoryBlock(await beforeAgentStart(pi), identity.id)
    expect(baseline).toContain(PERSONA_BODY)

    await compact(pi, true)
    expect(ledger.pendingCompaction).toBe(true)

    await endRun(pi)
    await settle(pi)

    expect(launches).toHaveLength(1)
    expect(launches[0]?.trigger).toBe("compaction")
    expect(launches[0]?.conversationIds).toEqual([SESSION_ID])
    expect(ledger.pendingCompaction).toBe(false)

    // Memory content is independent of compaction: the next run's audit injects the same block.
    const after = memoryBlock(await beforeAgentStart(pi), identity.id)
    expect(after).toBe(baseline)
    expect(after).toContain(PERSONA_BODY)
  })

  test("#given a bound session #when compaction is rejected #then no flag is recorded and settle launches nothing", async () => {
    const { pi, ledger, launches } = await compactionFixture()

    await compact(pi, false)
    expect(ledger.pendingCompaction).toBe(false)

    await endRun(pi)
    await settle(pi)

    expect(launches).toHaveLength(0)
    expect(ledger.pendingCompaction).toBe(false)
  })

  test("#given compaction accepted mid-run #when the retried turn chain settles #then exactly one launch fires across all settles", async () => {
    const { pi, ledger, launches } = await compactionFixture()

    await pi.dispatch("turn_start", { type: "turn_start", turnIndex: 0 }, sessionEventContext())
    await compact(pi, true)
    expect(ledger.pendingCompaction).toBe(true)

    // The compacted turn ends in a retry: the settle must not consume the flag or launch.
    await endRun(pi, { willRetry: true })
    await settle(pi)
    expect(launches).toHaveLength(0)
    expect(ledger.pendingCompaction).toBe(true)

    await pi.dispatch("turn_start", { type: "turn_start", turnIndex: 1 }, sessionEventContext())
    await endRun(pi)
    await settle(pi)

    expect(launches).toHaveLength(1)
    expect(launches[0]?.trigger).toBe("compaction")
    expect(ledger.pendingCompaction).toBe(false)
  })

  test("#given two consecutive accepted compactions #when the run settles #then the flag is consumed once with exactly one launch", async () => {
    const { pi, ledger, launches } = await compactionFixture()

    await compact(pi, true)
    await compact(pi, true)
    expect(ledger.pendingCompaction).toBe(true)

    await endRun(pi)
    await settle(pi)

    expect(launches).toHaveLength(1)
    expect(launches[0]?.trigger).toBe("compaction")
    expect(ledger.pendingCompaction).toBe(false)

    // Consumed: a later clean settle without a new compaction launches nothing more.
    await endRun(pi)
    await settle(pi)
    expect(launches).toHaveLength(1)
  })
})
