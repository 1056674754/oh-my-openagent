import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { artifactsMatch } from "./build-artifact.mjs"
import { buildExtension, extensionBuildPaths } from "./build-extension-core.mjs"
import { findStaleRuntimePersona } from "./persona-artifacts.mjs"

export async function checkExtensionCurrent(options = {}) {
  const {
    outputPath,
    taskOutputPath,
    memberOutputPath,
    supervisorOutputPath,
    advisorRuntimeOutputPath,
    toolkitSdkOutputPath,
    rollbackRuntimeOutputPath,
  } = extensionBuildPaths
  const output = options.outputPath ?? outputPath
  const taskOutput = options.taskOutputPath ?? (options.outputPath === undefined ? taskOutputPath : join(dirname(output), "omo-task.js"))
  const memberOutput = options.memberOutputPath ?? (options.outputPath === undefined ? memberOutputPath : join(dirname(output), "omo-member.js"))
  const supervisorOutput = options.supervisorOutputPath ?? (options.outputPath === undefined ? supervisorOutputPath : join(dirname(output), "memory-run-supervisor.mjs"))
  const advisorRuntimeOutput = options.advisorRuntimeOutputPath ?? (options.outputPath === undefined ? advisorRuntimeOutputPath : join(dirname(output), "omo-init-deep-advisor.js"))
  const toolkitSdkOutput = options.toolkitSdkOutputPath ?? (options.outputPath === undefined ? toolkitSdkOutputPath : join(dirname(output), "runtime", "agent-toolkit-sdk", "sdk.js"))
  const rollbackRuntimeOutput = options.rollbackRuntimeOutputPath ?? (options.outputPath === undefined ? rollbackRuntimeOutputPath : join(dirname(output), "runtime", "rollback-migrate.js"))
  const currentToolkitSdk = await readBuiltEntry(toolkitSdkOutput)
  if (currentToolkitSdk === undefined) return { ok: false, reason: "missing-output", output: toolkitSdkOutput }
  const currentRollbackRuntime = await readBuiltEntry(rollbackRuntimeOutput)
  if (currentRollbackRuntime === undefined) return { ok: false, reason: "missing-output", output: rollbackRuntimeOutput }
  const currentMain = await readBuiltEntry(output)
  if (currentMain === undefined) return { ok: false, reason: "missing-output", output }
  const currentTask = await readBuiltEntry(taskOutput)
  if (currentTask === undefined) return { ok: false, reason: "missing-output", output: taskOutput }
  const currentMember = await readBuiltEntry(memberOutput)
  if (currentMember === undefined) return { ok: false, reason: "missing-output", output: memberOutput }
  const currentSupervisor = await readBuiltEntry(supervisorOutput)
  if (currentSupervisor === undefined) return { ok: false, reason: "missing-output", output: supervisorOutput }
  const currentAdvisorRuntime = await readBuiltEntry(advisorRuntimeOutput)
  if (currentAdvisorRuntime === undefined) return { ok: false, reason: "missing-output", output: advisorRuntimeOutput }

  const tempRoot = await mkdtemp(join(tmpdir(), "omo-senpi-build-check-"))
  const expected = {
    outputPath: join(tempRoot, "omo.js"),
    taskOutputPath: join(tempRoot, "omo-task.js"),
    memberOutputPath: join(tempRoot, "omo-member.js"),
    supervisorOutputPath: join(tempRoot, "memory-run-supervisor.mjs"),
    advisorRuntimeOutputPath: join(tempRoot, "omo-init-deep-advisor.js"),
    toolkitSdkOutputPath: join(tempRoot, "runtime", "agent-toolkit-sdk", "sdk.js"),
    rollbackRuntimeOutputPath: join(tempRoot, "runtime", "rollback-migrate.js"),
  }
  try {
    await buildExtension(expected)
    for (const [current, built, outputFile] of [
      [currentRollbackRuntime, expected.rollbackRuntimeOutputPath, rollbackRuntimeOutput],
      [currentToolkitSdk, expected.toolkitSdkOutputPath, toolkitSdkOutput],
      [currentMain, expected.outputPath, output],
      [currentTask, expected.taskOutputPath, taskOutput],
      [currentMember, expected.memberOutputPath, memberOutput],
      [currentSupervisor, expected.supervisorOutputPath, supervisorOutput],
      [currentAdvisorRuntime, expected.advisorRuntimeOutputPath, advisorRuntimeOutput],
    ]) {
      if (!artifactsMatch(current, await readFile(built, "utf8"))) {
        return { ok: false, reason: "stale-output", output: outputFile }
      }
    }
    const stalePersona = await findStaleRuntimePersona(tempRoot, dirname(output), extensionBuildPaths.repoRoot)
    if (stalePersona !== undefined) return { ok: false, reason: "stale-output", output: stalePersona }
    return { ok: true, output, taskOutput, memberOutput, advisorRuntimeOutput }
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
}

function isErrno(error, code) {
  return error instanceof Error && "code" in error && error.code === code
}

async function readBuiltEntry(output) {
  try {
    return await readFile(output, "utf8")
  } catch (error) {
    if (isErrno(error, "ENOENT")) return undefined
    throw error
  }
}
