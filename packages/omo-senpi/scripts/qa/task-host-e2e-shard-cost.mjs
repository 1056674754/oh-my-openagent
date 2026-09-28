#!/usr/bin/env node
// rpc-host-sharding todo 15: what per-parent shards cost in memory and latency, against the one
// shared host of the pre-change build, on the real compiled binaries and a keyless mock provider.
//
//   node packages/omo-senpi/scripts/qa/task-host-e2e-shard-cost.mjs \
//     --bin <compiled omo built from this branch> --before-bin <compiled R0 omo> --out <dir>
//   ... [--samples 20] [--target idle_rss_mb=1]... [--skip <section>]... [--control] [--keep-sandbox]
//   ... --reevaluate <shard-cost.json> [--target k=v]... [--skip <section>]...   (no processes)
//
// `SENPI_BIN` is accepted in place of `--bin` (a compiled omo binary: the branch's plugin and engine
// in one executable, the same shape as the R0 control, so both sides pay the same engine costs).
//
// Sections -> shard-cost.json:
//   idle      (a) one shard with 0 sessions, 30 s after ensure (session-start pre-warm); control: `omo daemon run`
//   marginal  (b) the same shard after 1, 2, 4 children each completed one turn, >= 15 s after settle
//   totals    (c) N = 1, 2, 4 parents x 4 children, sharded vs the control's one shared host
//   idle_exit (d1) all parents quit -> +16 min both idled out; (d2) A, B quit, C attached mid-turn ->
//             +16 min, under defaults and under a NON-DEFAULT 1 h session eviction window
//   latency   (e) N samples each (nearest-rank p50/p95): cold first child, pre-warm first-turn,
//             pre-warm session-start, reattach after a host SIGSEGV, `host ensure` at 1 and 4 live hosts
// Exit: 0 all sections measured and every target PASS; 2 measured but >= 1 target FAIL; 1 incomplete
// (missing section, null cell, fewer than 20 samples) or a harness failure (leftover process).
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { cpus, homedir, loadavg, totalmem } from "node:os"
import { join, resolve } from "node:path"

import { observeState, stopParent } from "./task-host-e2e-events.mjs"
import { pidAlive, runBin, sandboxProcesses, waitFor } from "./task-host-e2e-process.mjs"
import { createRunRoot } from "./task-host-e2e-sandbox.mjs"
import {
  addProject,
  awaitParent,
  CHILD_TEXT,
  childRequests,
  childTask,
  endpointSockets,
  heldChild,
  holdStep,
  hostStatus,
  mainProject,
  newSandbox,
  processTable,
  provisionConfig,
  release,
  sampleEndpoint,
  settle,
  shardOwners,
  startParent,
  statusAll,
  stopEndpoint,
  supervisorPid,
  taskConfig,
  taskRecords,
  taskStep,
  teardownSandbox,
  totalOf,
  treePids,
} from "./task-host-e2e-shard-cost-support.mjs"
import { applyTargetOverrides, DEFAULT_TARGETS, evaluate, REQUIRED_SAMPLES, SECTIONS, summarizeSamples } from "./task-host-e2e-shard-cost-eval.mjs"

const IDLE_SETTLE_MS = 30_000 // (a) "30 s after ensure"
const TURN_SETTLE_MS = 15_000 // RSS needs >= 15 s after a turn settles (compiled engine drops ~1.7x)
const PLUS_ONE_MS = 60_000
const PLUS_SIXTEEN_MS = 16 * 60_000
const LONG_EVICTION = "3600000"
const DONE = new Set(["completed", "error", "lost", "cancelled"])
const MAX_EXTRA_ATTEMPTS = 5
/** Routes a child to <cwd>'s mock script on a shared host (see task-host-e2e-shard-cost-mock-provider.mjs). */
const mockCwdMarker = (cwd) => `[[mock-cwd:${cwd}]]`

function parseArgs(argv) {
  const options = { targets: [], skip: [], control: false, keepSandbox: false }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag === "--control") options.control = true
    else if (flag === "--keep-sandbox") options.keepSandbox = true
    else if (flag === "--target") options.targets.push(argv[++index])
    else if (flag === "--skip") options.skip.push(argv[++index])
    else if (flag.startsWith("--")) options[flag.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = argv[++index]
  }
  return options
}

const log = (line) => console.error(`[shard-cost ${new Date().toISOString().slice(11, 19)}] ${line}`)

