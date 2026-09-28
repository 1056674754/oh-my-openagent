import type { CapturedUi } from "./runtime-context"

export const SOCKET_A = "/tmp/dh-t10/rpc/shards/p-aaaaaaaaaaaaaaaa.sock"

type Notified = { readonly text: string; readonly type: string | undefined }

export function uiRecorder(): { readonly ui: CapturedUi; readonly notified: Notified[] } {
  const notified: Notified[] = []
  const ui: CapturedUi = {
    notify: (text, type) => notified.push({ text, type }),
    setStatus: () => undefined,
    setWidget: () => undefined,
    select: () => Promise.resolve(undefined),
    confirm: () => Promise.resolve(false),
  }
  return { ui, notified }
}

export function linesWith(lines: readonly string[], token: string): readonly string[] {
  return lines.filter((line) => line.startsWith(`${token}:`))
}

/** The warning's child count: the last integer on the line. */
export function reattachingCount(line: string): number {
  return Number(line.match(/\d+/g)?.at(-1))
}

/** The done line's counts after its token, in order: reattached, continued, lost[, cancelled]. */
export function doneCounts(line: string): readonly number[] {
  return (line.slice(line.indexOf(" ")).match(/\d+/g) ?? []).map(Number)
}
