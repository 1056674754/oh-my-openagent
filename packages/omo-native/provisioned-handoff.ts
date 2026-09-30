import { dirname } from "node:path"
import { propagateResult, runChild } from "./bin/lib/child-process.js"
import { isProvisionedExecutable, shouldReexecAfterProvisioning } from "./compile-runtime"

export type ProvisionedLaunch = { readonly provision: boolean; readonly handOff: boolean; readonly execDir: string }

export function planProvisionedLaunch(
  runningExecutable: string,
  expected: string,
  options: { platform?: NodeJS.Platform } = {},
): ProvisionedLaunch {
  const provision = !isProvisionedExecutable(runningExecutable, expected)
  const handOff = provision && shouldReexecAfterProvisioning(options.platform)
  return { provision, handOff, execDir: provision && !handOff ? dirname(expected) : dirname(runningExecutable) }
}

export async function reexecProvisionedRuntime(expected: string, options: {
  argv?: string[]
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  execve?: ((file: string, argv: string[], env: NodeJS.ProcessEnv) => void) | null
  run?: typeof runChild
  propagate?: typeof propagateResult
} = {}): Promise<void> {
  const argv = options.argv ?? process.argv.slice(2)
  const env = options.env ?? process.env
  const run = options.run ?? runChild
  const propagate = options.propagate ?? propagateResult
  const execve = options.execve === undefined ? process.execve : options.execve
  if ((options.platform ?? process.platform) !== "win32" && typeof execve === "function") {
    try {
      execve(expected, [expected, ...argv], env)
      return
    } catch {
      // A provisioned binary that cannot replace this image still uses the async fallback.
    }
  }
  const result = await run(expected, argv, { env })
  propagate(result)
}

export async function handOffToProvisionedRuntime(expected: string): Promise<void> {
  await reexecProvisionedRuntime(expected)
}