function hardware() {
  const gb = Math.round(totalmem() / 1024 ** 3)
  const family = process.platform === "darwin" && process.arch === "arm64" ? "Apple M-series" : `${process.platform}/${process.arch}`
  return `${family} ${cpus().length}-core, ${gb} GB`
}

/** Wait (event-driven over the sandbox tree, bounded) until `probe` answers. */
async function until(sandbox, probe, timeoutMs = 600_000) {
  return observeState(sandbox.root, probe, { timeoutMs })
}

const settled = (project, count) => {
  const records = taskRecords(project)
  return records.length >= count && records.every((record) => DONE.has(record.status)) ? records : undefined
}

async function reachable(sandbox, socket, timeoutMs = 60_000) {
  return waitFor(() => (hostStatus(sandbox, socket, { includeWorkers: false }).json?.reachable === true ? true : undefined), { timeoutMs, intervalMs: 250 })
}

async function newSocket(sandbox, known, timeoutMs = 60_000) {
  return until(sandbox, () => endpointSockets(sandbox).find((socket) => !known.has(socket)), timeoutMs)
}

function sampleAll(sandbox) {
  const table = processTable()
  return endpointSockets(sandbox).map((socket) => sampleEndpoint(socket, supervisorPid(sandbox, socket), table))
}

// ---------------------------------------------------------------- (a) idle + (b) marginal
async function idleAndMarginal(run, cleanup) {
  const script = {
    parentSteps: [
      holdStep("m1", 900), taskStep(childTask("marginal child 1")),
      holdStep("m2", 900), taskStep(childTask("marginal child 2")),
      holdStep("m3", 900), taskStep({ tasks: [childTask("marginal child 3"), childTask("marginal child 4")] }),
      holdStep("parent-release", 900), { type: "text", text: "marginal parent done" },
    ],
    childSteps: CHILD_TEXT,
  }
  const sandbox = newSandbox(run.sharded, "im", { omoConfig: taskConfig({ host_shard_prewarm: "session-start" }), script })
  const project = mainProject(sandbox, script)
  const parent = startParent(sandbox, project, "idle then marginal children")
  try {
    const socket = await newSocket(sandbox, new Set())
    if (socket === undefined || !(await reachable(sandbox, socket))) throw new Error("session-start pre-warm never produced a reachable shard")
    const ensuredAt = Date.now()
    log(`(a) shard ${socket.split("/").pop()} reachable; settling ${IDLE_SETTLE_MS} ms`)
    await settle(IDLE_SETTLE_MS)
    const status0 = hostStatus(sandbox, socket).json
    const idle = sampleEndpoint(socket, supervisorPid(sandbox, socket))
    const steps = []
    for (const [file, count] of [["m1", 1], ["m2", 2], ["m3", 4]]) {
      release(project, file)
      const records = await until(sandbox, () => settled(project, count))
      if (records === undefined) throw new Error(`(b) ${count} children never settled`)
      await settle(TURN_SETTLE_MS)
      const sample = sampleEndpoint(socket, supervisorPid(sandbox, socket))
      steps.push({
        children: count,
        completed: records.filter((record) => record.status === "completed").length,
        same_supervisor: sample.supervisor_pid === idle.supervisor_pid,
        endpoints: endpointSockets(sandbox).length,
        host_rss_mb: sample.host_rss_mb,
        host_footprint_mb: sample.host_footprint_mb,
        endpoint_rss_mb: sample.endpoint_rss_mb,
        endpoint_footprint_mb: sample.endpoint_footprint_mb,
        marginal_rss_mb_per_child: Math.round(((sample.host_rss_mb - idle.host_rss_mb) / count) * 10) / 10,
        marginal_footprint_mb_per_child: Math.round(((sample.host_footprint_mb - idle.host_footprint_mb) / count) * 10) / 10,
        processes: sample.processes,
      })
      log(`(b) ${count} children: host ${sample.host_rss_mb} MB RSS / ${sample.host_footprint_mb} MB footprint`)
    }
    return {
      idle: { ...idle, sessions_total: status0?.sessions?.total ?? null, ms_after_ensure: IDLE_SETTLE_MS, ensured_via: "task.host_shard_prewarm=session-start", ensured_at: new Date(ensuredAt).toISOString() },
      marginal: { settle_ms: TURN_SETTLE_MS, baseline_host_rss_mb: idle.host_rss_mb, baseline_host_footprint_mb: idle.host_footprint_mb, per_child: steps },
    }
  } finally {
    release(project, "parent-release")
    cleanup.push(await teardownSandbox(sandbox, [parent]))
  }
}

