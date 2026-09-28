// Process, memory and endpoint readers for task-host-e2e-shard-cost.mjs (rpc-host-sharding todo 15).
//
// Two configurations run side by side, each from its own provisioned HOME under one short /tmp run
// root: `sharded` = the compiled omo binary built from this branch (every parent's process children
// on its own `p-*` shard), `control` = the pre-change R0 build (`--before-bin`, every child on the one
// `rpc/rpc.sock` host). Everything below reads the SANDBOX only: agent dirs, sockets and pids are
// the run's own, and a process is only ever signalled when this run started it.
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { stopParent } from "./task-host-e2e-events.mjs"
import { lastJsonLine, pidAlive, runBin, sandboxProcesses, spawnParent, waitFor } from "./task-host-e2e-process.mjs"
import { binaryDigest, createScenarioSandbox, injectDaemonMockProvider, provisionRuntime } from "./task-host-e2e-sandbox.mjs"

const scriptDir = dirname(fileURLToPath(import.meta.url))
export const MOCK_ENTRY = join(scriptDir, "task-host-e2e-shard-cost-mock-provider.mjs")
export const CHILD_TEXT = [{ type: "text", text: "shard cost child turn complete" }]
/** A child that stays mid-turn: the mock holds its one provider request open for `ms`. */
export const heldChild = (ms) => [{ type: "text", text: "held shard cost child", delayMs: ms }]

/** Provision one configuration's binary runtime under its own HOME and seed the keyless mock provider. */
export function provisionConfig(kind, bin, runRoot) {
  const root = join(runRoot, kind === "sharded" ? "S" : "C")
  mkdirSync(root, { recursive: true })
  const runtime = provisionRuntime(bin, root)
  const injected = injectDaemonMockProvider(runtime.pluginRoot, MOCK_ENTRY)
  // The routing wrapper imports the base mock by relative path, so the base travels with it.
  copyFileSync(join(scriptDir, "task-host-e2e-mock-provider.mjs"), join(runtime.pluginRoot, "task-host-e2e-mock-provider.mjs"))
  if (!injected.launchSpecPresent) throw new Error(`${kind} binary ships no daemon launch spec: ${bin}`)
  return { kind, bin, root, home: runtime.home, pluginRoot: runtime.pluginRoot, specPath: injected.specPath, version: runtime.version, digest: binaryDigest(bin) }
}

export function taskConfig(task = {}) {
  return {
    task: { default_execution_mode: "process", process_runner: "host", global_concurrency: 16, residency_max_children: 16, ...task },
    categories: { proc: { description: "Shard cost mock category.", model: "omo-mock/mock-1" } },
  }
}

export function newSandbox(config, name, { omoConfig = taskConfig(), script }) {
  return createScenarioSandbox({ runRoot: config.root, home: config.home, bin: config.bin }, name, { omoConfig, script })
}

/** A second project dir in the same sandbox (same agent dir, own cwd, own mock script and task store). */
export function addProject(sandbox, name, { omoConfig = taskConfig(), script }) {
  const cwd = join(sandbox.root, name)
  mkdirSync(join(cwd, ".omo"), { recursive: true })
  writeFileSync(join(cwd, ".omo", "omo.json"), `${JSON.stringify(omoConfig, null, 2)}\n`)
  writeFileSync(join(cwd, "mock-script.json"), `${JSON.stringify(script, null, 2)}\n`)
  const trustPath = join(sandbox.agentDir, "trust.json")
  const trust = JSON.parse(readFileSync(trustPath, "utf8"))
  writeFileSync(trustPath, `${JSON.stringify({ ...trust, [cwd]: true }, null, 2)}\n`)
  return { name, cwd, stateDir: join(cwd, ".omo", "senpi-task"), script }
}

export const mainProject = (sandbox, script) => ({ name: "proj", cwd: sandbox.cwd, stateDir: sandbox.stateDir, script })

