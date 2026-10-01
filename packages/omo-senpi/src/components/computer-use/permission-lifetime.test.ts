import { describe, expect, test } from "bun:test"
import { FakeExtensionAPI, enableFakeExtensionEvents } from "../../../test-support/fake-extension-api"
import { createComputerUseComponent } from "./index"

class SessionApi extends FakeExtensionAPI {
  readonly entries: unknown[]
  readonly sessionContext?: Readonly<Record<string, string>>
  constructor(entries: unknown[] = []) {
    super()
    this.entries = entries
    this.rpc = { emit: (name, data) => { this.rpcEvents.push({ name, data }) } }
    enableFakeExtensionEvents(this)
    createComputerUseComponent({ platform: "freebsd", env: {} }).register(this, {
      logger: { info() {}, warn() {}, error() {} }, config: { getFlag: () => undefined },
    })
  }
  appendEntry(customType: string, data: unknown): void {
    this.entries.push({ type: "custom", customType, data })
  }
  start(id: string) {
    return this.dispatch("session_start", {}, {
      sessionManager: { getSessionId: () => id, getEntries: () => this.entries },
    })
  }
  denial(id: string, event: unknown = { type: "computer.permission_required", permission: "screen_recording" }) {
    this.events?.emit("omo.task.child_extension_event", { parent_session_id: id, root_session_id: id, event })
  }
}

describe("root permission latch lifetime", () => {
  test("retains the same root latch across starts and extension reload, but not a new root", async () => {
    // given
    const first = new SessionApi()
    await first.start("root")
    first.denial("root")
    // when
    await first.start("root")
    first.denial("root")
    await first.dispatch("session_shutdown", { reason: "reload" })
    const reloaded = new SessionApi(first.entries)
    await reloaded.start("root")
    reloaded.denial("root")
    await reloaded.start("new-root")
    reloaded.denial("new-root")
    // then
    expect(first.rpcEvents).toEqual([{
      name: "omo.computer.permission_required", data: { session_id: "root", permission: "screen_recording" },
    }])
    expect(reloaded.rpcEvents).toEqual([{
      name: "omo.computer.permission_required", data: { session_id: "new-root", permission: "screen_recording" },
    }])
  })

  test("ignores another owner's denial and malformed data without consuming the root latch", async () => {
    // given
    const pi = new SessionApi()
    await pi.start("root")
    // when
    pi.denial("other-root")
    pi.denial("root", { type: "computer.permission_required", permission: "camera" })
    pi.denial("root", { type: "computer.permission_required", permission: "screen_recording", app: 1 })
    pi.denial("root")
    // then
    expect(pi.rpcEvents).toEqual([{
      name: "omo.computer.permission_required", data: { session_id: "root", permission: "screen_recording" },
    }])
  })
})