async function controlIdle(run, cleanup) {
  const sandbox = newSandbox(run.control, "ci", { script: { parentSteps: [], childSteps: [] } })
  try {
    const ran = runBin(sandbox, ["daemon", "run", "--json"], { timeoutMs: 120_000 })
    const socket = join(sandbox.agentDir, "rpc", "rpc.sock")
    if (!(await reachable(sandbox, socket))) throw new Error(`control daemon run did not serve rpc.sock (exit ${ran.status})`)
    await settle(IDLE_SETTLE_MS)
    return { ...sampleEndpoint(socket, supervisorPid(sandbox, socket)), sessions_total: hostStatus(sandbox, socket).json?.sessions?.total ?? null, ensured_via: "omo daemon run (R0)" }
  } finally {
    cleanup.push(await teardownSandbox(sandbox))
  }
}

// ---------------------------------------------------------------- (c) totals
async function totalsFor(config, parents, cleanup) {
  const script = {
    parentSteps: [
      taskStep({ tasks: [1, 2, 3, 4].map((n) => childTask(`total child ${n}`)) }),
      holdStep("parent-release", 900),
      { type: "text", text: "totals parent done" },
    ],
    childSteps: CHILD_TEXT,
  }
  const sandbox = newSandbox(config, `t${parents}${config.kind[0]}`, { script })
  const project = mainProject(sandbox, script)
  const started = Array.from({ length: parents }, (_, index) => startParent(sandbox, project, `totals parent ${index}`))
  try {
    const records = await until(sandbox, () => settled(project, 4 * parents))
    if (records === undefined) throw new Error(`${config.kind} N=${parents}: ${4 * parents} children never settled`)
    await settle(TURN_SETTLE_MS)
    const status = statusAll(sandbox)
    const sockets = endpointSockets(sandbox)
    const shards = sockets.filter((socket) => /\/p-[0-9a-f]{16}\.sock$/.test(socket))
    const workers = status.endpoints.map((report) => report.sessions?.worker ?? null)
    // The control must PROVE it measured one shared host before its numbers mean anything.
    const topology = config.kind === "control"
      ? { expected: "one reachable rpc.sock holding every child, no p-* shard", ok: sockets.length === 1 && sockets[0].endsWith("/rpc/rpc.sock") && shards.length === 0 && workers[0] === 4 * parents }
      : { expected: `${parents} p-* shards x 4 workers, no rpc.sock`, ok: shards.length === parents && sockets.length === parents && workers.every((count) => count === 4) }
    if (!topology.ok) throw new Error(`${config.kind} N=${parents} topology: ${JSON.stringify({ sockets, workers })}`)
    const samples = sampleAll(sandbox)
    return {
      children: 4 * parents,
      completed: records.filter((record) => record.status === "completed").length,
      status_all: status.mode,
      status_all_note: status.mode === "all" ? status.fieldsPresent.join(",") : status.reason,
      topology,
      workers_per_endpoint: workers,
      ...totalOf(samples),
      endpoints: samples,
    }
  } finally {
    release(project, "parent-release")
    cleanup.push(await teardownSandbox(sandbox, started))
  }
}

async function totals(run, cleanup) {
  const rows = []
  for (const parents of [1, 2, 4]) {
    const sharded = await totalsFor(run.sharded, parents, cleanup)
    const control = await totalsFor(run.control, parents, cleanup)
    rows.push({ parents, children: 4 * parents, sharded, control, delta_rss_mb: Math.round((sharded.rss_mb - control.rss_mb) * 10) / 10, delta_footprint_mb: Math.round((sharded.footprint_mb - control.footprint_mb) * 10) / 10 })
    log(`(c) N=${parents}: sharded ${sharded.rss_mb} MB RSS (${sharded.endpoints_alive} hosts) vs control ${control.rss_mb} MB (1 host)`)
  }
  return { settle_ms: TURN_SETTLE_MS, rows }
}

