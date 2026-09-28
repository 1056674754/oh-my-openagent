import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { HOST_WARMUP_CONTEXT } from "./session-role"
import { HostSessionClient, type HostSessionClientPorts } from "./session-client"

/**
 * One throwaway child-shaped session on a freshly started task host, opened and closed at once.
 *
 * A host pays for its FIRST session: the extension graph is compiled and every lazily imported
 * runtime (the task engine among them) loads then, which made a pre-warmed shard's first child
 * ~0.8 s slower to open than the second one. Opening a session ahead of the first child moves that
 * cost off the child's path. The session carries the `child` role, so it loads exactly what a child
 * loads; a private temp `state_dir` and session file keep it away from every real task store, and
 * `host_warmup` lets extensions that report sessions (telemetry) leave it out. Nothing survives it:
 * the session is closed, never retained, and its temp directory is removed.
 */

export interface WarmHostSessionInput {
  readonly socket: string
  readonly cwd: string
  readonly ports?: HostSessionClientPorts
  /** Where the throwaway state directory is created; the OS temp dir by default. */
  readonly tempRoot?: string
}

export const HOST_WARMUP_TASK_ID = "host-warmup"

export async function warmHostSession(input: WarmHostSessionInput): Promise<void> {
  const stateDir = await mkdtemp(join(input.tempRoot ?? tmpdir(), "omo-host-warmup-"))
  const client = new HostSessionClient({ socketPath: input.socket, ...(input.ports === undefined ? {} : { ports: input.ports }) })
  try {
    await client.open({
      sessionPath: join(stateDir, "warmup.jsonl"),
      cwd: input.cwd,
      kind: "worker",
      context: { role: "child", task_id: HOST_WARMUP_TASK_ID, state_dir: stateDir, [HOST_WARMUP_CONTEXT]: "1" },
      retainOnDisconnect: false,
      autoTitle: false,
    })
    await client.close()
  } finally {
    // A failed open or close leaves no connection behind: the session is not retained, so the host
    // closes it once this connection drops.
    await client.detach().catch(() => undefined)
    await rm(stateDir, { recursive: true, force: true })
  }
}