/** A parent step that parks the parent turn until the driver writes `.omo/<file>`. */
export function holdStep(file, seconds) {
  return {
    type: "tool_call",
    name: "eval",
    arguments: {
      language: "js",
      summary: `park the QA parent until ${file}`,
      timeout: seconds,
      code: `var fs = await import("node:fs"); await new Promise((resolve, reject) => {
        var finish = () => { if (!fs.existsSync(".omo/${file}")) return; clearTimeout(timer); watcher.close(); resolve(); };
        var watcher = fs.watch(".omo", finish);
        var timer = setTimeout(() => { watcher.close(); reject(new Error("${file} missing")); }, ${seconds * 1000});
        finish();
      });`,
    },
  }
}

export const taskStep = (args) => ({ type: "tool_call", name: "task", arguments: args })
export const childTask = (prompt, extra = {}) => ({ category: "proc", prompt, ...extra })
export const release = (project, file) => writeFileSync(join(project.cwd, ".omo", file), "go\n")

/** A parent with a line-timed JSON event stream: `taskCallAt()` is when the driver saw the task call start. */
export function startParent(sandbox, project, prompt, env = {}) {
  const parent = spawnParent({ ...sandbox, cwd: project.cwd }, MOCK_ENTRY, prompt, { capture: true, env })
  parent.events = []
  let buffer = ""
  parent.child.stdout?.on("data", (chunk) => {
    buffer += chunk
    for (let index = buffer.indexOf("\n"); index >= 0; index = buffer.indexOf("\n")) {
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      try {
        parent.events.push({ at: Date.now(), event: JSON.parse(line) })
      } catch {
        // banner line
      }
    }
  })
  parent.taskCallAt = () => parent.events.find((entry) => entry.event.type === "tool_execution_start" && entry.event.toolName === "task")?.at
  parent.sessionId = () => parent.events.find((entry) => entry.event.type === "session")?.event.id
  return parent
}

/** Bounded wait for a parent to exit on its own; past the deadline its process group is killed. */
export async function awaitParent(parent, timeoutMs) {
  let timer
  const outcome = await Promise.race([parent.closed, new Promise((resolve) => { timer = setTimeout(() => resolve("timeout"), timeoutMs) })])
  clearTimeout(timer)
  if (outcome === "timeout") await stopParent(parent)
  return outcome === "timeout" ? { status: null, timedOut: true } : { ...outcome, timedOut: false }
}

export function stepsKey(steps) {
  return createHash("sha256").update(JSON.stringify(steps)).digest("hex").slice(0, 16)
}

export function mockEvents(project) {
  const path = join(project.cwd, ".omo", "task-host-mock-events.jsonl")
  if (!existsSync(path)) return []
  return readFileSync(path, "utf8").split("\n").filter(Boolean).flatMap((line) => {
    try {
      return [JSON.parse(line)]
    } catch {
      return []
    }
  })
}

/** Provider requests made by CHILD sessions (their call ids carry the child script's key), in order. */
export function childRequests(project) {
  const prefix = `omo-host-${stepsKey(project.script.childSteps)}-`
  return mockEvents(project)
    .filter((event) => event.type === "model_request" && event.callId?.startsWith(prefix))
    .map((event) => ({ ...event, atMs: Date.parse(event.at) }))
}

export function taskRecords(project) {
  const dir = join(project.stateDir, "tasks")
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter((file) => file.endsWith(".json")).flatMap((file) => {
    try {
      return [JSON.parse(readFileSync(join(dir, file), "utf8"))]
    } catch {
      return []
    }
  })
}

export function endpointSockets(sandbox) {
  const rpc = join(sandbox.agentDir, "rpc")
  const shards = join(rpc, "shards")
  return [
    ...(existsSync(join(rpc, "rpc.sock")) ? [join(rpc, "rpc.sock")] : []),
    ...(existsSync(shards) ? readdirSync(shards).filter((name) => name.endsWith(".sock")).sort().map((name) => join(shards, name)) : []),
  ]
}

export function shardOwners(sandbox) {
  const shards = join(sandbox.agentDir, "rpc", "shards")
  if (!existsSync(shards)) return {}
  return Object.fromEntries(readdirSync(shards).filter((name) => name.endsWith(".meta.json")).flatMap((name) => {
    try {
      const meta = JSON.parse(readFileSync(join(shards, name), "utf8"))
      return [[meta.socket, meta.owner_session_id]]
    } catch {
      return []
    }
  }))
}

