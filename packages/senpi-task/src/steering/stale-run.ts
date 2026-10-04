import { fenceRun, type TaskRecord } from "../state"
import type { CancelOutcome, SendOutcome } from "./types"

export const STALE_RUN_REASON = "the handle names an earlier run of this task"

export function runMoved(record: TaskRecord, expectedRunEpoch: number | undefined): boolean {
  return expectedRunEpoch !== undefined && fenceRun(record, expectedRunEpoch) !== "live"
}

export function staleSend(record: TaskRecord): SendOutcome {
  return {
    kind: "not_continuable",
    task_id: record.task_id,
    reason: `Task ${record.task_id}: ${STALE_RUN_REASON}.`,
    suggestion: "Fetch the task's current handle before sending.",
  }
}

export function staleCancel(record: TaskRecord): CancelOutcome {
  return { kind: "noop", task_id: record.task_id, status: record.status, reason: `Task ${record.task_id}: ${STALE_RUN_REASON}.` }
}
