import { type ChildFactory, engineChildFactory } from "@oh-my-opencode/senpi-desktop-service"
import {
  COMPUTER_ACTIONS_TOOL_NAME,
  COMPUTER_COMMAND_USAGE,
  COMPUTER_SUBCOMMANDS,
  COMPUTER_TOOL_NAME,
  type ComputerHostContext,
  ComputerHandle,
  type ComputerSettings,
  computerActionsPermissionParser,
  computerPermissionParser,
  createComputerActionsTool,
  createComputerTool,
  isSupportedHost,
  materializeComputerSkill,
  runComputerCommand,
} from "@oh-my-opencode/senpi-desktop-tool"

import type { ComponentContext, OmoSenpiComponent, SenpiExtensionAPI } from "../../extension/types"
import { loadSenpiOmoConfig } from "../config-resolution"
import { TrackedDesktopService } from "./engine-status"
import { resolveOmoComputerSettings } from "./settings"

export const COMPUTER_USE_COMPONENT_NAME = "computer-use"
export const COMPUTER_UNAVAILABLE = "Computer use is unavailable in this session."

type ExecuteTool = (toolName: string, params: unknown, options: { readonly signal: AbortSignal }) => Promise<unknown>

interface ComputerHostApi {
  getActiveTools(): string[]
  setActiveTools(names: string[]): void
  executeTool: ExecuteTool
}

interface CommandContext extends ComputerHostContext {
  readonly ui: { notify(message: string, level: "info" | "warning" | "error"): void }
}

export interface ComputerUseComponentOptions {
  readonly platform?: string
  /** Starts the engine child; `enginePath` is `computer.engine_path` (`undefined`: the located binary). */
  readonly engineChild?: (enginePath: string | undefined) => ChildFactory
  readonly loadSettings?: (cwd: string, platform: string) => ComputerSettings
}

function hostApi(pi: SenpiExtensionAPI): ComputerHostApi | undefined {
  const candidate = pi as SenpiExtensionAPI & Partial<ComputerHostApi>
  if (
    typeof candidate.getActiveTools !== "function" ||
    typeof candidate.setActiveTools !== "function" ||
    typeof candidate.executeTool !== "function"
  ) {
    return undefined
  }
  return {
    getActiveTools: () => candidate.getActiveTools!(),
    setActiveTools: (names) => candidate.setActiveTools!(names),
    executeTool: (name, params, options) => candidate.executeTool!(name, params, options),
  }
}

function defaultLoadSettings(cwd: string, platform: string): ComputerSettings {
  return resolveOmoComputerSettings(loadSenpiOmoConfig({ cwd }).config.computer, platform)
}

function isStatus(args: string): boolean {
  return (args.trim().toLowerCase() || "status") === "status"
}

function toolActivatedNames(payload: unknown): readonly string[] {
  if (typeof payload !== "object" || payload === null) return []
  const names = (payload as { toolNames?: unknown }).toolNames
  return Array.isArray(names) ? names.filter((name): name is string => typeof name === "string") : []
}

/**
 * Desktop computer use: the search-exposed `computer` tool (with its `kernelPrelude` and read/exec
 * `permissionParser`), `computer_actions` behind `computer.cua_adapter`, `/computer`, and the skill.
 * Registration happens at extension load so tool_search indexes the tool at session_start; nothing
 * starts until the tool is activated (a by-name call, `setActiveTools`, or `/computer on`).
 */
export function createComputerUseComponent(options: ComputerUseComponentOptions = {}): OmoSenpiComponent {
  const platform = options.platform ?? process.platform
  const engineChild = options.engineChild ?? engineChildFactory
  const loadSettings = options.loadSettings ?? defaultLoadSettings

  return {
    name: COMPUTER_USE_COMPONENT_NAME,
    register(pi: SenpiExtensionAPI, ctx: ComponentContext): void {
      const api = hostApi(pi)
      const available = (() => {
        if (!isSupportedHost(platform)) return undefined
        if (api === undefined) {
          ctx.logger.warn("computer-use skipped: host lacks getActiveTools/setActiveTools/executeTool", {
            component: COMPUTER_USE_COMPONENT_NAME,
          })
          return undefined
        }
        try {
          const settings = loadSettings(pi.cwd ?? process.cwd(), platform)
          return settings.enabled ? { host: api, settings } : undefined
        } catch (error) {
          ctx.logger.warn("computer-use skipped: invalid computer settings", {
            component: COMPUTER_USE_COMPONENT_NAME,
            error: error instanceof Error ? error.message : String(error),
          })
          return undefined
        }
      })()

      let session: { handle: ComputerHandle; service: TrackedDesktopService; host: ComputerHostApi } | undefined

      pi.registerCommand("computer", {
        description: "Computer use: on, off, status, stop, or resume (stop and resume are user-only)",
        argumentHint: COMPUTER_SUBCOMMANDS.join("|"),
        getArgumentCompletions: (prefix: string) =>
          COMPUTER_SUBCOMMANDS.filter((name) => name.startsWith(prefix.trim())).map((name) => ({
            value: name,
            label: name,
          })),
        handler: async (args: string, commandCtx: CommandContext) => {
          if (session === undefined) {
            commandCtx.ui.notify(COMPUTER_UNAVAILABLE, "warning")
            return
          }
          const { handle, service } = session
          try {
            const text = await runComputerCommand(args, handle, commandCtx)
            if (!isStatus(args)) {
              commandCtx.ui.notify(text, text === COMPUTER_COMMAND_USAGE ? "warning" : "info")
              return
            }
            const prelude = session.host.getActiveTools().includes(COMPUTER_TOOL_NAME) ? "active" : "inactive"
            commandCtx.ui.notify(`${text}\nengine: ${service.engineState}\nprelude: ${prelude}`, "info")
          } catch (error) {
            if (!(error instanceof Error)) throw error
            commandCtx.ui.notify(`/computer ${args.trim()}: ${error.message}`, "error")
          }
        },
      })

      if (available === undefined) return
      const { settings } = available
      const service = new TrackedDesktopService({ createChild: engineChild(settings.enginePath) })
      const handle = new ComputerHandle({ service, settings: () => settings })
      const host = available.host
      session = { handle, service, host }
      handle.onActivationChange((active) => {
        const current = host.getActiveTools()
        if (active === current.includes(COMPUTER_TOOL_NAME)) return
        host.setActiveTools(
          active ? [...current, COMPUTER_TOOL_NAME] : current.filter((name) => name !== COMPUTER_TOOL_NAME),
        )
      })
      const executeTool = host.executeTool
      pi.registerTool({
        ...createComputerTool({ handle, executeTool }),
        permissionParser: (input: Record<string, unknown>, cwd: string) =>
          computerPermissionParser(COMPUTER_TOOL_NAME, input, cwd),
      })
      if (settings.cuaAdapter) {
        pi.registerTool({
          ...createComputerActionsTool({ handle, executeTool }),
          permissionParser: (input: Record<string, unknown>, cwd: string) =>
            computerActionsPermissionParser(COMPUTER_ACTIONS_TOOL_NAME, input, cwd),
        })
      }

      pi.on("resources_discover", () => ({ skillPaths: [materializeComputerSkill()] }))
      pi.on("tool_activated", async (payload, eventCtx) => {
        if (handle.active || !toolActivatedNames(payload).includes(COMPUTER_TOOL_NAME)) return
        await handle.activate(eventCtx as ComputerHostContext)
      })
      pi.on("session_shutdown", () => handle.close())
    },
  }
}