export function hostStatus(sandbox, socket, { includeWorkers = true } = {}) {
  const result = runBin(sandbox, ["host", "status", "--socket", socket, ...(includeWorkers ? ["--include-workers"] : []), "--json"], { timeoutMs: 30_000 })
  return { exitCode: result.status, json: lastJsonLine(result.stdout) ?? null }
}

/**
 * `host status --all` is senpi #2245 (unreleased). The documented shape is ONE JSON line
 * `{ endpoints: HostStatusReport[] }` whose reports add `crashes`, `shard {kind,key}|null`,
 * `session_rows`, `claims_live`, `claims` and `memory_pressure`. A usage error from an engine that
 * predates it degrades to today's behaviour: enumerate the sandbox's own sockets and ask each.
 */
export const STATUS_ALL_FIELDS = ["crashes", "shard", "session_rows", "claims_live", "claims", "memory_pressure"]
export function statusAll(sandbox) {
  const result = runBin(sandbox, ["host", "status", "--all", "--include-workers", "--json"], { timeoutMs: 60_000 })
  const parsed = lastJsonLine(result.stdout)
  if (result.status === 0 && Array.isArray(parsed?.endpoints)) {
    return {
      mode: "all",
      fieldsPresent: STATUS_ALL_FIELDS.filter((field) => parsed.endpoints.every((report) => field in report)),
      endpoints: parsed.endpoints,
    }
  }
  return {
    mode: "degraded",
    reason: `${(result.stderr || result.stdout).trim().split("\n")[0] ?? ""} (exit ${result.status})`,
    endpoints: endpointSockets(sandbox).map((socket) => ({ ...(hostStatus(sandbox, socket).json ?? { socket, reachable: false }), socket })),
  }
}

/** The supervisor of the socket's CURRENT generation, read from the pointer chain - no socket probe. */
export function supervisorPid(sandbox, socket) {
  try {
    const dir = join(sandbox.agentDir, "rpc-host-daemon", createHash("sha256").update(socket).digest("hex").slice(0, 16))
    const pointer = JSON.parse(readFileSync(join(dir, "host.pid"), "utf8"))
    const generation = JSON.parse(readFileSync(join(dir, pointer.generation_dir, "host.pid"), "utf8"))
    return typeof generation.pid === "number" ? generation.pid : undefined
  } catch {
    return undefined
  }
}

export function processTable() {
  const rows = execFileSync("ps", ["-axo", "pid=,ppid=,rss=,args="], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
  return new Map(rows.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    return match === null ? [] : [[Number(match[1]), { pid: Number(match[1]), ppid: Number(match[2]), rssKb: Number(match[3]), args: match[4] }]]
  }))
}

export function treePids(root, table = processTable()) {
  if (!table.has(root)) return []
  const out = [root]
  for (let index = 0; index < out.length; index += 1) {
    for (const entry of table.values()) if (entry.ppid === out[index]) out.push(entry.pid)
  }
  return out
}

/** darwin: `vmmap --summary` "Physical footprint"; linux: `smaps_rollup` Pss. MB, or undefined when unreadable. */
export function footprintMb(pid) {
  try {
    if (process.platform === "darwin") {
      const text = execFileSync("vmmap", ["--summary", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 16 * 1024 * 1024 })
      const match = /Physical footprint:\s+([\d.]+)([KMG])/.exec(text)
      if (match === null) return undefined
      return Math.round(Number(match[1]) * { K: 1 / 1024, M: 1, G: 1024 }[match[2]] * 10) / 10
    }
    const match = /^Pss:\s+(\d+) kB/m.exec(readFileSync(`/proc/${pid}/smaps_rollup`, "utf8"))
    return match === null ? undefined : Math.round((Number(match[1]) / 1024) * 10) / 10
  } catch {
    return undefined
  }
}

function role(entry, rootPid) {
  if (entry.pid === rootPid) return "supervisor"
  if (entry.args.includes("--mode rpc")) return "host"
  if (entry.args.includes("ast-grep") || entry.args.includes("ast_grep")) return "ast_grep_mcp"
  return "other"
}

const round = (value) => Math.round(value * 10) / 10

