import { describe, expect, it } from "bun:test"

import { HARNESS_IDS, SETTING_HARNESS_SUPPORT, validateOmoConfig } from "./omo-config"

describe("validateOmoConfig", () => {
  it("accepts codegraph settings with codex and opencode override blocks", () => {
    // given
    const config = {
      codegraph: {
        auto_init: "safe",
        auto_provision: true,
        enabled: true,
        install_dir: "~/.omo/codegraph",
        max_index_db_bytes: 2_147_483_648,
        excluded_roots: ["/tmp/omo-scratch"],
        telemetry: false,
        watch_debounce_ms: 2_000,
      },
      "[codex]": {
        codegraph: {
          enabled: false,
        },
      },
      "[opencode]": {
        codegraph: {
          watch_debounce_ms: 500,
        },
      },
    }

    // when
    const result = validateOmoConfig(config)

    // then
    expect(result).toEqual({ errors: [], ok: true })
  })

  it("rejects unknown harness override blocks", () => {
    // given
    const config = { "[android]": {} }

    // when
    const result = validateOmoConfig(config)

    // then
    expect(result.ok).toBe(false)
    expect(result.errors).toContain('Unknown harness override block "[android]"')
  })

  it("exposes harness ids and codegraph setting applicability metadata", () => {
    // given
    const harnesses = HARNESS_IDS

    // when
    const enabledSupport = SETTING_HARNESS_SUPPORT["codegraph.enabled"]

    // then
    expect(harnesses).toEqual(["codex", "opencode", "omo"])
    expect(enabledSupport).toEqual(["codex", "opencode", "omo"])
  })

  it("accepts watch debounce under the Codex harness", () => {
    // given
    const config = {
      "[codex]": {
        codegraph: {
          watch_debounce_ms: 250,
        },
      },
    }

    // when
    const result = validateOmoConfig(config)

    // then
    expect(result).toEqual({ errors: [], ok: true })
  })

  it("rejects invalid CodeGraph workspace safety settings", () => {
    // given
    const config = {
      codegraph: {
        auto_init: "always",
        max_index_db_bytes: 0,
      },
    }

    // when
    const result = validateOmoConfig(config)

    // then
    expect(result.ok).toBe(false)
    expect(result.errors).toContain('config.codegraph.auto_init must be "safe" or a boolean')
    expect(result.errors).toContain("config.codegraph.max_index_db_bytes must be a positive safe integer")
  })
})
