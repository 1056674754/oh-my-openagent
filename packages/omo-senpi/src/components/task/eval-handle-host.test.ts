import { describe, expect, test } from "bun:test"
import type { EvalHandleHost } from "@code-yeongyu/senpi"

import type { SenpiExtensionAPI } from "../../extension/types"
import { registerEvalHandleHost, type EvalHandleEngine } from "./eval-handle-host"

function fakePi(provide?: (host: EvalHandleHost) => void): SenpiExtensionAPI {
  return {
    on: () => undefined,
    registerTool: () => undefined,
    registerCommand: () => undefined,
    registerFlag: () => undefined,
    getFlag: () => undefined,
    sendMessage: () => undefined,
    sendUserMessage: () => undefined,
    ...(provide === undefined ? {} : { provideEvalHandleHost: provide }),
  }
}

const unused = (): never => { throw new Error("not reached by registration") }
const engine: EvalHandleEngine = {
  manager: { get: () => undefined, waitFor: unused, cancelTask: unused, sendToTask: unused, workpools: { inspect: unused, cancel: unused, subscribe: () => () => undefined } },
  stateDir: "/state",
  resolveAncestry: () => undefined,
  runtime: { cwd: () => "/project" },
}

describe("eval handle host registration", () => {
  test("a runtime with the capability slot receives a version 1 host for this session's tasks", () => {
    const provided: EvalHandleHost[] = []

    registerEvalHandleHost(fakePi((host) => provided.push(host)), engine)

    expect(provided.map((host) => host.version)).toEqual([1])
  })

  test("a runtime without the slot is left alone, so its eval cells report wait as unavailable", () => {
    expect(() => registerEvalHandleHost(fakePi(), engine)).not.toThrow()
  })
})
