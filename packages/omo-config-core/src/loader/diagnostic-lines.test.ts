import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "bun:test"

import { displayOmoConfigPath, loadOmoConfig, MERGED_OMO_CONFIG_PATH, omoConfigDiagnosticLines } from "../index"

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true })
})

describe("omoConfigDiagnosticLines", () => {
  test("#given a user file with one invalid value #when formatting the loader diagnostics #then one home-relative line names the file and the dotted key", () => {
    // given
    const homeDir = mkdtempSync(join(tmpdir(), "omo-config-lines-"))
    roots.push(homeDir)
    mkdirSync(join(homeDir, ".omo"), { recursive: true })
    writeFileSync(join(homeDir, ".omo", "omo.jsonc"), `{ "task": { "host_engine_policy": "sometimes", "default_concurrency": 3 } }`)
    const loaded = loadOmoConfig({ cwd: homeDir, env: { HOME: homeDir }, platform: "linux" })

    // when
    const lines = omoConfigDiagnosticLines(loaded.diagnostics, { homeDir })

    // then
    expect(lines).toEqual(["config: ~/.omo/omo.jsonc: task.host_engine_policy ignored (invalid value)"])
  })

  test("#given unknown keys, a rejected file and a merged-config drop #when formatting #then each gets its own line and notices are skipped", () => {
    // given
    const homeDir = "/home/user"
    const file = "/home/user/.omo/omo.jsonc"

    // when
    const lines = omoConfigDiagnosticLines([
      { kind: "unknown-keys", message: "", path: file, issuePaths: ["retired_key", "task.old"] },
      { kind: "validation", message: "", path: "/work/.omo/omo.jsonc", issuePaths: ["task.default_concurrency"] },
      { kind: "parse", message: "", path: file },
      { kind: "invalid-value", message: "", path: MERGED_OMO_CONFIG_PATH, issuePaths: ["teams.alpha.members"] },
      { kind: "deprecated-keys", message: "", path: file, issuePaths: ["categories.deep"] },
    ], { homeDir })

    // then
    expect(lines).toEqual([
      "config: ~/.omo/omo.jsonc: retired_key ignored (unknown key)",
      "config: ~/.omo/omo.jsonc: task.old ignored (unknown key)",
      "config: /work/.omo/omo.jsonc: not loaded (invalid: task.default_concurrency)",
      "config: ~/.omo/omo.jsonc: not loaded (JSONC parse error)",
      "config: merged config: teams.alpha.members ignored (invalid value)",
    ])
  })

  test("#given paths inside and outside the home directory #when displaying them #then only the ones under home become ~-relative", () => {
    expect(displayOmoConfigPath("/home/user/.omo/omo.jsonc", "/home/user/")).toBe("~/.omo/omo.jsonc")
    expect(displayOmoConfigPath("/home/username/.omo/omo.jsonc", "/home/user")).toBe("/home/username/.omo/omo.jsonc")
    expect(displayOmoConfigPath("C:\\Users\\me\\.omo\\omo.jsonc", "C:\\Users\\me")).toBe("~\\.omo\\omo.jsonc")
  })
})
