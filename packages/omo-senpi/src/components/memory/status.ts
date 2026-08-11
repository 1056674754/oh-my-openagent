import { GitMemoryRepo } from "@oh-my-opencode/memory-core"

import type { MemoryIdentityContext } from "./context"

export const MEMORY_STATUS_KEY = "memory"
const SHORT_SHA_LENGTH = 7

export interface MemoryStatusUi {
  setStatus(key: string, text: string | undefined): void
  notify(message: string, level: "error" | "warning"): void
}

export interface GitRepoForStatus {
  head(): Promise<string | null>
  lsTree(revision?: string, path?: string): Promise<string[]>
  show(revision: string, path: string): Promise<string>
}

export interface MemoryStatusResult {
  readonly notified: boolean
}

export interface RefreshMemoryStatusInput {
  readonly context: MemoryIdentityContext
  readonly ui: MemoryStatusUi
  readonly compileWarnTokens: number
  readonly alreadyNotified: boolean
  readonly gitRepo?: GitRepoForStatus
}

export async function refreshMemoryStatus(input: RefreshMemoryStatusInput): Promise<MemoryStatusResult> {
  const repo = input.gitRepo ?? createGitRepo(input.context.identityPaths.repo)
  const head = await repo.head()
  const identity = input.context.identity
  const statusText = head !== null
    ? `mem:${identity} @${head.slice(0, SHORT_SHA_LENGTH)}`
    : `mem:${identity} @uncommitted`
  input.ui.setStatus(MEMORY_STATUS_KEY, statusText)

  if (input.alreadyNotified || head === null) return { notified: false }

  const estimate = await estimateSystemTokens(repo, head)
  if (estimate < input.compileWarnTokens) return { notified: false }

  input.ui.notify(
    `system memory ~${estimate} tokens exceeds advisory ${input.compileWarnTokens}; consider /doctor`,
    "warning",
  )
  return { notified: true }
}

async function estimateSystemTokens(repo: GitRepoForStatus, head: string): Promise<number> {
  const paths = await repo.lsTree(head)
  const systemMarkdownPaths = paths.filter(isSystemMarkdown)
  if (systemMarkdownPaths.length === 0) return 0
  const contents = await Promise.all(
    systemMarkdownPaths.map((path) => repo.show(head, path)),
  )
  const totalBytes = contents.reduce((sum, content) => sum + Buffer.byteLength(content, "utf8"), 0)
  return Math.floor(totalBytes / 4)
}

function isSystemMarkdown(path: string): boolean {
  return path.startsWith("system/") && path.endsWith(".md")
}

function createGitRepo(repoPath: string): GitRepoForStatus {
  const repo = new GitMemoryRepo({ dir: repoPath, agentId: "omo-status" })
  return {
    head: () => repo.head(),
    lsTree: (revision, path) => repo.lsTree(revision, path),
    show: (revision, path) => repo.show(revision, path),
  }
}
