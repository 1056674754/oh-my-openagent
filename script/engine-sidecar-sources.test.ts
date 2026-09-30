import { describe, expect, test } from "bun:test"
import { realpathSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { RELEASE_BINARY_TARGETS, resolveExpectedSidecarRelPaths } from "./build-omo-binary"
import { codemodeRuntimeDependencySources, engineSidecarSources } from "./engine-sidecar-sources"

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDir, "..")
// Node resolves a symlinked package from its real path, so the engine's view starts there.
const installedSenpiRequire = createRequire(
  join(realpathSync(join(repoRoot, "node_modules", "@code-yeongyu", "senpi")), "package.json"),
)

// Independent of the production resolver: the installed engine either resolves the
// package's manifest or Node reports it missing.
function engineResolves(packageName: string): boolean {
  try {
    installedSenpiRequire.resolve(`${packageName}/package.json`)
    return true
  } catch (error) {
    if (error instanceof Error && Reflect.get(error, "code") === "MODULE_NOT_FOUND") return false
    throw error
  }
}

describe("sidecar parity set", () => {
  test("#given the css-tree trio #when the engine sidecars are resolved #then each is embedded exactly when the installed engine resolves it", () => {
    // given - the jsdom-era engine ships all three, a linkedom-era engine (senpi#1666) none
    const trio = ["css-tree", "mdn-data", "source-map-js"]

    const target = RELEASE_BINARY_TARGETS.find((entry) => entry.target === "darwin-arm64")
    if (target === undefined) throw new Error("darwin-arm64 is not a release target")

    // when
    const sources = engineSidecarSources()
    const relPaths = resolveExpectedSidecarRelPaths(target)

    // then
    for (const packageName of trio) {
      const installed = engineResolves(packageName)
      expect(sources.some((source) => source.to === `node_modules/${packageName}`)).toBe(installed)
      expect(relPaths.includes(`node_modules/${packageName}/package.json`)).toBe(installed)
    }
  })

  test("#given codemode's manifest #when runtime dependencies are resolved #then only dependencies absent from the engine host are nested transitively", () => {
    // given
    const codemode = installedSenpiRequire.resolve("@code-yeongyu/senpi-codemode/package.json")

    // when
    const destinations = codemodeRuntimeDependencySources(dirname(codemode))
      .map((source) => source.to)

    // then
    const parser = "node_modules/@code-yeongyu/senpi-codemode/node_modules/@babel/parser"
    const types = `${parser}/node_modules/@babel/types`
    expect(destinations).toContain(parser)
    expect(destinations).toContain(types)
    expect(destinations).toContain(`${types}/node_modules/@babel/helper-string-parser`)
    expect(destinations).toContain(`${types}/node_modules/@babel/helper-validator-identifier`)
    expect(destinations.some((path) => path.includes("@earendil-works/pi-ai"))).toBe(false)
    expect(destinations.some((path) => path.endsWith("/typebox"))).toBe(false)
  })

  test("#given every release target #when its sidecar manifest is resolved #then each OS carries codemode's full external runtime closure", () => {
    // given
    const required = [
      "node_modules/@code-yeongyu/senpi-codemode/node_modules/@babel/parser/lib/index.js",
      "node_modules/@code-yeongyu/senpi-codemode/node_modules/@babel/parser/node_modules/@babel/types/package.json",
      "node_modules/@code-yeongyu/senpi-codemode/node_modules/@babel/parser/node_modules/@babel/types/node_modules/@babel/helper-string-parser/package.json",
      "node_modules/@code-yeongyu/senpi-codemode/node_modules/@babel/parser/node_modules/@babel/types/node_modules/@babel/helper-validator-identifier/package.json",
    ]

    // when
    const manifests = RELEASE_BINARY_TARGETS.map((target) => ({
      os: target.os,
      target: target.target,
      files: new Set(resolveExpectedSidecarRelPaths(target)),
    }))

    // then
    expect(new Set(manifests.map((manifest) => manifest.os))).toEqual(
      new Set(["darwin", "linux", "windows"]),
    )
    for (const manifest of manifests) {
      for (const path of required) {
        expect(manifest.files.has(path), `${manifest.target} is missing ${path}`).toBe(true)
      }
    }
  })
})
