import { accessSync, constants, existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { homedir } from "node:os"
import {
  desktopEngineReleaseAssetName,
  findCachedDesktopEngine,
  getDesktopEngineCandidatePaths,
  getDesktopEngineHost,
  isQuarantinedFile,
  locateDesktopEngine,
  type DesktopEngineLocateDiagnostic,
  type DesktopEngineLocatorOptions,
} from "@oh-my-opencode/senpi-desktop-engine"
import {
  acquiringEngineChildFactory,
  type ChildFactory,
  DesktopEngineUnavailableError,
  engineChildFactory,
} from "@oh-my-opencode/senpi-desktop-service"

type Env = Readonly<Record<string, string | undefined>>

function manifestVersion(packageDir: string, names: readonly string[]): string | undefined {
  let manifest: unknown
  try {
    manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"))
  } catch {
    return undefined
  }
  if (typeof manifest !== "object" || manifest === null) return undefined
  const name = Reflect.get(manifest, "name")
  const version = Reflect.get(manifest, "version")
  return typeof name === "string" && names.includes(name) && typeof version === "string" && version.length > 0
    ? version
    : undefined
}

/**
 * The omo release this session runs, which names the GitHub release that carries the engine binary:
 * the compiled runtime's stamped manifest (`OMO_PACKAGE_DIR`), else the `omo-ai` package the npm
 * launcher runs from (`OMO_BIN` is its `bin/omo.js`). Undefined outside an omo launch.
 */
export function omoReleaseVersion(env: Env): string | undefined {
  const packageDir = env.OMO_PACKAGE_DIR?.trim()
  if (packageDir) {
    const stamped = manifestVersion(packageDir, ["omo"])
    if (stamped !== undefined) return stamped
  }
  const bin = env.OMO_BIN?.trim()
  return bin ? manifestVersion(dirname(dirname(bin)), ["omo-ai"]) : undefined
}

/**
 * `computer.engine_path` wins; an omo launch acquires the engine for its own release (local install
 * first, then the verified GitHub release download); anything else uses the synchronous locator.
 */
export function defaultEngineChild(env: Env = process.env, locatorOptions?: DesktopEngineLocatorOptions): (enginePath: string | undefined) => ChildFactory {
  return (enginePath) => {
    if (enginePath !== undefined) return explicitEngineChild(enginePath)
    const version = omoReleaseVersion(env)
    if (version !== undefined) return acquiringEngineChildFactory({ version })
    if (locatorOptions === undefined) return engineChildFactory()
    return () => {
      const located = locateDesktopEngine(locatorOptions)
      if (located.path === null) throw new DesktopEngineUnavailableError(located.diagnostic)
      return engineChildFactory(located.path)()
    }
  }
}

/** Describes installation state only; neither acquisition nor an engine process is started. */
export function describeEngineSource(
  enginePath: string | undefined,
  env: Env,
  locatorOptions: DesktopEngineLocatorOptions = {},
): string {
  if (enginePath !== undefined) return `found ${enginePath} (explicit)`
  const options = { ...locatorOptions, runtimeDir: locatorOptions.runtimeDir ?? env.OMO_PACKAGE_DIR ?? "" }
  const located = locateDesktopEngine(options)
  if (located.path !== null) {
    const candidates = getDesktopEngineCandidatePaths(options)
    const sources = options.runtimeDir ? ["runtime-dir", "sidecar", "package-prebuild", "dev-build"] : ["sidecar", "package-prebuild", "dev-build"]
    return `found ${located.path} (${sources[candidates.indexOf(located.path)]})`
  }
  const { host, reason, cause, code } = located.diagnostic
  if (reason === "no-release-asset") return `No senpi-desktop-engine is built for ${host}`
  const version = omoReleaseVersion(env)
  if (version !== undefined && code !== "quarantined") {
    const cached = findCachedDesktopEngine({
      host, version, cacheDir: join(env.HOME ?? homedir(), ".omo", "cache", "senpi-desktop-engine"),
    })
    if (cached.path !== null) return `found ${cached.path} (cache, omo v${version})`
    const asset = desktopEngineReleaseAssetName(host)
    if (asset !== null) return `would download ${asset} from omo v${version} on first use`
  }
  return `native-unavailable for ${host}: ${cause}`
}

function explicitEngineChild(enginePath: string): ChildFactory {
  const host = getDesktopEngineHost()
  const diagnostic = explicitPathDiagnostic(enginePath, host)
  if (diagnostic !== undefined) {
    return () => {
      throw new DesktopEngineUnavailableError(diagnostic)
    }
  }
  return engineChildFactory(enginePath)
}

function explicitPathDiagnostic(
  enginePath: string,
  host: string,
): DesktopEngineLocateDiagnostic | undefined {
  if (!existsSync(enginePath)) {
    return {
      code: "native-unavailable",
      host,
      attemptedPaths: [enginePath],
      message: `No senpi-desktop-engine binary is available for ${host}.`,
      cause: `${enginePath}: missing`,
    }
  }
  if (isQuarantinedFile(enginePath)) {
    return {
      code: "quarantined",
      host,
      attemptedPaths: [enginePath],
      message: `The senpi-desktop-engine binary for ${host} is quarantined by macOS Gatekeeper.`,
      cause: `${enginePath}: blocked because com.apple.quarantine is present`,
    }
  }
  try {
    accessSync(enginePath, constants.X_OK)
    return undefined
  } catch {
    return {
      code: "native-unavailable",
      host,
      attemptedPaths: [enginePath],
      message: `No senpi-desktop-engine binary is available for ${host}.`,
      cause: `${enginePath}: not executable (chmod +x)`,
    }
  }
}