// ---------------------------------------------------------------- (e) latency
async function firstChildScenario(run, name, prewarm, samples, cleanup) {
  const gated = prewarm !== "off"
  const script = {
    parentSteps: [...(gated ? [holdStep("warm-go", 300)] : []), taskStep(childTask("first child")), { type: "text", text: "latency parent done" }],
    childSteps: CHILD_TEXT,
  }
  const sandbox = newSandbox(run.sharded, name, { omoConfig: taskConfig({ host_shard_prewarm: prewarm }), script })
  const project = mainProject(sandbox, script)
  const values = []
  const detail = []
  try {
    // An invalid observation (no task call seen, no child request) is kept in `detail` and replaced,
    // up to a bounded number of extra attempts; the cell still fails completeness if it stays short.
    for (let index = 0; values.length < samples && index < samples + MAX_EXTRA_ATTEMPTS; index += 1) {
      const known = new Set(endpointSockets(sandbox))
      const seen = childRequests(project).length
      const parent = startParent(sandbox, project, `${name} sample ${index}`)
      let readyAt
      if (gated) {
        const socket = await newSocket(sandbox, known)
        if (socket !== undefined && (await reachable(sandbox, socket))) readyAt = Date.now()
        release(project, "warm-go")
      }
      const exit = await awaitParent(parent, 180_000)
      const taskAt = parent.taskCallAt()
      const first = childRequests(project).slice(seen)[0]
      const sockets = endpointSockets(sandbox).filter((socket) => !known.has(socket))
      const valid = taskAt !== undefined && first !== undefined && (!gated || (readyAt !== undefined && readyAt <= taskAt))
      if (valid) values.push(first.atMs - taskAt)
      detail.push({ ms: valid ? first.atMs - taskAt : "invalid", valid, prewarmed_before_task_call: gated ? readyAt !== undefined && readyAt <= taskAt : false, parent_exit: exit.status, new_endpoints: sockets.length })
      if (gated) rmSync(join(project.cwd, ".omo", "warm-go"), { force: true })
      for (const socket of sockets) cleanup.push(await stopEndpoint(sandbox, socket))
    }
  } finally {
    cleanup.push(await teardownSandbox(sandbox))
  }
  log(`(e) ${name}: ${values.length}/${samples} valid samples`)
  return summarizeSamples(values, { definition: "parent task tool_execution_start (driver clock) -> first child provider request (mock clock)", prewarm, invalid_samples: detail.filter((entry) => !entry.valid).length, detail })
}

async function reattachScenario(run, samples, cleanup) {
  const script = {
    parentSteps: [taskStep(childTask("held child", { run_in_background: true })), holdStep("parent-release", 900), { type: "text", text: "reattach parent done" }],
    childSteps: heldChild(600_000),
  }
  const sandbox = newSandbox(run.sharded, "lr", { script })
  const project = mainProject(sandbox, script)
  const values = []
  const detail = []
  try {
    for (let index = 0; values.length < samples && index < samples + MAX_EXTRA_ATTEMPTS; index += 1) {
      const known = new Set(endpointSockets(sandbox))
      const seen = childRequests(project).length
      const parent = startParent(sandbox, project, `reattach sample ${index}`)
      const midTurn = await until(sandbox, () => childRequests(project).slice(seen)[0], 180_000)
      const socket = endpointSockets(sandbox).find((candidate) => !known.has(candidate))
      const supervisor = socket === undefined ? undefined : supervisorPid(sandbox, socket)
      const table = processTable()
      const host = supervisor === undefined ? undefined : treePids(supervisor, table).find((pid) => table.get(pid)?.args.includes("--mode rpc"))
      let ms = null
      let replacement
      if (midTurn !== undefined && host !== undefined) {
        const killedAt = Date.now()
        process.kill(host, "SIGSEGV")
        const continuation = await until(sandbox, () => childRequests(project).slice(seen).find((request) => request.atMs > killedAt), 120_000)
        replacement = supervisorPid(sandbox, socket)
        if (continuation !== undefined) ms = continuation.atMs - killedAt
      }
      if (ms !== null) values.push(ms)
      detail.push({ ms: ms ?? "invalid", valid: ms !== null, killed_host_pid: host ?? "none", old_supervisor: supervisor ?? "none", new_supervisor: replacement ?? "none", new_generation: replacement !== undefined && replacement !== supervisor })
      await stopParent(parent)
      for (const pid of [supervisor, host].filter((pid) => pid !== undefined && pidAlive(pid))) {
        try {
          process.kill(pid, "SIGKILL")
        } catch {
          // gone
        }
      }
      if (socket !== undefined) cleanup.push(await stopEndpoint(sandbox, socket))
    }
  } finally {
    cleanup.push(await teardownSandbox(sandbox))
  }
  log(`(e) reattach_after_crash: ${values.length}/${samples} valid samples`)
  return summarizeSamples(values, { definition: "SIGSEGV to the shard's host process (driver clock) -> the child's first provider request after it (mock clock); includes the fresh-generation ensure and reopen", invalid_samples: detail.filter((entry) => !entry.valid).length, detail })
}

