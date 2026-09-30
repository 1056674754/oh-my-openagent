import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

const exe = process.platform === "win32" ? ".exe" : ""
const root = mkdtempSync(join(tmpdir(), "omo-provisioned-handoff-"))
const home = join(root, "home")
const download = join(root, "Downloads", `omo-${process.platform}-${process.arch}${exe}`)
const provisioned = join(home, ".omo", "binary-runtime", "handoff-fixture", `omo${exe}`)

type Run = { code: number; stdout: string; stderr: string }
type Report = { version: string; execPath: string; args: string[]; launch: { provision: boolean; handOff: boolean } }

async function run(command: string[]): Promise<Run> {
  const env: Record<string, string | undefined> = { ...process.env, HOME: home, USERPROFILE: home }
  delete env.OMO_PROVISIONED_HANDOFF
  const child = Bun.spawn(command, { cwd: root, env, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  return { code, stdout, stderr }
}

function report(result: Run): Report {
  const line = result.stdout.trim().split(/\r?\n/).at(-1) ?? ""
  if (!line.startsWith("{")) throw new Error(`fixture printed no report (exit ${result.code}):\n${result.stdout}\n${result.stderr}`)
  return JSON.parse(line) as Report
}

beforeAll(async () => {
  mkdirSync(home, { recursive: true })
  mkdirSync(dirname(download), { recursive: true })
  const built = join(root, "build", `omo${exe}`)
  const entry = join(import.meta.dir, "fixtures", "provisioned-handoff", "entry.ts")
  const build = await run([process.execPath, "build", "--compile", entry, "--outfile", built])
  if (build.code !== 0) throw new Error(`bun build --compile failed:\n${build.stdout}\n${build.stderr}`)
  copyFileSync(built, download)
}, 120_000)

afterAll(() => rmSync(root, { recursive: true, force: true }))

describe("a compiled omo launched from an empty download directory (#7485)", () => {
  test("#given a bare download #when it runs first, again, and from the provisioned runtime #then the engine always resolves package.json beside the provisioned runtime", async () => {
    // when: first launch provisions, then the engine runs
    const first = await run([download, "7", "two words"])
    // then
    const firstBody = report(first)
    expect(firstBody.version).toBe("0.0.0-handoff-fixture")
    expect(realpathSync(dirname(firstBody.execPath))).toBe(realpathSync(dirname(provisioned)))
    expect(firstBody.args).toEqual(["7", "two words"])
    expect(first.code).toBe(7)

    // when: the same download runs against an already provisioned runtime
    const again = await run([download, "3"])
    // then
    expect(report(again).version).toBe("0.0.0-handoff-fixture")
    expect(realpathSync(dirname(report(again).execPath))).toBe(realpathSync(dirname(provisioned)))
    expect(again.code).toBe(3)

    // when: the provisioned executable itself runs
    const direct = await run([provisioned, "0"])
    // then: it runs in place, with nothing to provision or hand off
    expect(report(direct).launch).toEqual(expect.objectContaining({ provision: false, handOff: false }))
    expect(realpathSync(dirname(report(direct).execPath))).toBe(realpathSync(dirname(provisioned)))
    expect(direct.code).toBe(0)
  }, 180_000)
})
