import { afterEach, describe, expect, test } from "bun:test"
import { join } from "node:path"

import type { ExtensionAPI } from "@code-yeongyu/senpi"

import { loadSenpiBarrel } from "../../lazy/senpi-barrel"
import { InProcessRunner } from "../in-process"
import {
  acceptsConnections,
  createBuiltinChildMachine,
  loopbackPort,
  openBoundSession,
  watchHttpServers,
  type BuiltinChildMachine,
  type ServerWatch,
} from "./__fixtures__/builtin-child"
import { createRestoredChildHandle, type ChildSession } from "./child-handle"

// #9413: an in-process child loads senpi's builtin extensions, and codemode closes its per-session
// bridge server only on session_shutdown. A bridge port that still accepts connections after
// teardown is exactly the leak that kept `omo -p` alive.

const PRINT_RUN = join(import.meta.dir, "__fixtures__", "print-run.ts")
const PRINT_RUN_BOUND_MS = 90_000

let watch: ServerWatch | undefined
let machine: BuiltinChildMachine | undefined

afterEach(() => {
  for (const server of watch?.servers ?? []) {
    server.closeAllConnections()
    server.close()
  }
  watch?.stop()
  watch = undefined
  machine?.cleanup()
  machine = undefined
})

function listeningPorts(servers: ServerWatch): number[] {
  return servers.servers.filter((server) => server.listening).map(loopbackPort)
}

async function stillOpen(ports: readonly number[]): Promise<number[]> {
  const open = await Promise.all(ports.map(async (port) => ((await acceptsConnections(port)) ? [port] : [])))
  return open.flat()
}

type PrintRun = { readonly exit: number | "still running"; readonly stdout: string; readonly stderr: string }

async function printRun(turn: "succeeds" | "fails"): Promise<PrintRun> {
  const child = Bun.spawn([process.execPath, PRINT_RUN, turn], { stdout: "pipe", stderr: "pipe" })
  let watchdog: ReturnType<typeof setTimeout> | undefined
  const bound = new Promise<"still running">((resolve) => {
    watchdog = setTimeout(() => resolve("still running"), PRINT_RUN_BOUND_MS)
  })
  const exit = await Promise.race([child.exited, bound])
  clearTimeout(watchdog)
  if (exit === "still running") child.kill("SIGKILL")
  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
  return { exit, stdout, stderr }
}

describe("in-process child teardown shuts down its extensions (#9413)", () => {
  test("#9413 AC1: disposing an in-process child that loaded the builtin extensions runs its session_shutdown handlers and closes its codemode bridge, leaving no listening socket", async () => {
    // given: a real child with the builtin extensions, whose turn has settled
    watch = watchHttpServers()
    machine = await createBuiltinChildMachine()
    const handle = await new InProcessRunner().start(machine.spec("ac1-child", "succeeds"))
    expect(await handle.waitForIdle()).toMatchObject({ status: "completed", finalResponse: "child done" })
    const bridges = listeningPorts(watch)
    expect(bridges).toHaveLength(1)
    expect(await stillOpen(bridges)).toEqual(bridges)

    // when
    await handle.dispose()

    // then: codemode's session_shutdown handler ran, so its bridge no longer listens
    expect(watch.servers.filter((server) => server.listening)).toHaveLength(0)
    expect(await stillOpen(bridges)).toEqual([])
  }, 120_000)

  test.each(["succeeds", "fails"] as const)(
    "#9413 AC2: a print run that delegates one in-process task to a child that %s exits with code 0 within the bound",
    async (turn) => {
      // when: the run delegates one in-process task, tears it down, and returns from the top level
      const run = await printRun(turn)

      // then: nothing the child left behind keeps the process alive
      expect({ exit: run.exit, stderr: run.exit === 0 ? "" : run.stderr }).toEqual({ exit: 0, stderr: "" })
      expect(JSON.parse(run.stdout)).toEqual({ status: turn === "succeeds" ? "completed" : "error" })
    },
    PRINT_RUN_BOUND_MS + 30_000,
  )

  test("#9413 AC3: discardUnstartedChildSession gives a child whose handle never started the same shutdown, closing its codemode bridge", async () => {
    // given: a real builtin session whose handle construction fails, so the runner must discard it unstarted
    const servers = watchHttpServers()
    watch = servers
    machine = await createBuiltinChildMachine()
    let bridges: number[] = []
    const runner = new InProcessRunner({
      createSession: async (options): Promise<ChildSession> => {
        const session = await openBoundSession(options)
        bridges = listeningPorts(servers)
        return {
          sessionId: session.sessionId,
          extensionRunner: session.extensionRunner,
          prompt: (text) => session.prompt(text),
          steer: (text) => session.steer(text),
          followUp: (text) => session.followUp(text),
          abort: () => session.abort(),
          subscribe: () => {
            throw new Error("handle construction failed")
          },
          getLastAssistantText: () => session.getLastAssistantText(),
          dispose: () => session.dispose(),
        }
      },
    })

    // when
    const start = runner.start(machine.spec("ac3-child", "succeeds"))

    // then: the start fails, and the session it opened was shut down before being disposed
    await expect(start).rejects.toThrow("handle construction failed")
    expect(bridges).toHaveLength(1)
    expect(servers.servers.filter((server) => server.listening)).toHaveLength(0)
    expect(await stillOpen(bridges)).toEqual([])
  }, 120_000)

  test("a hung session_shutdown handler does not block child teardown past the host budget", async () => {
    // given: a child with an extension whose session_shutdown handler never settles, under a 300ms budget
    machine = await createBuiltinChildMachine()
    const senpi = await loadSenpiBarrel()
    const settingsManager = senpi.SettingsManager.inMemory({ sessionShutdownHandlerTimeoutMs: 300 })
    let shutdownSignal: AbortSignal | undefined
    const hangsOnShutdown = (pi: ExtensionAPI): void => {
      pi.on("session_shutdown", (event) => {
        shutdownSignal = event.signal
        return new Promise<void>(() => undefined)
      })
    }
    const session = await openBoundSession({
      cwd: machine.cwd,
      agentDir: machine.agentDir,
      model: machine.model,
      modelRuntime: machine.modelRuntime,
      modelRegistry: machine.modelRegistry,
      settingsManager,
      sessionManager: senpi.SessionManager.inMemory(),
      resourceLoader: new senpi.DefaultResourceLoader({
        cwd: machine.cwd,
        agentDir: machine.agentDir,
        settingsManager,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        extensionFactories: [{ name: "hangs-on-shutdown", factory: hangsOnShutdown }],
      }),
    })
    let disposed = false
    const dispose = session.dispose.bind(session)
    session.dispose = () => {
      disposed = true
      dispose()
    }
    const handle = createRestoredChildHandle({ taskId: "hung-child", session })

    // when: teardown waits only for the budget, never for the hung handler
    await handle.dispose()

    // then: the handler was asked to stop at the budget, and the session was still disposed
    expect(shutdownSignal?.aborted).toBe(true)
    expect(disposed).toBe(true)
  }, 120_000)
})
