import { existsSync, readFileSync, realpathSync, watch, type FSWatcher } from "node:fs"
import { basename, dirname, resolve } from "node:path"
import { OhMyOpenCodeConfigSchema, type OhMyOpenCodeConfig } from "../config"
import type { BackgroundManager } from "../features/background-agent"
import { getOpenCodeConfigDirs, log, parseJsonc } from "../shared"
import { CONFIG_BASENAME, LEGACY_CONFIG_BASENAME } from "../shared/plugin-identity"
import { getPluginConfigWatchPaths, loadPluginConfig } from "./layered-config-loader"
import { applyRuntimePluginConfig } from "./runtime-config"

const OMO_CONFIG_NAMES = new Set([
  `${CONFIG_BASENAME}.json`,
  `${CONFIG_BASENAME}.jsonc`,
  `${LEGACY_CONFIG_BASENAME}.json`,
  `${LEGACY_CONFIG_BASENAME}.jsonc`,
])
const activeReloaders = new Map<string, () => void>()

export class ConfigHotReloadValidationError extends Error {
  readonly configPath: string

  constructor(configPath: string, detail: string) {
    super(`Cannot hot reload ${configPath}: ${detail}`)
    this.name = "ConfigHotReloadValidationError"
    this.configPath = configPath
  }
}

export function validatePluginConfigFiles(paths: readonly string[]): void {
  for (const configPath of paths) {
    if (!existsSync(configPath)) continue
    let rawConfig: unknown
    try {
      rawConfig = parseJsonc<unknown>(readFileSync(configPath, "utf8"))
    } catch (error) {
      if (!(error instanceof Error)) throw error
      throw new ConfigHotReloadValidationError(configPath, error.message)
    }
    const result = OhMyOpenCodeConfigSchema.safeParse(rawConfig)
    if (!result.success) {
      const detail = result.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join(", ")
      throw new ConfigHotReloadValidationError(configPath, detail)
    }
  }
}

function discoverWatchDirectories(directory: string): string[] {
  const result = new Set(getOpenCodeConfigDirs({ binary: "opencode" }).map((configDir) => resolve(configDir)))
  for (const configPath of getPluginConfigWatchPaths(directory)) {
    result.add(dirname(configPath))
  }

  return Array.from(result).filter(existsSync)
}

export type ConfigHotReloader = {
  dispose: () => void
}

export function createConfigHotReloader(args: {
  directory: string
  ctx: unknown
  pluginConfig: OhMyOpenCodeConfig
  backgroundManager: Pick<BackgroundManager, "updateConfig">
}): ConfigHotReloader {
  const registryKey = realpathSync.native(args.directory)
  activeReloaders.get(registryKey)?.()
  const watchers: FSWatcher[] = []
  let omoTimer: ReturnType<typeof setTimeout> | undefined
  let disposed = false

  const dispose = (): void => {
    if (disposed) return
    disposed = true
    if (omoTimer) clearTimeout(omoTimer)
    for (const watcher of watchers) watcher.close()
    watchers.length = 0
    if (activeReloaders.get(registryKey) === dispose) {
      activeReloaders.delete(registryKey)
    }
  }

  const reportFailure = (scope: string, error: unknown): void => {
    if (!(error instanceof Error)) throw error
    log(`[config-hot-reload] ${scope} failed`, { error: error.message })
  }

  const reloadOmoConfig = async (): Promise<void> => {
    if (disposed) return
    const configPaths = getPluginConfigWatchPaths(args.directory)
    validatePluginConfigFiles(configPaths)
    const next = loadPluginConfig(args.directory, args.ctx)
    applyRuntimePluginConfig({
      current: args.pluginConfig,
      next,
      updateBackgroundTaskConfig: (config) => args.backgroundManager.updateConfig(config),
    })
    log("[config-hot-reload] OMO config applied", { paths: configPaths })
    if (args.pluginConfig.hot_reload?.enabled === false) dispose()
  }

  const scheduleOmoReload = (): void => {
    if (omoTimer) clearTimeout(omoTimer)
    const debounce = args.pluginConfig.hot_reload?.debounce_ms ?? 500
    omoTimer = setTimeout(() => {
      void reloadOmoConfig().catch((error: unknown) => reportFailure("OMO config reload", error))
    }, debounce)
  }

  for (const watchDirectory of discoverWatchDirectories(args.directory)) {
    try {
      watchers.push(watch(watchDirectory, (_eventType, filename) => {
        if (disposed || !filename) return
        const changedName = basename(filename.toString())
        const config = args.pluginConfig.hot_reload
        if (config?.watch_omo_config !== false && OMO_CONFIG_NAMES.has(changedName)) {
          scheduleOmoReload()
        }
      }))
    } catch (error) {
      reportFailure(`watch ${watchDirectory}`, error)
    }
  }

  log("[config-hot-reload] watching configuration", {
    directories: discoverWatchDirectories(args.directory),
  })
  activeReloaders.set(registryKey, dispose)
  return { dispose }
}
