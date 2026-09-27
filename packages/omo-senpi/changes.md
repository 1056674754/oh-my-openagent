## task: pre-warm the session's task host (rpc-host-sharding todo 9)

`components/task/host-prewarm.ts` (new), wired from `index.ts` ahead of the session-start recovery
chain; POSIX `task.process_runner: host` only, fire-and-forget, at most once per session id:

- Revival pre-warm, always on: at `session_start`, every DISTINCT recorded `host_session.socket` of
  this session's suspended host-session children (`persisted_only` / `rpc_detached`, pending, running
  or interrupted, not killed) is ensured through the lifecycle's own endpoint port, so the host boots
  while the reconcile scans records and the reconcile's revival ensure hits the per-socket cache. The
  session's own endpoint is never ensured (a child inside `p-A` does not warm `p-A`), and nothing is
  warmed when `resume_children` or `reattach_on_reconcile` is off.
- `task.host_shard_prewarm: "session-start"` asks the execution-mode gate at `session_start`;
  `"first-turn"` asks it on the first `input` or `before_agent_start` of the session (later prompts of
  that session return before capturing any context); `"off"` (default)
  does nothing beyond the revival pre-warm. The gate's memoization is unchanged, and a failed ensure
  surfaces as the gate's `host_unavailable:*` notice, never as a turn error.

The revival pre-warm warms only the hosts of the children the reconcile's admission batch will revive
(senpi-task `selectRevivalBatch`, `residency_max_children` included): with a cap of 1 and three suspended
children on three shards it boots one host, not three.

`engine-host-wiring.ts` (new, pure move): the host runtime, the lifecycle and the runner context
that reach a task host are composed there instead of in `engine.ts`.

Tests: `host-prewarm.test.ts` (new).

## task: every session's process children run on its own host (rpc-host-sharding todo 8)

`components/task/shard-routing.ts` (new): the session's shard identity is read at every call, never at
construction - a session opened inside a host with a 16-hex `shard_key` in its context reuses its tree's
host (attach-only); every other session (a parent, a per-child-process child, a Desktop thread) is the
root of its own tree, keyed by its OWN session id (`p-<shardKey("p", id)>.sock` under
`OMO_RPC_SHARD_ROOT ?? <agentDir>/rpc/shards`). No session id at routing time is `shard_identity_missing`.
`OMO_RPC_SOCKET_PATH` / `OMO_RPC_SOCKET` no longer route task children anywhere.

`host-execution-mode.ts`: the `auto` gate ensures the session's shard (socket + owner + alt-root notice)
or, for an inherited / own endpoint, only probes it. `EngineHostRuntime` carries the routing, the
lifecycle's `hostEndpoint` port and `shardSocket()`. `engine.ts` wires `hostEndpoint` into the lifecycle
(revival and orphan reconcile now re-ensure recorded sockets and guard the own endpoint) and passes
`shardResolver`, `storeDir`, `ownHostSocket`, `onNotice` and `probeHost` to `RpcHostRunner` through
`RunnerBuildContext.hostRouting`; `buildProcessChildRunner` refuses to build a host runner without it.
The `task.host_idle_exit_ms` override now wraps the one ensure port the gate, runner and lifecycle share.
The daemon launch spec is unchanged: no memory knob.

Tests: `shard-routing.test.ts` (new), `host-runner-selection.test.ts`.

## computer use: forward the macOS canary policy (#8945)
## 2026-09-27 - Persist mailbox operations without whole-queue rewrites

The ordered-delivery mailbox now records one durable journal update per enqueue
or removal instead of serializing and fsyncing the complete pending queue after
every mutation. Enqueue and non-compacting removal updates append one event;
bounded snapshots compact drained or long journals. Existing `mailbox.json`
snapshots migrate on first open, preserving sequence numbers and queued
messages. The cap-and-restart test keeps the same count, byte, overflow, and
recovery contracts with injected limits, and the earlier 15-second timeout
override is removed.

## local launcher: `omo update` points at bun

The shipped extension now passes `computer.macos_canary` through the desktop
service to the native session. Explicit `off` reaches the macOS backend;
omitting the setting keeps `session`. The native session validates the policy
and applies it again when opening or reconfiguring a backend.

## Facts: bounded recovery for one oversized entry (#8984)

**Behavior change for memory users.** A facts entry larger than the 128 KiB batch cap used to be parked and never extracted; it now gets one bounded extraction run after all ordinary batches are done: the complete entry up to 512 KiB, at most 8 provider requests of at most 4,096 output tokens each, no retry and no model fallback. That run costs provider calls and can commit new facts to the memory repository. Entries above 512 KiB, or whose pinned model's context is unknown or too small, stay parked as before.

An indivisible facts entry previously parked permanently once its complete payload exceeded 128 KiB. Ordinary batches keep that cap. When no ordinary batch remains, one complete entry may now launch under an explicit 512 KiB ceiling only if the pinned model has known sufficient context; input is neither truncated nor split. Every provider request checks complete serialized context and actual model capacity, with at most 8 requests, 4,096 output tokens each, and no retry/fallback. Construction-time guards abort compaction or reduced context and reject truncated output. Accepted extraction is limited to 128 KiB/256 records, with concurrent reservations; any guard failure invalidates the entire result. Existing deadline, failure parking and one receipt/apply/consume boundary remain. These are bounded model-work and exact input/extraction limits, not a hard child-journal disk quota.

Validation: 109 facts tests, adapter TypeScript check, generic/TypeScript review and real isolated Senpi CLI/local-mock QA pass. The 204,058-byte fixture reaches the provider unchanged and commits/consumes once. Actual overflow compaction, output truncation, byte overflow and request exhaustion all retain the original queue with zero commits. Cancellation and crash-after-apply receipt recovery are covered.

## QA drivers: children run on the sandbox, never on the caller's install or daemon

`scripts/qa/sandbox-child-env.mjs` (new): `isolatedChildEnv(baseEnv, agentDir)` builds a driver's child
environment. It points every agent-dir lane (`OMO_`/`SENPI_`/`PI_CODING_AGENT_DIR`) at the sandbox, and
drops the task-host routing variables that `resolveTaskHostSocket` honours before the agent dir
(`OMO_RPC_SOCKET`, `SENPI_RPC_SOCKET`, `PI_RPC_SOCKET`, `OMO_RPC_SOCKET_PATH`), every
`SENPI_RPC_HOST_*` variable, and the launching session's identity (`PI_SESSION_ID`, `PI_SESSION_FILE`,
`PI_SESSION_CWD`, `PI_GOAL_STORE_FILE`, `SENPI_SESSION_FILE`, `SENPI_PY_KERNEL_PARENT_PID`). 38 drivers
that spread the caller's environment and overrode only `SENPI_CODING_AGENT_DIR` now build through it.
The omo launcher exports `OMO_CODING_AGENT_DIR` to every tool child and that lane outranks
`SENPI_CODING_AGENT_DIR`, so a driver started from an OmO session put its task children on the
machine's production daemon inside a temp project it later deleted, and the host then failed every
open (code-yeongyu/senpi#2206). `sandbox-child-env.test.mjs` unit-tests the scrub and fails when a
driver pairs a caller-environment spread with a `SENPI_CODING_AGENT_DIR` override without the builder.
The self-test fixtures of `task-tui-e2e.mjs` and `ulw-goal-footer-tui.mjs` model the contaminated
caller explicitly instead of spreading the real environment.

