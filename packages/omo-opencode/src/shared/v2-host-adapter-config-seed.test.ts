import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "bun:test"
import type { Hooks } from "@opencode-ai/plugin"

// The adapter resolves the managed-auth path from HOME at module load. Point
// it at an empty temp dir BEFORE importing the module so the test cannot pick
// up a real OpenChamber managed-auth file from the developer machine.
const originalHome = process.env.HOME
process.env.HOME = mkdtempSync(join(tmpdir(), "omo-v2-seed-home-"))

const { registerV2Hooks } = await import("./v2-host-adapter")

const originalPort = process.env.OPENCODE_PORT
const originalPassword = process.env.OPENCODE_SERVER_PASSWORD
const originalUsername = process.env.OPENCODE_SERVER_USERNAME
const originalFetch = globalThis.fetch

const capturedRequests: Array<{ url: string; authorization: string | undefined }> = []

function restoreEnvironment(): void {
  if (originalPort === undefined) delete process.env.OPENCODE_PORT
  else process.env.OPENCODE_PORT = originalPort
  if (originalPassword === undefined) delete process.env.OPENCODE_SERVER_PASSWORD
  else process.env.OPENCODE_SERVER_PASSWORD = originalPassword
  if (originalUsername === undefined) delete process.env.OPENCODE_SERVER_USERNAME
  else process.env.OPENCODE_SERVER_USERNAME = originalUsername
  globalThis.fetch = originalFetch
  capturedRequests.length = 0
  if (originalHome === undefined) delete process.env.HOME
  else process.env.HOME = originalHome
}

afterEach(restoreEnvironment)

describe("registerV2Hooks config seed auth", () => {
  test("#given no managed auth but an env password #when the config hook boots #then the seed fetch carries the env Basic header", async () => {
    process.env.OPENCODE_PORT = "4599"
    process.env.OPENCODE_SERVER_PASSWORD = "sekret"
    delete process.env.OPENCODE_SERVER_USERNAME
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init)
      capturedRequests.push({
        url: request.url,
        authorization: request.headers.get("authorization") ?? undefined,
      })
      return new Response(JSON.stringify([{ info: { agent: { researcher: {} } } }]), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }) as typeof fetch

    const seenSeeds: unknown[] = []
    const dispose = await registerV2Hooks(
      { config: async (seed) => { seenSeeds.push(seed) } } as unknown as Hooks,
      {},
      { directory: "/tmp", logger: () => {} },
    )
    await dispose()

    expect(capturedRequests).toEqual([{
      url: "http://127.0.0.1:4599/api/config",
      authorization: `Basic ${Buffer.from("opencode:sekret", "utf8").toString("base64")}`,
    }])
    expect(seenSeeds).toHaveLength(1)
    expect(seenSeeds[0]).toMatchObject({ agent: { researcher: {} } })
  })

  test("#given neither managed auth nor an env password #when the config hook boots #then the seed fetch goes out unauthenticated", async () => {
    process.env.OPENCODE_PORT = "4599"
    delete process.env.OPENCODE_SERVER_PASSWORD
    delete process.env.OPENCODE_SERVER_USERNAME
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init)
      capturedRequests.push({
        url: request.url,
        authorization: request.headers.get("authorization") ?? undefined,
      })
      return new Response("[]", { status: 200, headers: { "content-type": "application/json" } })
    }) as typeof fetch

    const dispose = await registerV2Hooks(
      { config: async () => {} } as unknown as Hooks,
      {},
      { directory: "/tmp", logger: () => {} },
    )
    await dispose()

    expect(capturedRequests).toEqual([{ url: "http://127.0.0.1:4599/api/config", authorization: undefined }])
  })
})
