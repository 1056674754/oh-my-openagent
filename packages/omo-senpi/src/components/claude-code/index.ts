import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import type { ComponentContext, OmoSenpiComponent, SenpiExtensionAPI } from "../../extension/types"
import { acquireClaudeCode, type ClaudeCodePin } from "./acquire"
import { findOnPath } from "./find-on-path"

export const CLAUDE_CODE_PROVIDER = "anthropic-subscription"
export const CLAUDE_CODE_PIN_FILE = "claude-code-pin.json"

type TurnContext = {
  readonly model?: { readonly provider?: string }
  readonly ui?: { notify?(message: string, level: "info" | "warning" | "error"): void }
}

export type ClaudeCodeComponentOptions = {
  readonly env?: NodeJS.ProcessEnv
  readonly execPath?: string
  readonly fetch?: typeof globalThis.fetch
  readonly platform?: NodeJS.Platform
  readonly which?: (command: string) => string | null
}

// A standalone binary carries the pin beside its provisioned runtime; an npm install has none and
// keeps the Claude Code executable its own install placed.
export function readClaudeCodePin(runtimeDir: string): ClaudeCodePin | undefined {
  const path = join(runtimeDir, CLAUDE_CODE_PIN_FILE)
  if (!existsSync(path)) return undefined
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"))
  if (typeof parsed !== "object" || parsed === null) return undefined
  const { name, version, integrity, claudeCodeVersion } = parsed as Record<string, unknown>
  if (typeof name !== "string" || typeof version !== "string" || typeof integrity !== "string") return undefined
  return { name, version, integrity, ...(typeof claudeCodeVersion === "string" ? { claudeCodeVersion } : {}) }
}

export function createClaudeCodeComponent(options: ClaudeCodeComponentOptions = {}): OmoSenpiComponent {
  return {
    name: "claude-code",
    register(pi: SenpiExtensionAPI, ctx: ComponentContext): void {
      const env = options.env ?? process.env
      const runtimeDir = dirname(options.execPath ?? process.execPath)
      const pin = readClaudeCodePin(runtimeDir)
      if (pin === undefined) return
      let settled: Promise<void> | undefined
      const ensure = (turn: TurnContext | undefined): Promise<void> => {
        if (env.CLAUDE_CODE_EXECUTABLE || (options.which ?? ((command: string) => findOnPath(command, env)))("claude") !== null) return Promise.resolve()
        settled ??= acquireClaudeCode({
          pin,
          cacheRoot: join(runtimeDir, "claude-code"),
          platform: options.platform,
          fetch: options.fetch,
          onDownloadStart: (message) => turn?.ui?.notify?.(message, "info"),
        }).then((acquired) => {
          if (acquired.path === null) {
            settled = undefined
            turn?.ui?.notify?.(acquired.error, "error")
            ctx.logger.warn(acquired.error)
            return
          }
          env.CLAUDE_CODE_EXECUTABLE = acquired.path
        })
        return settled
      }
      pi.on("before_agent_start", async (_payload, eventCtx) => {
        const turn = eventCtx as TurnContext | undefined
        if (turn?.model?.provider !== CLAUDE_CODE_PROVIDER) return undefined
        await ensure(turn)
        return undefined
      })
    },
  }
}
