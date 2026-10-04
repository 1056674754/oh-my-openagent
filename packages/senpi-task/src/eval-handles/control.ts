import type { CancelReceipt, HandleCallContext, HandleOutcome, HandleRef, HandleSnapshot, OutputRequest, OutputSnapshot } from "@code-yeongyu/senpi"
import type { CancelOptions, CancelOutcome, SendInput, SendOutcome } from "../steering/types"
import { STALE_RUN_REASON } from "../steering/stale-run"
import { renderTranscript } from "../tools/output/render"
import type { TranscriptReader } from "../tools/output/types"
import { EvalHandleHostError } from "./errors"
import { isPoolSettled, loadOwnedPool, poolOutcome, poolSnapshot, type PoolAccess } from "./pool-refs"
import { assertCurrentRun, isSettled, loadFencedTask, taskOutcome, taskSnapshot, type TaskReader } from "./task-refs"

export type TaskControl = TaskReader & {
  cancelTask(idOrName: string, reason?: string, options?: CancelOptions): Promise<CancelOutcome>
  sendToTask(input: SendInput): Promise<SendOutcome>
}

export type ControlDeps = {
  readonly tasks: TaskControl
  readonly pools: PoolAccess
  readonly stateDir: string
  readonly transcriptReader: TranscriptReader
}

const CANCEL_REASON = "cancelled from an eval handle"
const DEFAULT_TAIL_LINES = 60

export function resultOf(deps: ControlDeps, ref: HandleRef, ctx: HandleCallContext): HandleOutcome {
  if (ref.kind === "workpool") {
    const pool = loadOwnedPool(deps.pools, ref, ctx)
    if (!isPoolSettled(pool)) throw new EvalHandleHostError("eval_handle_pending", `${ref.id} is still running`)
    return poolOutcome(pool, ref)
  }
  const record = loadFencedTask(deps.tasks, agentRef(ref), ctx)
  if (!isSettled(record)) throw new EvalHandleHostError("eval_handle_pending", `${ref.id} is still ${record.status}`)
  return taskOutcome(record, ref)
}

export async function cancelRef(deps: ControlDeps, ref: HandleRef, ctx: HandleCallContext): Promise<CancelReceipt> {
  if (ref.kind === "workpool") {
    const pool = loadOwnedPool(deps.pools, ref, ctx)
    if (isPoolSettled(pool)) return { ref, cancelled: false, phase: poolSnapshot(pool, ref).phase }
    const cancelled = deps.pools.workpools.cancel(deps.pools.poolCaller(ctx.ownerSessionId), ref.id)
    return { ref, cancelled: true, phase: poolSnapshot(cancelled, ref).phase }
  }
  const before = loadFencedTask(deps.tasks, agentRef(ref), ctx)
  const outcome = await deps.tasks.cancelTask(ref.id, CANCEL_REASON, { expectedRunEpoch: ref.run_epoch })
  const after = deps.tasks.get(ref.id) ?? before
  // The cancel was refused because the run moved: name it, never report the successor's state.
  assertCurrentRun(after, ref)
  const cancelled = outcome.kind === "cancelled" || outcome.kind === "cancel_pending"
  return { ref, cancelled, phase: taskSnapshot(after, ref).phase }
}

export async function sendRef(deps: ControlDeps, ref: HandleRef, message: string, ctx: HandleCallContext): Promise<HandleSnapshot> {
  if (ref.kind !== "agent") throw new EvalHandleHostError("eval_handle_operation_unsupported", `send is for agent handles, not ${ref.kind}`)
  loadFencedTask(deps.tasks, ref, ctx)
  const outcome = await deps.tasks.sendToTask({ idOrName: ref.id, message, callerSessionId: ctx.ownerSessionId, expectedRunEpoch: ref.run_epoch })
  const record = deps.tasks.get(ref.id)
  if (record === undefined) throw new EvalHandleHostError("eval_handle_not_found", `no task ${ref.id}`)
  switch (outcome.kind) {
    case "revived": {
      const successor = { ...ref, run_epoch: outcome.run_epoch }
      return taskSnapshot(record, successor, `revived as epoch ${outcome.run_epoch}`)
    }
    case "steered":
    case "queued":
      return taskSnapshot(record, ref)
    case "scope_denied":
      throw new EvalHandleHostError("eval_handle_forbidden", outcome.reason)
    case "not_found":
      throw new EvalHandleHostError("eval_handle_not_found", outcome.reason)
    case "not_continuable":
      if (outcome.reason.includes(STALE_RUN_REASON)) assertCurrentRun(record, ref)
      throw new EvalHandleHostError("eval_handle_send_refused", `${outcome.reason} ${outcome.suggestion}`)
    case "one_shot_agent":
      throw new EvalHandleHostError("eval_handle_send_refused", outcome.message)
    case "admission_refused":
    case "capacity_deferred":
    case "cwd_unavailable":
    case "config_generation_mismatch":
    case "delivery_uncertain":
      throw new EvalHandleHostError("eval_handle_send_refused", outcome.reason)
  }
}

export function outputOf(deps: ControlDeps, ref: HandleRef, request: OutputRequest, ctx: HandleCallContext): OutputSnapshot {
  if (ref.kind !== "agent") throw new EvalHandleHostError("eval_handle_operation_unsupported", `output is for agent handles, not ${ref.kind}`)
  loadFencedTask(deps.tasks, ref, ctx)
  const read = deps.transcriptReader({ taskId: ref.id, stateDir: deps.stateDir })
  // A resume during the read would hand back the successor's transcript; re-fence after reading.
  loadFencedTask(deps.tasks, ref, ctx)
  const rendered = renderTranscript(read.entries, { mode: "full", tailLines: 0 })
  const lines = rendered.text.length === 0 ? [] : rendered.text.split("\n")
  const total = lines.length
  const [start, end] = window(request, total)
  return { ref, text: lines.slice(start, end).join("\n"), offset: start, total, truncated: rendered.truncated || read.truncated === true || start > 0 || end < total }
}

function window(request: OutputRequest, total: number): readonly [number, number] {
  if (request.format === "tail") {
    const count = request.limit ?? DEFAULT_TAIL_LINES
    return [Math.max(0, total - count), total]
  }
  const start = Math.min(Math.max(0, request.offset ?? 0), total)
  return [start, request.limit === undefined ? total : Math.min(total, start + request.limit)]
}

function agentRef(ref: HandleRef): HandleRef {
  if (ref.kind !== "agent") throw new EvalHandleHostError("eval_handle_operation_unsupported", `${ref.kind} refs are not served by the task host`)
  return ref
}
