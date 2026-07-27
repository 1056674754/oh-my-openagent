import { lstatSync, readFileSync, statSync } from "node:fs"
import { dirname, isAbsolute, join, resolve } from "node:path"

export const DEFAULT_CODEGRAPH_MAX_INDEX_DB_BYTES = 2_147_483_648

export type CodegraphAutoInitPolicy = boolean | "safe"
export type CodegraphIndexState = "absent" | "incomplete" | "oversized" | "ready" | "unreadable"

export type CodegraphWorkspaceInspection = {
  readonly indexBytes?: number
  readonly indexPath: string
  readonly indexState: CodegraphIndexState
  readonly ownsGitRoot: boolean
  readonly workspace: string
}

export type InspectCodegraphWorkspaceOptions = {
  readonly maxIndexDbBytes?: number
}

export type CodegraphWorkspaceUseDecision =
  | { readonly allowed: true; readonly reason: "existing-index" | "explicit-auto-init" | "safe-git-root" }
  | {
      readonly allowed: false
      readonly reason: "auto-init-disabled" | "index-oversized" | "index-unreadable" | "safe-root-required"
    }

function hasGitHead(gitDir: string): boolean {
  return statSync(join(gitDir, "HEAD"), { throwIfNoEntry: false })?.isFile() === true
}

function ownsGitRoot(workspace: string): boolean {
  try {
    const markerPath = join(workspace, ".git")
    const marker = lstatSync(markerPath, { throwIfNoEntry: false })
    if (marker === undefined || marker.isSymbolicLink()) return false
    if (marker.isDirectory()) return hasGitHead(markerPath)
    if (!marker.isFile()) return false

    const match = /^gitdir:\s*(.+)\s*$/i.exec(readFileSync(markerPath, "utf8").trim())
    const target = match?.[1]
    if (target === undefined) return false
    return hasGitHead(isAbsolute(target) ? target : resolve(dirname(markerPath), target))
  } catch (error) {
    if (error instanceof Error) return false
    throw error
  }
}

export function inspectCodegraphWorkspace(
  workspace: string,
  options: InspectCodegraphWorkspaceOptions = {},
): CodegraphWorkspaceInspection {
  const resolvedWorkspace = resolve(workspace)
  const projectLink = join(resolvedWorkspace, ".codegraph")
  const indexPath = join(projectLink, "codegraph.db")
  const base = { indexPath, ownsGitRoot: ownsGitRoot(resolvedWorkspace), workspace: resolvedWorkspace }

  try {
    const projectEntry = lstatSync(projectLink, { throwIfNoEntry: false })
    if (projectEntry === undefined) return { ...base, indexState: "absent" }

    const index = statSync(indexPath, { throwIfNoEntry: false })
    if (index === undefined || !index.isFile()) return { ...base, indexState: "incomplete" }

    const maxIndexDbBytes = options.maxIndexDbBytes ?? DEFAULT_CODEGRAPH_MAX_INDEX_DB_BYTES
    if (index.size > maxIndexDbBytes) return { ...base, indexBytes: index.size, indexState: "oversized" }
    return { ...base, indexBytes: index.size, indexState: "ready" }
  } catch (error) {
    if (error instanceof Error) return { ...base, indexState: "unreadable" }
    throw error
  }
}

export function decideCodegraphWorkspaceUse(
  inspection: CodegraphWorkspaceInspection,
  autoInit: CodegraphAutoInitPolicy = "safe",
): CodegraphWorkspaceUseDecision {
  if (inspection.indexState === "oversized") return { allowed: false, reason: "index-oversized" }
  if (inspection.indexState === "unreadable") return { allowed: false, reason: "index-unreadable" }
  if (inspection.indexState === "ready") return { allowed: true, reason: "existing-index" }
  if (autoInit === false) return { allowed: false, reason: "auto-init-disabled" }
  if (autoInit === true) return { allowed: true, reason: "explicit-auto-init" }
  if (inspection.ownsGitRoot) return { allowed: true, reason: "safe-git-root" }
  return { allowed: false, reason: "safe-root-required" }
}