async function ensureScenario(run, liveHosts, samples, cleanup) {
  const sandbox = newSandbox(run.sharded, `le${liveHosts}`, { script: { parentSteps: [], childSteps: [] } })
  const dir = join(sandbox.agentDir, "rpc", "e")
  mkdirSync(dir, { recursive: true })
  const ensure = (socket) => {
    const started = performance.now()
    const result = runBin(sandbox, ["host", "ensure", "--socket", socket, "--launch-spec", run.sharded.specPath, "--policy", "never", "--json"], { timeoutMs: 120_000 })
    return { ms: performance.now() - started, exit: result.status }
  }
  const values = []
  const overhead = []
  try {
    for (let index = 0; index < liveHosts - 1; index += 1) {
      const bystander = ensure(join(dir, `b${index}.sock`))
      if (bystander.exit !== 0) throw new Error(`bystander host ${index} did not start`)
    }
    for (let index = 0; index < samples; index += 1) {
      const socket = join(dir, `s${index}.sock`)
      const started = performance.now()
      runBin(sandbox, ["host", "status", "--socket", join(dir, "absent.sock"), "--json"], { timeoutMs: 30_000 })
      overhead.push(performance.now() - started)
      const sample = ensure(socket)
      if (sample.exit === 0) values.push(sample.ms)
      cleanup.push(await stopEndpoint(sandbox, socket))
    }
  } finally {
    for (let index = 0; index < liveHosts - 1; index += 1) cleanup.push(await stopEndpoint(sandbox, join(dir, `b${index}.sock`)))
    cleanup.push(await teardownSandbox(sandbox))
  }
  return summarizeSamples(values, {
    definition: `wall time of \`omo host ensure --socket <fresh> --policy never\` with ${liveHosts - 1} other live host(s) in the agent dir (CLI process start included)`,
    live_hosts: liveHosts,
    cli_overhead_p50_ms: summarizeSamples(overhead).p50_ms,
  })
}

async function latency(run, samples, cleanup) {
  const scenarios = {}
  scenarios.cold_first_child = await firstChildScenario(run, "lc", "off", samples, cleanup)
  scenarios.warm_first_turn = await firstChildScenario(run, "lw", "first-turn", samples, cleanup)
  scenarios.warm_session_start = await firstChildScenario(run, "ls", "session-start", samples, cleanup)
  scenarios.reattach_after_crash = await reattachScenario(run, samples, cleanup)
  scenarios.ensure_n1 = await ensureScenario(run, 1, samples, cleanup)
  scenarios.ensure_n4 = await ensureScenario(run, 4, samples, cleanup)
  return { percentile: "nearest-rank", required_samples: REQUIRED_SAMPLES, scenarios }
}

