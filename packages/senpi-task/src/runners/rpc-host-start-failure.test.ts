import { describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { RunnerError } from "./in-process/runner-error"
import { RpcHostRunner } from "./rpc-host"
import { childSpec } from "./rpc-host.test-support"

describe("RpcHostRunner host failure classification", () => {
  test("#given the daemon transport is unreachable #when a child starts #then the runner raises host_unavailable with a closed reason", async () => {
    // given
    const transportError = Object.assign(
      new Error("connect ECONNREFUSED /private/socket"),
      { code: "ECONNREFUSED" },
    )
    const runner = new RpcHostRunner({
      policy: "upgrade",
      agentDir: "/tmp/agent",
      modelAdmission: async () => {},
      ensureDaemon: () => Promise.reject(transportError),
    })

    // when
    const failure = await runner.start(childSpec()).catch((error: unknown) => error)

    // then
    expect(RunnerError.is(failure) ? failure.failure : undefined).toMatchObject({
      kind: "host_unavailable",
      reason: "host_unreachable",
    })
  })

  test("#given a local session-directory error #when a child starts #then it is not misreported as an unreachable host", async () => {
    // given
    const runner = new RpcHostRunner({
      policy: "upgrade",
      agentDir: "/tmp/agent",
      modelAdmission: async () => {},
      ensureDaemon: () => Promise.resolve({
        action: "reuse",
        reason: "compatible",
        socket: "/tmp/host.sock",
        pid: 1,
        reused: true,
        upgradeable: true,
      }),
    })

    // when
    const failure = await runner.start({
      ...childSpec(),
      state_dir: "/dev/null",
    }).catch((error: unknown) => error)

    // then
    expect(RunnerError.is(failure) ? failure.failure : undefined).toMatchObject({
      kind: "host_unavailable",
    })
    expect(RunnerError.is(failure) ? failure.failure.reason : undefined).toBeUndefined()
  })

  test("#given a cached daemon endpoint that no longer answers #when the real client probes it #then the host is unreachable, not protocol-incompatible", async () => {
    // given
    const socket = join(tmpdir(), `omo-8960-absent-${randomUUID()}.sock`)
    const runner = new RpcHostRunner({
      policy: "upgrade",
      agentDir: "/tmp/agent",
      modelAdmission: async () => {},
      ensureDaemon: () => Promise.resolve({
        action: "reuse",
        reason: "compatible",
        socket,
        pid: 1,
        reused: true,
        upgradeable: true,
      }),
    })

    // when
    const failure = await runner.start({
      ...childSpec(),
      resumeSessionPath: join(tmpdir(), `omo-8960-existing-${randomUUID()}.jsonl`),
    }).catch((error: unknown) => error)

    // then
    expect(RunnerError.is(failure) ? failure.failure : undefined).toMatchObject({
      kind: "host_unavailable",
      reason: "host_unreachable",
    })
  })
})
