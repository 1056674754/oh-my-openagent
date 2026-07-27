import { describe, expect, it } from "bun:test"

import { decideCodegraphWorkspaceUse, type CodegraphWorkspaceInspection } from "./codegraph/workspace-policy"

function inspection(
  indexState: CodegraphWorkspaceInspection["indexState"],
  ownsGitRoot: boolean,
): CodegraphWorkspaceInspection {
  return {
    indexPath: "/workspace/.codegraph/codegraph.db",
    indexState,
    ownsGitRoot,
    workspace: "/workspace",
  }
}

describe("CodeGraph workspace use policy", () => {
  it("#given a non-Git directory without an index #when safe policy is evaluated #then launch is blocked", () => {
    // given
    const workspace = inspection("absent", false)

    // when
    const decision = decideCodegraphWorkspaceUse(workspace, "safe")

    // then
    expect(decision).toEqual({ allowed: false, reason: "safe-root-required" })
  })

  it("#given an owned Git root without an index #when safe policy is evaluated #then launch is allowed", () => {
    // given
    const workspace = inspection("absent", true)

    // when
    const decision = decideCodegraphWorkspaceUse(workspace, "safe")

    // then
    expect(decision).toEqual({ allowed: true, reason: "safe-git-root" })
  })

  it("#given a ready existing index #when auto-init is disabled #then launch remains allowed", () => {
    // given
    const workspace = inspection("ready", false)

    // when
    const decision = decideCodegraphWorkspaceUse(workspace, false)

    // then
    expect(decision).toEqual({ allowed: true, reason: "existing-index" })
  })

  it("#given an oversized index #when explicit auto-init is enabled #then launch is still blocked", () => {
    // given
    const workspace = inspection("oversized", true)

    // when
    const decision = decideCodegraphWorkspaceUse(workspace, true)

    // then
    expect(decision).toEqual({ allowed: false, reason: "index-oversized" })
  })
})
