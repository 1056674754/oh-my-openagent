import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ConfigHotReloadValidationError, validatePluginConfigFiles } from "./config-hot-reloader"

const tempDirectories: string[] = []

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true })
  }
})

describe("validatePluginConfigFiles", () => {
  test("accepts valid JSONC before a runtime reload", () => {
    const directory = mkdtempSync(join(tmpdir(), "omo-hot-reload-"))
    tempDirectories.push(directory)
    const configPath = join(directory, "oh-my-openagent.jsonc")
    writeFileSync(configPath, '{ // live config\n "background_task": { "defaultConcurrency": 2 }\n}')

    expect(() => validatePluginConfigFiles([configPath])).not.toThrow()
  })

  test("rejects an invalid full file instead of partially replacing live config", () => {
    const directory = mkdtempSync(join(tmpdir(), "omo-hot-reload-"))
    tempDirectories.push(directory)
    const configPath = join(directory, "oh-my-openagent.jsonc")
    writeFileSync(configPath, '{ "background_task": { "defaultConcurrency": "many" } }')

    expect(() => validatePluginConfigFiles([configPath])).toThrow(ConfigHotReloadValidationError)
  })
})
