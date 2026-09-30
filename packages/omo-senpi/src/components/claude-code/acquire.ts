import { createHash, randomUUID } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"

export type ClaudeCodePin = {
  readonly name: string
  readonly version: string
  readonly integrity: string
  readonly claudeCodeVersion?: string
}

export type ClaudeCodeAcquired = { readonly path: string; readonly downloaded: boolean } | { readonly path: null; readonly error: string }

const REGISTRY = "https://registry.npmjs.org"
const DOWNLOAD_TIMEOUT_MS = 300_000

export function executableName(platform: NodeJS.Platform): string {
  return platform === "win32" ? "claude.exe" : "claude"
}

export function tarballUrl(pin: ClaudeCodePin, registry = REGISTRY): string {
  const bare = pin.name.slice(pin.name.indexOf("/") + 1)
  return `${registry}/${pin.name}/-/${bare}-${pin.version}.tgz`
}

export function cachedExecutablePath(cacheRoot: string, pin: ClaudeCodePin, platform: NodeJS.Platform): string {
  return join(cacheRoot, pin.name.replace("/", "+"), pin.version, executableName(platform))
}

function matchesIntegrity(bytes: Uint8Array, integrity: string): boolean {
  const [algorithm, expected] = integrity.split("-", 2)
  if (algorithm !== "sha512" || expected === undefined) return false
  return createHash("sha512").update(bytes).digest("base64") === expected
}

export function offlineMessage(pin: ClaudeCodePin, cause: string): string {
  return `Claude Code ${pin.claudeCodeVersion ?? pin.version} could not be downloaded (${cause}). Connect to the internet once so omo can fetch it, install Claude Code so \`claude\` is on PATH, or set CLAUDE_CODE_EXECUTABLE to the binary.`
}

export async function acquireClaudeCode(options: {
  readonly pin: ClaudeCodePin
  readonly cacheRoot: string
  readonly platform?: NodeJS.Platform
  readonly fetch?: typeof globalThis.fetch
  readonly registry?: string
  readonly onDownloadStart?: (message: string) => void
}): Promise<ClaudeCodeAcquired> {
  const platform = options.platform ?? process.platform
  const target = cachedExecutablePath(options.cacheRoot, options.pin, platform)
  if (existsSync(target) && statSync(target).size > 0) return { path: target, downloaded: false }
  options.onDownloadStart?.(`Downloading Claude Code ${options.pin.claudeCodeVersion ?? options.pin.version} (${options.pin.name}), needed once for the anthropic-subscription lane...`)
  let bytes: Uint8Array
  try {
    const response = await (options.fetch ?? globalThis.fetch)(tarballUrl(options.pin, options.registry), { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
    if (!response.ok) return { path: null, error: offlineMessage(options.pin, `HTTP ${response.status}`) }
    bytes = new Uint8Array(await response.arrayBuffer())
  } catch (error) {
    return { path: null, error: offlineMessage(options.pin, error instanceof Error ? error.message : String(error)) }
  }
  if (!matchesIntegrity(bytes, options.pin.integrity)) {
    return { path: null, error: `Claude Code package ${options.pin.name}@${options.pin.version} failed its integrity check; nothing was installed.` }
  }
  const entryName = `package/${executableName(platform)}`
  const files = await new Bun.Archive(bytes).files(entryName)
  const entry = files.get(entryName)
  if (entry === undefined) return { path: null, error: `Claude Code package ${options.pin.name}@${options.pin.version} has no ${executableName(platform)}.` }
  const directory = join(target, "..")
  mkdirSync(directory, { recursive: true })
  const staged = join(directory, `.${executableName(platform)}.${randomUUID()}`)
  try {
    writeFileSync(staged, new Uint8Array(await entry.arrayBuffer()))
    chmodSync(staged, 0o755)
    renameSync(staged, target)
  } finally {
    rmSync(staged, { force: true })
  }
  return { path: target, downloaded: true }
}
