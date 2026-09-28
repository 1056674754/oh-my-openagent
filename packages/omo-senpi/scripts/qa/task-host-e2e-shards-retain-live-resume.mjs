import { existsSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { observeState, stopParent } from "./task-host-e2e-events.mjs"
import { waitFor } from "./task-host-e2e-process.mjs"
import {
  hostStatus,
  processTable,
  supervisorPid,
  taskRecords,
  treePids,
} from "./task-host-e2e-shard-cost-support.mjs"
import {
  continuationCount,
  crashRows,
} from "./task-host-e2e-shards-support.mjs"
import {
  childTurnFacts,
  cleanupScenario,
  createRetainScenario,
  heldText,
  IDLE_MS,
  parentSessionPath,
  replaceParentServer,
  requestCount,
  result,
  startParent,
  taskOutputStep,
  taskStep,
  terminal,
  textStep,
} from "./task-host-e2e-shards-retain-live-support.mjs"

async function runRetainResume(current, artifacts, midturn) {
  const id = midturn ? "retain-midturn-continuation" : "retain-idle-resume"
  const childPrompt = `${id} original child prompt`
  const release = join(current.root, `${id}-${process.pid}.release`)
  const parentRelease = join(current.root, `${id}-${process.pid}.parent-release`)
  const resumeRelease = join(current.root, `${id}-${process.pid}.resume-release`)
  const scenario = await createRetainScenario(current, id, {
    task: { host_idle_exit_ms: midturn ? 900_000 : IDLE_MS },
    parentSteps: [
      taskStep("retained", childPrompt),
      heldText(`${id} initial parent complete`, parentRelease),
    ],
    childSteps: [
      heldText(`${id} original turn complete`, release),
      textStep(`${id} continuation complete`),
    ],
  })
  const { sandbox, project } = scenario
  const env = { SENPI_RPC_SESSION_IDLE_EVICTION_MS: String(IDLE_MS) }
  let parent
  let resumed
  try {
    parent = startParent(scenario, `start ${id}`, undefined, env)
    const running = await observeState(sandbox.root, () => {
      const record = taskRecords(project).find((entry) => entry.name === "retained")
      return record?.status === "running" && record.host_session?.socket ? record : undefined
    })
    if (running === undefined) throw new Error(`${id}: child never reached running`)
    const socket = running.host_session.socket
    const before = await waitFor(() => {
      const supervisor = supervisorPid(sandbox, socket)
      if (supervisor === undefined) return undefined
      const table = processTable()
      const host = treePids(supervisor, table).find((pid) =>
        table.get(pid)?.args.includes("--mode rpc"))
      return host === undefined
        ? undefined
        : { supervisor, host, status: hostStatus(sandbox, socket).json }
    }, { timeoutMs: 60_000, intervalMs: 250 })
    if (before === undefined) throw new Error(`${id}: host child missing`)
    const sessionPath = parentSessionPath(sandbox, running.parent_session_id)
    if (midturn) {
      const crashed = await observeState(sandbox.root, () => {
        const rows = crashRows(sandbox, socket)
        return rows.length > 0 ? rows : undefined
      }, {
        trigger: () => {
          process.kill(before.host, "SIGSEGV")
        },
      })
      if (crashed === undefined) throw new Error(`${id}: host crash was not recorded`)
      writeFileSync(release, "go\n")
      writeFileSync(parentRelease, "go\n")
      await stopParent(parent)
      parent = undefined
      const gone = await observeState(sandbox.root, () =>
        supervisorPid(sandbox, socket) === undefined && !existsSync(socket) ? true : undefined)
      if (gone !== true) throw new Error(`${id}: crashed shard did not become unreachable`)
    } else {
      writeFileSync(release, "go\n")
      const completed = await observeState(sandbox.root, () => {
        const record = taskRecords(project).find((entry) => entry.task_id === running.task_id)
        return record?.status === "completed" ? record : undefined
      })
      if (completed === undefined) throw new Error(`${id}: child did not settle`)
      writeFileSync(parentRelease, "go\n")
      await stopParent(parent)
      parent = undefined
      const exited = await observeState(sandbox.root, () =>
        supervisorPid(sandbox, socket) === undefined && !existsSync(socket) ? true : undefined)
      if (exited !== true) throw new Error(`${id}: idle host did not exit`)
    }
    await replaceParentServer(scenario, [
      taskOutputStep(running.task_id),
      heldText(`${id} resumed parent complete`, resumeRelease),
    ])

    resumed = startParent(scenario, `resume ${id}`, sessionPath, env)
    const settled = await observeState(sandbox.root, () => {
      const record = taskRecords(project).find((entry) => entry.task_id === running.task_id)
      return terminal(record) ? record : undefined
    })
    if (settled === undefined) throw new Error(`${id}: retained child did not settle`)
    writeFileSync(resumeRelease, "go\n")
    await stopParent(resumed)
    resumed = undefined
    const after = {
      supervisor: supervisorPid(sandbox, socket),
      status: hostStatus(sandbox, socket).json,
    }
    const turns = childTurnFacts(sandbox, running.task_id, childPrompt)
    const facts = {
      socket,
      resumed_socket: settled.host_session?.socket ?? null,
      fresh_generation: before?.supervisor !== after?.supervisor,
      final_status: settled.status,
      child_http_requests: requestCount(scenario.childLog),
      replay_count: turns.prompt_count - 1,
      continuation_count: continuationCount(sandbox, running.task_id),
      ...turns,
    }
    const expectedTurns = midturn ? 2 : 1
    const ok = facts.resumed_socket === socket &&
      facts.fresh_generation &&
      facts.final_status === "completed" &&
      facts.prompt_count === 1 &&
      facts.replay_count === 0 &&
      facts.child_http_requests === expectedTurns &&
      facts.machine_user_turns === expectedTurns &&
      facts.continuation_count === (midturn ? 1 : 0) &&
      facts.child_session_files.length === 1
    return result(
      ok,
      join(artifacts, `${id}.json`),
      facts,
      `${id} retained-session invariants failed`,
    )
  } finally {
    writeFileSync(release, "go\n")
    writeFileSync(parentRelease, "go\n")
    writeFileSync(resumeRelease, "go\n")
    await cleanupScenario(
      scenario,
      [parent, resumed],
      join(artifacts, `${id}-cleanup.json`),
    )
  }
}

export const runRetainIdleResume = (current, artifacts) =>
  runRetainResume(current, artifacts, false)

export const runRetainMidturnContinuation = (current, artifacts) =>
  runRetainResume(current, artifacts, true)
