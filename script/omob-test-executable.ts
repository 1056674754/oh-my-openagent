import { spawnSync } from "node:child_process"
import { rmSync, writeFileSync } from "node:fs"
import { TEARDOWN_FAILURE_PREFIX } from "../packages/omo-native/test/teardown.test-support"

/** A real native executable: Windows does not execute POSIX shebang fixtures. */
export function writeTestExecutable(destination: string, source: string): void {
	const entry = `${destination}.fixture.cjs`
	writeFileSync(entry, source)
	try {
		const result = spawnSync(process.execPath, ["build", "--compile", entry, "--outfile", destination], { encoding: "utf8", timeout: 30_000 })
		if (result.error) throw result.error
		if (result.status !== 0) throw new Error(`fixture compilation failed: ${result.stdout}${result.stderr}`)
	} finally {
		rmSync(entry, { force: true })
	}
}

/**
 * Remove a test's own temp root. On win32 only, EBUSY is reported as a warning and the directory is
 * left for the OS to reclaim, which is the policy `teardownRoots` in
 * packages/omo-native/test/teardown.test-support.ts already applies to the same class of residue.
 * The holder there is not ours. It happened once in 300 CI runs (#9035) and in none of 147 targeted
 * repros. Nothing in this repo enumerates %TEMP%, both children this test started (`bun build
 * --compile`, the fixture's `--version`) had exited, and deleting the fixture executable had already
 * succeeded. That leaves an OS scanner holding the directory of a just-written, just-deleted PE, and
 * no user-space signal can be awaited for it. No retry loop: any other errno, and every error on
 * POSIX, still throws on the first attempt.
 */
export function removeTestTempRoot(root: string, remove: (path: string) => void = (path) => rmSync(path, { recursive: true, force: true }), platform: NodeJS.Platform = process.platform): void {
	try {
		remove(root)
	} catch (error) {
		const code = error !== null && typeof error === "object" && "code" in error ? error.code : undefined
		if (platform !== "win32" || code !== "EBUSY") throw error
		console.warn(`${TEARDOWN_FAILURE_PREFIX} leaving ${root} for the OS to reclaim (win32 EBUSY)`)
	}
}
