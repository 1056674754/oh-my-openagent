import { existsSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { observeState, stopParent } from "./task-host-e2e-events.mjs"
import { pidAlive } from "./task-host-e2e-process.mjs"
import {
  addProject,
  endpointSockets,
  mainProject,
  newSandbox,
  startParent,
  statusAll,
  taskRecords,
  teardownSandbox,
} from "./task-host-e2e-shard-cost-support.mjs"
import {
  CHILDREN_PER_PARENT,
  continuationCount,
  crashRows,
  endpointFacts,
  heldSteps,
  parentSteps,
  pass,
  recordsByParent,
  shardConfig,
  statusWorkers,
  writeRoute,
} from "./task-host-e2e-shards-support.mjs"

const terminal = (record) => ["completed", "error", "lost", "cancelled"].includes(record.status)

function ready(project) {
  const records = taskRecords(project)
  return records.length === CHILDREN_PER_PARENT * 2 && records.every((record) => record.status === "running")
    ? records
    : undefined
}

function allTerminal(project) {
  const records = taskRecords(project)
  return records.length === CHILDREN_PER_PARENT * 2 && records.every(terminal) ? records : undefined
}

export async function runCrashMatrix(config, artifacts) {
  const sandbox = newSandbox(config, config.kind === "control" ? "control" : "crash", {
    omoConfig: shardConfig(),
    script: { parentSteps: [{ type: "text", text: "unused" }], childSteps: [{ type: "text", text: "unused" }] },
  })
  const project = mainProject(sandbox, sandbox.script)
  const routeA = writeRoute(sandbox, "a", { parentSteps: [], childSteps: [] })
  const routeB = writeRoute(sandbox, "b", { parentSteps: [], childSteps: [] })
  const releaseA = join(routeA, "release")
  const releaseB = join(routeB, "release")
  const scriptA = { parentSteps: parentSteps(routeA, "a"), childSteps: heldSteps(releaseA, "A child") }
  const scriptB = { parentSteps: parentSteps(routeB, "b"), childSteps: heldSteps(releaseB, "B child") }
  writeFileSync(join(routeA, "mock-script.json"), `${JSON.stringify(scriptA, null, 2)}\n`)
  writeFileSync(join(routeB, "mock-script.json"), `${JSON.stringify(scriptB, null, 2)}\n`)
  const markerA = `[[mock-cwd:${routeA}]]`
  const markerB = `[[mock-cwd:${routeB}]]`
  const parents = [
    startParent(sandbox, project, `parent A ${markerA}`),
    startParent(sandbox, project, `parent B ${markerB}`),
  ]
  const cleanup = []
  try {
    const started = await observeState(sandbox.root, () => ready(project), { timeoutMs: 240_000 })
    if (started === undefined) throw new Error("six children did not reach running")
    const groups = recordsByParent(project)
    const parentIds = [...groups.keys()]
    const before = endpointFacts(sandbox)
    const workersBefore = statusWorkers(sandbox)
    const sockets = endpointSockets(sandbox)
    const control = config.kind === "control"
    const topology = control
      ? sockets.length === 1 && sockets[0].endsWith("/rpc/rpc.sock") && workersBefore[0]?.workers === 6
      : sockets.length === 2 && sockets.every((socket) => /\/p-[0-9a-f]{16}\.sock$/.test(socket)) &&
        workersBefore.length === 2 && workersBefore.every((row) => row.workers === 3) &&
        before.every((row) => row.host !== null && row.hostPpid === row.supervisor) &&
        !existsSync(join(sandbox.agentDir, "rpc", "rpc.sock"))
    if (!topology) throw new Error(`unexpected topology: ${JSON.stringify({ sockets, workersBefore, before })}`)

    const endpointA = control ? before[0] : before.find((row) => row.owner === parentIds[0])
    const endpointB = control ? before[0] : before.find((row) => row.owner === parentIds[1])
    if (endpointA?.host === null || endpointA?.host === undefined) throw new Error("host child A missing")
    process.kill(endpointA.host, "SIGSEGV")
    const crashed = await observeState(sandbox.root, () => {
      const rows = crashRows(sandbox, endpointA.socket)
      return rows.length > 0 ? rows : undefined
    }, { timeoutMs: 60_000 })
    if (crashed === undefined) throw new Error("crash record did not appear")

    writeFileSync(releaseB, "go\n")
    const bIds = new Set(groups.get(parentIds[1]).map((record) => record.task_id))
    const bFinished = await observeState(sandbox.root, () => {
      const records = taskRecords(project).filter((record) => bIds.has(record.task_id))
      return records.length === 3 && records.every(terminal) ? records : undefined
    }, { timeoutMs: 180_000 })
    if (bFinished === undefined) throw new Error("parent B children did not settle during A fault window")

    const replaced = await observeState(sandbox.root, () => {
      const after = endpointFacts(sandbox).find((row) => row.socket === endpointA.socket)
      return after?.supervisor !== null && after?.supervisor !== endpointA.supervisor ? after : undefined
    }, { timeoutMs: 180_000 })
    writeFileSync(releaseA, "go\n")
    const final = await observeState(sandbox.root, () => allTerminal(project), { timeoutMs: 180_000 })
    if (final === undefined) throw new Error("six children did not settle")
    const continuations = Object.fromEntries(final.map((record) => [record.task_id, continuationCount(sandbox, record.task_id)]))
    const after = endpointFacts(sandbox)
    const bAfter = control ? after[0] : after.find((row) => row.socket === endpointB.socket)

    for (const prefix of ["a", "b"]) writeFileSync(join(sandbox.cwd, ".omo", `parent-${prefix}-release`), "go\n")
    await Promise.all(parents.map((parent) => stopParent(parent)))
    const facts = {
      parentIds,
      sockets,
      workersBefore,
      before,
      crashRows: crashed,
      replaced,
      bFinished: bFinished.map((record) => record.status),
      final: final.map((record) => ({ task_id: record.task_id, parent: record.parent_session_id, status: record.status })),
      continuations,
      bStable: control ? false : bAfter?.supervisor === endpointB.supervisor && bAfter?.host === endpointB.host &&
        bAfter?.status?.instanceId === endpointB.status?.instanceId && crashRows(sandbox, endpointB.socket).length === 0,
      oldSupervisorGone: endpointA.supervisor !== null && !pidAlive(endpointA.supervisor),
    }
    writeFileSync(join(artifacts, `${config.kind}-crash.json`), `${JSON.stringify(facts, null, 2)}\n`)
    return facts
  } finally {
    cleanup.push(await teardownSandbox(sandbox, parents))
    writeFileSync(join(artifacts, `${config.kind}-cleanup.json`), `${JSON.stringify(cleanup, null, 2)}\n`)
  }
}

export function crashRowsForReport(facts, artifacts) {
  const evidence = [join(artifacts, "sharded-crash.json")]
  const sixComplete = facts.final.length === 6 && facts.final.every((record) => record.status === "completed")
  const oneEach = Object.values(facts.continuations).filter((count) => count === 1).length >= 3
  return {
    topology_two_parent_shards: pass(evidence, { sockets: facts.sockets, workers: facts.workersBefore }),
    host_crash_isolated: facts.bStable ? pass(evidence, { bStable: true }) : { status: "fail", evidence, reason: "bystander shard changed" },
    crashed_shard_reattaches: facts.replaced !== undefined && oneEach
      ? pass(evidence, { replaced: facts.replaced, continuations: facts.continuations })
      : { status: "fail", evidence, reason: "crashed shard did not replace with continuations" },
    all_six_children_complete: sixComplete
      ? pass(evidence, { final: facts.final })
      : { status: "fail", evidence, reason: "not every child completed" },
  }
}

export function controlRowForReport(facts, artifacts) {
  const evidence = [join(artifacts, "control-crash.json")]
  const parentCounts = Map.groupBy(facts.final, (record) => record.parent)
  const cascadedParents = [...parentCounts.values()].filter((records) =>
    records.some((record) => (facts.continuations[record.task_id] ?? 0) >= 1))
  const shared = facts.sockets.length === 1 && facts.sockets[0].endsWith("/rpc/rpc.sock") &&
    facts.workersBefore.length === 1 && facts.workersBefore[0].workers === 6
  const allComplete = facts.final.length === 6 && facts.final.every((record) => record.status === "completed")
  return shared && cascadedParents.length === 2 && allComplete
    ? pass(evidence, {
        topology: "one rpc.sock with six workers",
        cascadedParents: cascadedParents.length,
        continuations: facts.continuations,
      })
    : {
        status: "fail",
        evidence,
        reason: `shared=${shared} cascadedParents=${cascadedParents.length} allComplete=${allComplete}`,
      }
}