// ---------------------------------------------------------------- (d) idle exit
async function idleExitVariant(config, variant, cleanup) {
  const env = variant === "d2_long" ? { SENPI_RPC_SESSION_IDLE_EVICTION_MS: LONG_EVICTION } : {}
  // Every child names its own project: on the control's ONE host, whichever parent ensured it first
  // fixes the host's cwd, and an unmarked child would read that project's script.
  const name = `${variant.replace("_default", "").replace("_long", "l")}${config.kind[0]}`
  const abCwd = join(config.root, name, "proj")
  const abScript = {
    parentSteps: [taskStep({ tasks: [childTask(`departed child 1 ${mockCwdMarker(abCwd)}`), childTask(`departed child 2 ${mockCwdMarker(abCwd)}`)] }), holdStep("parent-release", 1_500), { type: "text", text: "departed parent done" }],
    childSteps: CHILD_TEXT,
  }
  const sandbox = newSandbox(config, name, { script: abScript })
  if (sandbox.cwd !== abCwd) throw new Error(`sandbox cwd ${sandbox.cwd} is not the routed ${abCwd}`)
  const ab = mainProject(sandbox, abScript)
  const survivorScript = (cwd) => ({
    parentSteps: [taskStep(childTask(`survivor child ${mockCwdMarker(cwd)}`, { run_in_background: true })), holdStep("parent-release", 1_500), { type: "text", text: "survivor parent done" }],
    childSteps: heldChild(3_600_000),
  })
  const survivor = variant === "d1" ? undefined : addProject(sandbox, "c", { script: survivorScript(join(sandbox.root, "c")) })
  const parents = [startParent(sandbox, ab, "departed parent A", env), startParent(sandbox, ab, "departed parent B", env)]
  const survivorParent = survivor === undefined ? undefined : startParent(sandbox, survivor, "surviving parent C", env)
  if (survivorParent !== undefined) parents.push(survivorParent)
  try {
    const ready = await until(sandbox, () =>
      settled(ab, 4) !== undefined && (survivor === undefined || childRequests(survivor).length > 0) ? true : undefined)
    if (ready === undefined) throw new Error(`${config.kind} ${variant}: workload never reached its quit point`)
    const sockets = endpointSockets(sandbox)
    const owners = shardOwners(sandbox)
    const survivorSocket = config.kind === "sharded" && survivorParent !== undefined
      ? sockets.find((socket) => owners[socket] === survivorParent.sessionId())
      : undefined
    const before = Object.fromEntries(sockets.map((socket) => [socket, hostStatus(sandbox, socket).json?.sessions ?? null]))
    const table = processTable()
    const tracked = sockets.map((socket) => {
      const pids = treePids(supervisorPid(sandbox, socket) ?? -1, table)
      return { socket, supervisor: supervisorPid(sandbox, socket), host: pids.find((pid) => table.get(pid)?.args.includes("--mode rpc")), pids }
    })
    // The quit: A and B finish their turns and exit, closing their connections. No socket is probed
    // again until +16 min - a status probe is a connection and would restart the idle window.
    release(ab, "parent-release")
    await Promise.all(parents.slice(0, 2).map((parent) => awaitParent(parent, 120_000)))
    const quitAt = Date.now()
    await settle(PLUS_ONE_MS)
    const plusOne = tracked.map(({ socket, supervisor }) => sampleEndpoint(socket, supervisor))
    await settle(Math.max(0, quitAt + PLUS_SIXTEEN_MS - Date.now()))
    const aliveNow = tracked.map((entry) => ({ ...entry, alive: entry.pids.filter(pidAlive) }))
    const plusSixteen = tracked.map(({ socket, supervisor }) => sampleEndpoint(socket, supervisor))
    const result = {
      endpoints: tracked.map(({ socket, supervisor, host, pids }) => ({ socket: socket.split("/").pop(), supervisor_pid: supervisor ?? null, host_pid: host ?? null, pids, alive_at_16min: aliveNow.find((entry) => entry.socket === socket).alive })),
      sessions_before_quit: Object.fromEntries(Object.entries(before).map(([socket, sessions]) => [socket.split("/").pop(), sessions])),
      eviction_ms: variant === "d2_long" ? Number(LONG_EVICTION) : "default (idleExitMs 900000 copied by daemonLaunchOptions)",
      rss_mb_at_1min: totalOf(plusOne).rss_mb,
      rss_mb_at_16min: totalOf(plusSixteen).rss_mb,
      alive_rss_mb_at_16min: totalOf(plusSixteen).rss_mb,
      alive_endpoints_at_16min: aliveNow.filter((entry) => entry.alive.length > 0).map((entry) => entry.socket.split("/").pop()),
      samples_at_1min: plusOne,
      samples_at_16min: plusSixteen,
    }
    if (variant === "d1") {
      result.all_gone = aliveNow.every((entry) => entry.pids.length > 0 && entry.alive.length === 0)
    } else if (config.kind === "sharded") {
      const departed = aliveNow.filter((entry) => entry.socket !== survivorSocket)
      result.survivor_socket = survivorSocket?.split("/").pop() ?? null
      result.departed_gone = survivorSocket !== undefined && departed.length === 2 && departed.every((entry) => entry.pids.length > 0 && entry.alive.length === 0)
      // C's endpoint lives when its supervisor and its host process do; a short-lived descendant
      // (an MCP stdio child, a kernel) coming and going is not the endpoint's lifetime.
      result.survivor_alive = tracked.some((entry) => entry.socket === survivorSocket && entry.host !== undefined && pidAlive(entry.supervisor) && pidAlive(entry.host))
    } else {
      const socket = tracked[0]?.socket
      const status = socket === undefined ? undefined : hostStatus(sandbox, socket).json
      result.host_alive = aliveNow.length === 1 && aliveNow[0].alive.length > 0 && status?.reachable === true
      result.retained = status?.sessions?.retained ?? null
      result.sessions_at_16min = status?.sessions ?? null
    }
    log(`(d) ${config.kind} ${variant}: alive at +16 min = ${result.alive_endpoints_at_16min.length} endpoint(s), ${result.alive_rss_mb_at_16min} MB RSS`)
    return result
  } finally {
    if (survivor !== undefined) release(survivor, "parent-release")
    cleanup.push(await teardownSandbox(sandbox, parents))
  }
}

