import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import {
  acquiringEngineChildFactory,
  type ChildFactory,
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
export function defaultEngineChild(env: Env = process.env): (enginePath: string | undefined) => ChildFactory {
  return (enginePath) => {
    if (enginePath !== undefined) return engineChildFactory(enginePath)
    const version = omoReleaseVersion(env)
    return version === undefined ? engineChildFactory() : acquiringEngineChildFactory({ version })
  }
}