/** RSS + footprint of one endpoint: its supervisor and every descendant (host, MCP stdio children, kernels). */
export function sampleEndpoint(socket, supervisor, table = processTable()) {
  const pids = supervisor === undefined ? [] : treePids(supervisor, table)
  const processes = pids.map((pid) => {
    const entry = table.get(pid)
    return { pid, role: role(entry, supervisor), rss_mb: round(entry.rssKb / 1024), footprint_mb: footprintMb(pid) ?? null }
  })
  const sum = (field, filter = () => true) => round(processes.filter(filter).reduce((total, entry) => total + (entry[field] ?? Number.NaN), 0))
  return {
    socket: socket.split("/").slice(-1)[0],
    supervisor_pid: supervisor ?? null,
    alive: processes.length > 0,
    processes,
    supervisor_rss_mb: sum("rss_mb", (entry) => entry.role === "supervisor"),
    host_rss_mb: sum("rss_mb", (entry) => entry.role === "host"),
    endpoint_rss_mb: sum("rss_mb"),
    supervisor_footprint_mb: sum("footprint_mb", (entry) => entry.role === "supervisor"),
    host_footprint_mb: sum("footprint_mb", (entry) => entry.role === "host"),
    endpoint_footprint_mb: sum("footprint_mb"),
  }
}

/** Sum of every sampled endpoint that is still alive (a gone one contributes nothing). */
export function totalOf(samples) {
  const alive = samples.filter((sample) => sample.alive)
  return {
    endpoints_alive: alive.length,
    rss_mb: round(alive.reduce((total, sample) => total + sample.endpoint_rss_mb, 0)),
    footprint_mb: round(alive.reduce((total, sample) => total + sample.endpoint_footprint_mb, 0)),
  }
}

/**
 * Stop ONE endpoint this run started: `host stop --force`, then a bounded wait until every pid of its
 * tree fails `kill -0` (the stop answers before the process exits). `host gc` is attempted as the
 * plan asks; an engine without it (senpi #2245 unreleased) answers a usage error, recorded as such.
 */
export async function stopEndpoint(sandbox, socket) {
  const supervisor = supervisorPid(sandbox, socket)
  const pids = supervisor === undefined ? [] : treePids(supervisor)
  const stop = runBin(sandbox, ["host", "stop", "--socket", socket, "--force", "--json"], { timeoutMs: 60_000 })
  await waitFor(() => pids.every((pid) => !pidAlive(pid)), { timeoutMs: 30_000, intervalMs: 200 })
  for (const pid of pids.filter(pidAlive)) {
    try {
      process.kill(pid, "SIGKILL")
    } catch {
      // gone between the check and the signal
    }
  }
  const gc = runBin(sandbox, ["host", "gc", "--socket", socket, "--json"], { timeoutMs: 30_000 })
  return {
    socket: socket.split("/").slice(-1)[0],
    pids,
    stopExit: stop.status,
    stillAlive: pids.filter(pidAlive),
    gc: gc.status === 0 ? "removed" : `unsupported (exit ${gc.status}: ${(gc.stderr || gc.stdout).trim().split("\n")[0] ?? ""})`,
  }
}

/** Tear a sandbox down: parents killed, every endpoint stopped, survivors naming it killed, dir removed. */
export async function teardownSandbox(sandbox, parents = []) {
  for (const parent of parents) await stopParent(parent).catch(() => undefined)
  const endpoints = []
  for (const socket of endpointSockets(sandbox)) endpoints.push(await stopEndpoint(sandbox, socket))
  const survivors = sandboxProcesses(sandbox).map((entry) => entry.pid)
  for (const pid of survivors) {
    try {
      process.kill(pid, "SIGKILL")
    } catch {
      // gone
    }
  }
  rmSync(sandbox.root, { recursive: true, force: true })
  return {
    sandbox: sandbox.name,
    parentPids: parents.map((parent) => parent.child.pid),
    parentsAlive: parents.map((parent) => parent.child.pid).filter(pidAlive),
    endpoints,
    killedSurvivors: survivors,
    removed: !existsSync(sandbox.root),
  }
}

/** A documented settle window - the ONLY kind of fixed wait this driver uses, and never an assertion. */
export function settle(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