async function idleExit(run, configs, cleanup) {
  const variants = ["d1", "d2_default", "d2_long"]
  const jobs = variants.flatMap((variant) => configs.map((config) => ({ variant, config })))
  const results = await Promise.all(jobs.map(async ({ variant, config }) => {
    try {
      return { variant, kind: config.kind, value: await idleExitVariant(config, variant, cleanup) }
    } catch (error) {
      return { variant, kind: config.kind, error: String(error?.stack ?? error) }
    }
  }))
  const failed = results.filter((entry) => entry.error !== undefined)
  if (failed.length > 0) throw new Error(`idle-exit variants failed: ${JSON.stringify(failed.map(({ variant, kind, error }) => ({ variant, kind, error: error.slice(0, 400) })))}`)
  const section = {}
  for (const { variant, kind, value } of results) section[variant] = { ...section[variant], [kind]: value }
  section.d2_long.label = "NON-DEFAULT: SENPI_RPC_SESSION_IDLE_EVICTION_MS=3600000 in both configurations"
  return section
}

// ---------------------------------------------------------------- main
function realAgentFingerprint() {
  const dir = join(homedir(), ".omo", "agent")
  const digest = (name) => (existsSync(join(dir, name)) ? createHash("sha256").update(readFileSync(join(dir, name))).digest("hex").slice(0, 16) : "absent")
  const socket = join(dir, "rpc", "rpc.sock")
  const stat = existsSync(socket) ? statSync(socket) : undefined
  return { auth: digest("auth.json"), models: digest("models.json"), rpc_sock: stat === undefined ? "absent" : `${stat.ino}:${stat.mtimeMs}` }
}

function sweep(runRoot) {
  const before = sandboxProcesses({ root: runRoot })
  for (const entry of before) {
    try {
      process.kill(entry.pid, "SIGKILL")
    } catch {
      // gone
    }
  }
  return { before: before.map((entry) => entry.pid), after: sandboxProcesses({ root: runRoot }).map((entry) => entry.pid) }
}

function table(report, verdict) {
  const lines = [`# shard cost (${report.hardware})`, "", `sharded: ${report.binaries.sharded?.version ?? "n/a"}`, `control: ${report.binaries.control?.version ?? "n/a"}`, "", "| target | measured | acceptance | verdict |", "|---|---|---|---|"]
  for (const row of verdict.rows) lines.push(`| ${row.id} | ${row.measured} | ${row.target} | ${row.verdict} |`)
  const latency = report.sections.latency?.scenarios ?? {}
  lines.push("", "| latency scenario | n | p50 ms | p95 ms | min ms |", "|---|---|---|---|---|")
  for (const [name, cell] of Object.entries(latency)) lines.push(`| ${name} | ${cell.n} | ${cell.p50_ms} | ${cell.p95_ms} | ${cell.min_ms} |`)
  for (const row of report.sections.totals?.rows ?? []) lines.push(`\nN=${row.parents} x 4: sharded ${row.sharded.rss_mb} MB RSS / ${row.sharded.footprint_mb} MB footprint over ${row.sharded.endpoints_alive} hosts; control ${row.control.rss_mb} / ${row.control.footprint_mb} MB on 1 host`)
  return `${lines.join("\n")}\n`
}

function finish(out, report, options) {
  const targets = applyTargetOverrides(DEFAULT_TARGETS, options.targets)
  for (const name of options.skip) delete report.sections[name]
  const verdict = evaluate(report, { targets, requiredSamples: REQUIRED_SAMPLES })
  const leaked = report.cleanup_ok === false
  const exitCode = leaked ? 1 : verdict.exitCode
  const final = { ...report, verdict: { ...verdict, exitCode, harness_leak: leaked } }
  mkdirSync(out, { recursive: true })
  writeFileSync(join(out, "shard-cost.json"), `${JSON.stringify(final, null, 2)}\n`)
  writeFileSync(join(out, "shard-cost.md"), table(report, verdict))
  console.log(JSON.stringify({ exitCode, verdict: verdict.verdict, completeness: verdict.completeness, rows: verdict.rows.map(({ id, measured, target, verdict: v }) => ({ id, measured, target, verdict: v })), out }))
  return exitCode
}

