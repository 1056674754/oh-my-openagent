import { createServer } from "node:net"
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

import { observeState, stopParent } from "./task-host-e2e-events.mjs"
import {
  endpointSockets,
  stopEndpoint,
  taskRecords,
} from "./task-host-e2e-shard-cost-support.mjs"
import { HostClient } from "./task-host-e2e-shards-rpc.mjs"
import { childSessionFiles } from "./task-host-e2e-support.mjs"
import {
  childTurnFacts,
  cleanupScenario,
  createRetainScenario,
  heldText,
  noticeCount,
  parentSessionPath,
  replaceParentServer,
  result,
  rewriteRecordedSocket,
  startParent,
  taskOutputStep,
  taskStep,
  textStep,
} from "./task-host-e2e-shards-retain-live-support.mjs"

function startIncompatibleFixture(socketPath) {
  const commands = []
  rmSync(socketPath, { force: true })
  mkdirSync(dirname(socketPath), { recursive: true })
  const server = createServer((socket) => {
    let buffer = ""
    socket.setEncoding("utf8")
    socket.on("data", (chunk) => {
      buffer += chunk
      for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
        const request = JSON.parse(buffer.slice(0, newline))
        buffer = buffer.slice(newline + 1)
        commands.push(request)
        const data = {
          protocolVersion: 0,
          serverVersion: "0.0.0-incompatible",
          instanceId: "todo14-incompatible",
          generation: 1,
          engineVersion: "0.0.0-incompatible",
          engineOrdinal: [0, 0, 0, 0, 0],
          capabilities: ["multi_session"],
          launch_profile: { profile_id: "todo14-incompatible" },
        }
        socket.write(`${JSON.stringify({
          type: "response",
          id: request.id,
          command: request.type,
          success: true,
          data,
        })}\n`)
      }
    })
  })
  server.listen(socketPath)
  return {
    commands,
    ready: new Promise((resolve, reject) => {
      server.once("listening", resolve)
      server.once("error", reject)
    }),
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

async function retainedChildren(current, name, count) {
  const release = join(current.root, `${name}-${process.pid}.release`)
  const prompts = Array.from({ length: count }, (_, index) => `${name} child ${index}`)
  const parentSteps = [
    ...prompts.map((prompt, index) => taskStep(`${name}-${index}`, prompt)),
    textStep(`${name} initial parent done`),
  ]
  const childSteps = prompts.map((_, index) =>
    heldText(`${name} child ${index} complete`, release))
  const scenario = await createRetainScenario(current, name, { parentSteps, childSteps })
  let parent = startParent(scenario, `start ${name}`)
  const records = await observeState(scenario.sandbox.root, () => {
    const rows = taskRecords(scenario.project)
    return rows.length === count &&
      rows.every((record) => record.status === "running" && record.host_session?.socket)
      ? rows
      : undefined
  })
  if (records === undefined) throw new Error(`${name}: children never reached running`)
  const parentSession = parentSessionPath(scenario.sandbox, records[0].parent_session_id)
  await stopParent(parent)
  parent = undefined
  writeFileSync(release, "go\n")
  const completed = await observeState(scenario.sandbox.root, () => {
    const rows = taskRecords(scenario.project)
    return rows.length === count && rows.every((record) => record.status === "completed")
      ? rows
      : undefined
  })
  if (completed === undefined) throw new Error(`${name}: children did not settle`)
  return { scenario, records: completed, prompts, parentSession, release, parent }
}

async function incompatibilityFacts(current, artifacts) {
  const retained = await retainedChildren(current, "incompatibility", 1)
  const { scenario, records, parentSession, release } = retained
  let resumed
  let fixture
  try {
    const record = records[0]
    await stopEndpoint(scenario.sandbox, record.host_session.socket)
    const socket = join(scenario.sandbox.agentDir, "rpc", "incompatible.sock")
    fixture = startIncompatibleFixture(socket)
    await fixture.ready
    rewriteRecordedSocket(scenario.project, record.task_id, socket, "todo14-incompatible")
    await replaceParentServer(scenario, [
      taskOutputStep(record.task_id),
      textStep("incompatibility observed"),
    ])
    resumed = startParent(scenario, "resume incompatible retained child", parentSession)
    const parked = await observeState(scenario.sandbox.root, () => {
      const row = taskRecords(scenario.project).find((entry) => entry.task_id === record.task_id)
      return row?.suspension_reason === "host_incompatible" ? row : undefined
    })
    const facts = {
      socket,
      parked_status: parked?.status ?? null,
      parked_residency: parked?.residency_state ?? null,
      parked_reason: parked?.suspension_reason ?? null,
      commands: fixture.commands.map((command) => command.type),
      open_session_count: fixture.commands
        .filter((command) => command.type === "open_session").length,
      notice_count: noticeCount(parentSession, "host_unavailable:host_incompatible"),
      other_endpoints: endpointSockets(scenario.sandbox),
    }
    return {
      facts,
      ok: facts.parked_reason === "host_incompatible" &&
        facts.open_session_count === 0 &&
        facts.notice_count === 1 &&
        facts.other_endpoints.length === 0,
    }
  } finally {
    await stopParent(resumed)
    await fixture?.close()
    writeFileSync(release, "go\n")
    await cleanupScenario(
      scenario,
      [resumed],
      join(artifacts, "incompatibility-cleanup.json"),
    )
  }
}

async function isolationFacts(current, artifacts) {
  const retained = await retainedChildren(current, "entry-isolation", 2)
  const { scenario, records, prompts, parentSession, release } = retained
  let resumed
  let client
  try {
    const [deleted, good] = records
    const socket = good.host_session.socket
    const originalSameHost = deleted.host_session.socket === socket
    rmSync(deleted.host_session.session_path, { force: true })
    client = await HostClient.connect(socket, "entry-isolation")
    const listed = await client.request({ type: "list_sessions", include_workers: true })
    client.close()
    client = undefined
    await replaceParentServer(scenario, [
      taskOutputStep(deleted.task_id),
      taskOutputStep(good.task_id),
      textStep("entry isolation observed"),
    ])
    resumed = startParent(scenario, "resume after deleting one transcript", parentSession)
    const observed = await observeState(scenario.sandbox.root, () => {
      const rows = taskRecords(scenario.project)
      const bad = rows.find((entry) => entry.task_id === deleted.task_id)
      const kept = rows.find((entry) => entry.task_id === good.task_id)
      const isolated = ["lost", "error"].includes(bad?.status) ||
        bad?.residency_state === "rpc_detached" ||
        /missing|ENOENT|transcript|session/i.test(
          `${bad?.error_message ?? ""} ${bad?.suspension_reason ?? ""}`,
        )
      return isolated && kept?.host_session?.socket === socket ? { bad, kept } : undefined
    })
    const turns = childTurnFacts(scenario.sandbox, good.task_id, prompts[1])
    const facts = {
      socket,
      original_same_host: originalSameHost,
      list_sessions_answered: Array.isArray(listed.data?.sessions),
      deleted_task: observed?.bad ?? null,
      good_task: observed?.kept ?? null,
      deleted_transcript_absent: !existsSync(deleted.host_session.session_path),
      good_transcript_present: childSessionFiles(scenario.sandbox, good.task_id)
        .includes(good.host_session.session_path),
      ...turns,
    }
    return {
      facts,
      ok: facts.list_sessions_answered &&
        facts.original_same_host &&
        facts.deleted_transcript_absent &&
        facts.good_transcript_present &&
        facts.good_task?.host_session?.socket === socket &&
        facts.prompt_count === 1 &&
        facts.machine_user_turns === 1 &&
        facts.child_session_files.length === 1,
    }
  } finally {
    client?.close()
    await stopParent(resumed)
    writeFileSync(release, "go\n")
    await cleanupScenario(
      scenario,
      [resumed],
      join(artifacts, "entry-isolation-cleanup.json"),
    )
  }
}

export async function runIncompatibilityAndEntryIsolation(current, artifacts) {
  const incompatibility = await incompatibilityFacts(current, artifacts)
  const entryIsolation = await isolationFacts(current, artifacts)
  const facts = {
    incompatibility: incompatibility.facts,
    entry_isolation: entryIsolation.facts,
  }
  return result(
    incompatibility.ok && entryIsolation.ok,
    join(artifacts, "incompatibility-entry-isolation.json"),
    facts,
    "incompatibility or per-entry isolation invariants failed",
    [
      join(artifacts, "incompatibility-cleanup.json"),
      join(artifacts, "entry-isolation-cleanup.json"),
    ],
  )
}
