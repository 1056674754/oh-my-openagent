import { describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { Readable, Writable } from "node:stream"
import { fileURLToPath } from "node:url"

import { executeCodegraphSessionStartHook, runCodegraphSessionStartWorker } from "../src/hook.ts"
import { runCodegraphServe } from "../src/serve.ts"

const componentRoot = resolve(fileURLToPath(new URL("..", import.meta.url)))

function createWorkspace(name: string, gitRoot = false): string {
	const workspace = mkdtempSync(join(componentRoot, `.tmp-${name}-`))
	if (gitRoot) {
		mkdirSync(join(workspace, ".git"), { recursive: true })
		writeFileSync(join(workspace, ".git", "HEAD"), "ref: refs/heads/main\n")
	}
	return workspace
}

function createUnavailableStdio() {
	const stderr: string[] = []
	return {
		stderr,
		options: {
			stderr: { write: (chunk: string) => stderr.push(chunk) },
			stdin: Readable.from([]),
			stdout: new Writable({ write: (_chunk, _encoding, callback) => callback() }),
		},
	}
}

describe("CodeGraph Codex workspace safety", () => {
	it("#given a non-Git collection root with no index #when MCP starts in safe mode #then it serves the unavailable facade without resolving CodeGraph", async () => {
		const workspace = createWorkspace("codegraph-safe-collection")
		const stdio = createUnavailableStdio()

		try {
			const exitCode = await runCodegraphServe({
				config: { codegraph: { auto_init: "safe", enabled: true }, sources: [], warnings: [] },
				cwd: workspace,
				env: { HOME: "/tmp/home" },
				resolve: () => {
					throw new Error("unsafe workspaces must be rejected before binary resolution")
				},
				...stdio.options,
			})

			expect(exitCode).toBe(0)
			expect(stdio.stderr.join("")).toContain("workspace blocked by safety policy")
		} finally {
			rmSync(workspace, { recursive: true, force: true })
		}
	})

	it("#given an oversized existing index #when MCP starts #then it does not spawn CodeGraph", async () => {
		const workspace = createWorkspace("codegraph-oversized", true)
		const stdio = createUnavailableStdio()
		mkdirSync(join(workspace, ".codegraph"), { recursive: true })
		writeFileSync(join(workspace, ".codegraph", "codegraph.db"), "too large")

		try {
			const exitCode = await runCodegraphServe({
				config: { codegraph: { enabled: true, max_index_db_bytes: 1 }, sources: [], warnings: [] },
				cwd: workspace,
				env: { HOME: "/tmp/home" },
				runProcess: () => {
					throw new Error("oversized indexes must not spawn CodeGraph")
				},
				...stdio.options,
			})

			expect(exitCode).toBe(0)
			expect(stdio.stderr.join("")).toContain("index-oversized")
		} finally {
			rmSync(workspace, { recursive: true, force: true })
		}
	})

	it("#given a non-Git collection root #when SessionStart fires #then it skips status probing and worker creation", async () => {
		const workspace = createWorkspace("codegraph-hook-safe-collection")
		const spawned: unknown[] = []

		try {
			const result = await executeCodegraphSessionStartHook({
				config: { codegraph: { auto_init: "safe", enabled: true }, sources: [], warnings: [] },
				cwd: workspace,
				env: { HOME: "/tmp/home" },
				spawnWorker: (invocation) => spawned.push(invocation),
				statusProbe: () => {
					throw new Error("unsafe workspaces must not probe CodeGraph status")
				},
				stdin: Readable.from(["{}"]),
				sweepZombies: () => undefined,
			})

			expect(result).toEqual({ action: "skipped-safety", exitCode: 0 })
			expect(spawned).toEqual([])
		} finally {
			rmSync(workspace, { recursive: true, force: true })
		}
	})

	it("#given an oversized index reaches the detached worker #when bootstrap starts #then it exits before provisioning or workspace mutation", async () => {
		const workspace = createWorkspace("codegraph-worker-oversized", true)
		const outcomes: unknown[] = []
		mkdirSync(join(workspace, ".codegraph"), { recursive: true })
		writeFileSync(join(workspace, ".codegraph", "codegraph.db"), "too large")

		try {
			const result = await runCodegraphSessionStartWorker({
				config: { codegraph: { enabled: true, max_index_db_bytes: 1 }, sources: [], warnings: [] },
				cwd: workspace,
				env: { HOME: "/tmp/home" },
				logOutcome: (outcome) => outcomes.push(outcome),
				deps: {
					resolveCommand: () => {
						throw new Error("oversized indexes must be rejected before binary resolution")
					},
				},
			})

			expect(result).toEqual({ action: "skipped-safety" })
			expect(outcomes).toEqual([{ action: "skipped-safety", error: "index-oversized", projectRoot: workspace }])
		} finally {
			rmSync(workspace, { recursive: true, force: true })
		}
	})

	it("#given a safe worker bootstrap with debounce configured #when status and init run #then preflight is short and the action keeps its full timeout", async () => {
		const workspace = createWorkspace("codegraph-worker-timeouts")
		const calls: Array<{ readonly env: Record<string, string>; readonly timeoutMs: number }> = []

		try {
			const result = await runCodegraphSessionStartWorker({
				config: {
					codegraph: { auto_init: true, enabled: true, watch_debounce_ms: 750 },
					sources: [],
					warnings: [],
				},
				cwd: workspace,
				env: { HOME: "/tmp/home" },
				logOutcome: () => undefined,
				deps: {
					ensureGitignored: () => true,
					prepareWorkspace: () => ({
						dataDir: join(workspace, ".codegraph"),
						dataRoot: join(workspace, ".codegraph"),
						linked: false,
						mode: "in-project",
						projectLink: join(workspace, ".codegraph"),
					}),
					resolveCommand: () => ({ argsPrefix: [], command: "/tmp/codegraph", exists: true, source: "path" }),
					runCommand: (_projectRoot, _command, _args, options) => {
						calls.push(options)
						return Promise.resolve({
							exitCode: 0,
							stdout: calls.length === 1 ? '{"initialized":false}' : "",
							timedOut: false,
						})
					},
				},
			})

			expect(result).toEqual({ action: "initialized" })
			expect(calls.map((call) => call.timeoutMs)).toEqual([5_000, 60_000])
			expect(calls[0]?.env["CODEGRAPH_WATCH_DEBOUNCE_MS"]).toBe("750")
		} finally {
			rmSync(workspace, { recursive: true, force: true })
		}
	})
})