async function main(options) {
  const out = resolve(options.out ?? join(process.cwd(), "shard-cost-out"))
  if (options.reevaluate !== undefined) {
    const recorded = JSON.parse(readFileSync(resolve(options.reevaluate), "utf8"))
    return finish(out, { ...recorded, reevaluated_from: resolve(options.reevaluate) }, options)
  }
  if (process.platform === "win32") {
    console.log(JSON.stringify({ result: "SKIP", reason: "per-parent shards are POSIX-only; win32 children use the child-process runner" }))
    return 0
  }
  const bin = options.bin ?? process.env.SENPI_BIN
  const samples = Number(options.samples ?? REQUIRED_SAMPLES)
  if (bin === undefined && !options.control) throw new Error("--bin <compiled omo from this branch> (or SENPI_BIN) is required")
  if (options.beforeBin === undefined && (options.control || !["idle", "totals", "idle_exit"].every((name) => options.skip.includes(name)))) {
    throw new Error("--before-bin <compiled R0 omo> is required for the control halves")
  }
  const realBefore = realAgentFingerprint()
  const runRoot = createRunRoot()
  const cleanup = []
  const report = { plan_todo: 15, mode: options.control ? "control" : "full", started: new Date().toISOString(), hardware: hardware(), samples, run_root: runRoot, binaries: {}, load_average: {}, sections: {}, errors: {}, cleanup }
  try {
    const sharded = options.control ? undefined : provisionConfig("sharded", resolve(bin), runRoot)
    const control = options.beforeBin === undefined ? undefined : provisionConfig("control", resolve(options.beforeBin), runRoot)
    const run = { sharded, control }
    report.binaries = Object.fromEntries(Object.entries(run).filter(([, value]) => value !== undefined).map(([kind, value]) => [kind, { path: value.bin, version: value.version, sha256: value.digest }]))
    const wanted = (name) => !options.skip.includes(name)
    const measure = async (name, fn) => {
      if (!wanted(name)) return
      log(`section ${name}`)
      report.load_average[name] = loadavg().map((value) => Math.round(value * 10) / 10)
      try {
        report.sections[name] = await fn()
      } catch (error) {
        report.errors[name] = String(error?.stack ?? error)
        log(`section ${name} FAILED: ${report.errors[name].split("\n")[0]}`)
      }
    }
    if (options.control) {
      await measure("idle_exit", () => idleExit(run, [control], cleanup))
    } else {
      let marginal
      await measure("idle", async () => {
        const measured = await idleAndMarginal(run, cleanup)
        marginal = measured.marginal
        return { sharded: measured.idle, control: await controlIdle(run, cleanup) }
      })
      if (wanted("marginal") && marginal !== undefined) report.sections.marginal = marginal
      else if (wanted("marginal") && !wanted("idle")) await measure("marginal", async () => (await idleAndMarginal(run, cleanup)).marginal)
      await measure("totals", () => totals(run, cleanup))
      await measure("latency", () => latency(run, samples, cleanup))
      await measure("idle_exit", () => idleExit(run, [sharded, control], cleanup))
    }
  } finally {
    const swept = sweep(runRoot)
    if (!options.keepSandbox) rmSync(runRoot, { recursive: true, force: true })
    const realAfter = realAgentFingerprint()
    report.finished = new Date().toISOString()
    report.sweep = { ...swept, run_root_removed: !existsSync(runRoot) }
    report.real_agent_dir = { before: realBefore, after: realAfter, untouched: JSON.stringify(realBefore) === JSON.stringify(realAfter) }
    report.cleanup_ok = swept.after.length === 0 && cleanup.every((entry) => (entry.stillAlive ?? []).length === 0 && (entry.endpoints ?? []).every((endpoint) => endpoint.stillAlive.length === 0))
  }
  return finish(out, report, options)
}

if (import.meta.main ?? process.argv[1]?.endsWith("task-host-e2e-shard-cost.mjs")) {
  const options = parseArgs(process.argv.slice(2))
  main(options).then((code) => { process.exitCode = code }, (error) => {
    console.error(error?.stack ?? error)
    process.exitCode = 1
  })
}

export { parseArgs }
