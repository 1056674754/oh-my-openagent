import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ComponentContext, SenpiExtensionAPI } from "../../extension/types"
import { CLAUDE_CODE_PIN_FILE, createClaudeCodeComponent } from "./index"

const roots: string[] = []
const temp = () => { const root = mkdtempSync(join(tmpdir(), "omo-claude-code-component-")); roots.push(root); return root }
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

type Handler = (payload: unknown, ctx?: unknown) => unknown
const noopLogger = { info() {}, warn() {}, error() {} }

async function harness(options: { pin: boolean; env?: NodeJS.ProcessEnv; claudeOnPath?: string }) {
  const runtimeDir = temp()
  const bytes = await new Bun.Archive({ "package/claude": "#!/bin/sh\n" }, { compress: "gzip" }).bytes()
  if (options.pin) {
    writeFileSync(join(runtimeDir, CLAUDE_CODE_PIN_FILE), JSON.stringify({
      name: "@anthropic-ai/claude-agent-sdk-darwin-arm64",
      version: "0.3.284",
      integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
      claudeCodeVersion: "2.1.284",
    }))
  }
  const handlers = new Map<string, Handler>()
  const requests: string[] = []
  const env: NodeJS.ProcessEnv = options.env ?? {}
  const component = createClaudeCodeComponent({
    env,
    execPath: join(runtimeDir, "omo"),
    platform: "darwin",
    which: () => options.claudeOnPath ?? null,
    fetch: (async (input: string | URL | Request) => { requests.push(String(input)); return new Response(bytes) }) as typeof globalThis.fetch,
  })
  const pi = { on: (event: string, handler: Handler) => { handlers.set(event, handler) } } as unknown as SenpiExtensionAPI
  await component.register(pi, { logger: noopLogger, config: { getFlag: () => undefined } } as ComponentContext)
  const notices: string[] = []
  const turn = (provider: string) => handlers.get("before_agent_start")?.({}, { model: { provider }, ui: { notify: (message: string) => notices.push(message) } })
  return { env, requests, notices, turn, handlers, runtimeDir }
}

describe("claude-code component", () => {
  test("#given a standalone runtime #when an anthropic-subscription turn starts #then the pinned executable is acquired before the turn and handed to the engine", async () => {
    const h = await harness({ pin: true })
    await h.turn("anthropic-subscription")
    expect(h.env.CLAUDE_CODE_EXECUTABLE).toBe(join(h.runtimeDir, "claude-code", "@anthropic-ai+claude-agent-sdk-darwin-arm64", "0.3.284", "claude"))
    expect(h.requests).toHaveLength(1)
    expect(h.notices).toHaveLength(1)
    await h.turn("anthropic-subscription")
    expect(h.requests).toHaveLength(1)
  })

  test("#given a turn on another provider #when it starts #then nothing is downloaded", async () => {
    const h = await harness({ pin: true })
    await h.turn("openai")
    expect(h.requests).toEqual([])
    expect(h.env.CLAUDE_CODE_EXECUTABLE).toBeUndefined()
  })

  test("#given an npm install without a pin #when registered #then the component stays out of the way", async () => {
    const h = await harness({ pin: false })
    expect(h.handlers.size).toBe(0)
  })

  test("#given claude on PATH or an explicit CLAUDE_CODE_EXECUTABLE #when a Claude turn starts #then the user's executable wins and nothing is downloaded", async () => {
    const onPath = await harness({ pin: true, claudeOnPath: "/usr/local/bin/claude" })
    await onPath.turn("anthropic-subscription")
    expect(onPath.requests).toEqual([])
    const explicit = await harness({ pin: true, env: { CLAUDE_CODE_EXECUTABLE: "/opt/claude" } })
    await explicit.turn("anthropic-subscription")
    expect(explicit.requests).toEqual([])
    expect(explicit.env.CLAUDE_CODE_EXECUTABLE).toBe("/opt/claude")
  })
})
