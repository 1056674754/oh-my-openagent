/// <reference types="bun-types" />

import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { prepareCodegraphWorkspace } from "@oh-my-opencode/utils"

import { clearCodegraphBootstrapProjectsForTesting, createCodegraphBootstrapHook } from "./index"

async function waitForBackground(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

afterEach(() => {
  clearCodegraphBootstrapProjectsForTesting()
})

describe("CodeGraph bootstrap workspace mutation guards", () => {
  test("#given a PATH CodeGraph binary but the host Node is unsupported #when background work runs #then it leaves the project untouched", async () => {
    // given
    const workspace = mkdtempSync(join(tmpdir(), "omo-codegraph-opencode-unsupported-node-"))
    const homeDir = mkdtempSync(join(tmpdir(), "omo-codegraph-opencode-unsupported-node-home-"))
    const events: string[] = []
    const hook = createCodegraphBootstrapHook(
      { directory: workspace },
      { auto_init: true, auto_provision: false, enabled: true },
      {
        log: (message) => {
          events.push(`log:${message}`)
        },
        nodeSupport: () => ({ major: 26, override: false, reason: "too-new", supported: false }),
        prepareWorkspace: (projectRoot) => prepareCodegraphWorkspace(projectRoot, { homeDir }),
        resolveCommand: () => ({ argsPrefix: [], command: "/usr/local/bin/codegraph", exists: true, source: "path" }),
        runCommand: async () => {
          throw new Error("codegraph command should not run")
        },
        schedule: (task) => {
          void task()
        },
      },
    )

    try {
      // when
      hook.event({ event: { type: "session.created", properties: { worktree: workspace } } })
      await waitForBackground()

      // then
      expect(events).toContain("log:[codegraph-bootstrap] CodeGraph unsupported on this Node runtime; skipping bootstrap")
      expect(existsSync(join(workspace, ".codegraph"))).toBe(false)
      expect(existsSync(join(workspace, ".git", "info", "exclude"))).toBe(false)
    } finally {
      rmSync(workspace, { recursive: true, force: true })
      rmSync(homeDir, { recursive: true, force: true })
    }
  })

  test("#given CodeGraph is missing and auto provision is enabled on unsupported Node #when background work runs #then it does not provision or mutate the project", async () => {
    // given
    const workspace = mkdtempSync(join(tmpdir(), "omo-codegraph-opencode-unsupported-provision-"))
    const homeDir = mkdtempSync(join(tmpdir(), "omo-codegraph-opencode-unsupported-provision-home-"))
    const events: string[] = []
    const hook = createCodegraphBootstrapHook(
      { directory: workspace },
      { auto_init: true, auto_provision: true, enabled: true },
      {
        ensureProvisioned: async () => {
          throw new Error("codegraph provisioning should not run")
        },
        log: (message) => {
          events.push(`log:${message}`)
        },
        nodeSupport: () => ({ major: 26, override: false, reason: "too-new", supported: false }),
        prepareWorkspace: (projectRoot) => prepareCodegraphWorkspace(projectRoot, { homeDir }),
        resolveCommand: () => ({ argsPrefix: [], command: "codegraph", exists: false, source: "path" }),
        runCommand: async () => {
          throw new Error("codegraph command should not run")
        },
        schedule: (task) => {
          void task()
        },
      },
    )

    try {
      // when
      hook.event({ event: { type: "session.created", properties: { worktree: workspace } } })
      await waitForBackground()

      // then
      expect(events).toContain("log:[codegraph-bootstrap] CodeGraph unsupported on this Node runtime; skipping bootstrap")
      expect(existsSync(join(workspace, ".codegraph"))).toBe(false)
      expect(existsSync(join(workspace, ".git", "info", "exclude"))).toBe(false)
    } finally {
      rmSync(workspace, { recursive: true, force: true })
      rmSync(homeDir, { recursive: true, force: true })
    }
  })

  test("#given CodeGraph is unavailable and auto provisioning is disabled #when background work runs #then it leaves the project untouched", async () => {
    // given
    const workspace = mkdtempSync(join(tmpdir(), "omo-codegraph-opencode-unavailable-"))
    const homeDir = mkdtempSync(join(tmpdir(), "omo-codegraph-opencode-unavailable-home-"))
    const events: string[] = []
    const hook = createCodegraphBootstrapHook(
      { directory: workspace },
      { auto_init: true, auto_provision: false, enabled: true },
      {
        log: (message) => {
          events.push(`log:${message}`)
        },
        prepareWorkspace: (projectRoot) => prepareCodegraphWorkspace(projectRoot, { homeDir }),
        resolveCommand: () => ({ argsPrefix: [], command: "missing-codegraph", exists: false, source: "path" }),
        runCommand: async () => {
          throw new Error("codegraph command should not run")
        },
        schedule: (task) => {
          void task()
        },
      },
    )

    try {
      // when
      hook.event({ event: { type: "session.created", properties: { worktree: workspace } } })
      await waitForBackground()

      // then
      expect(events).toContain("log:[codegraph-bootstrap] CodeGraph unavailable; skipping bootstrap")
      expect(existsSync(join(workspace, ".codegraph"))).toBe(false)
      expect(existsSync(join(workspace, ".git", "info", "exclude"))).toBe(false)
    } finally {
      rmSync(workspace, { recursive: true, force: true })
      rmSync(homeDir, { recursive: true, force: true })
    }
  })
})
