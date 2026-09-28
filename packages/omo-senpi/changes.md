## task: one store admission for the host pre-warm and the auto spawn; the index row runs in auto mode

- `components/task/store-admission.ts` (`admitTaskStore`) registers the engine's task store in the agent-dir store index or
  answers false. The host pre-warm and the host execution-mode gate both use it, so the two paths that would ensure a host before the runner cannot drift.
- The host execution-mode gate (`createHostExecutionModeGate`, POSIX `host` runner) passes it as the gate's `admit`; the
  engine hands the gate its store directory through `createEngineHostRuntime(..., { storeDir })`.
- `scripts/qa/task-host-e2e-shards.mjs`: `store_index_registration_precondition` also runs as
  `store_index_registration_precondition_auto` in the default `auto` mode, where the gate ask would otherwise ensure a
  host before the store is indexed. The matrix is 25 rows.

## 2026-09-29 — task: the pre-warm sends the host's `warm` command, registers the store first, and warms Desktop threads on the first delegation intent

`components/task/host-prewarm.ts`:

- The warm is admitted exactly like a spawn (`admitChildStore`): the session's task store is registered in the
  agent-dir store index before the gate ensures anything. When the index cannot be written, nothing is ensured or
  warmed, nothing is noticed, and the first spawn fails `store_index_unavailable` on its own. Before this, the
  pre-warm started a `p-*` endpoint that the store index did not list (the `store_index_registration_precondition`
  live row failed 2/2 with the default `first-turn`).
- Once the gate answers `process`, the host's `warm` command (senpi 2026.9.28-7) loads the child session's services
  on the session's shard (senpi-task `warmTaskHost`), in place of a throwaway warm-up session; an engine from before
  the command still gets the warm-up session. Its failure is logged and changes nothing for the first child.
- A session running inside a Desktop thread host (its session context's `host_socket` is an `i-*` endpoint) does not
  warm on its first prompt under `first-turn`: it warms when the model starts streaming a `task` or `task_send` call
  (`message_update` with a `toolcall_start` event, `host-prewarm-intent.ts`), once per session id. Terminal
  sessions keep `first-turn`; `session-start` and `off` are unchanged for both.
- `wireHostPrewarm` returns `{ settled(sessionId) }`, the session's warm in flight (never rejects).

Tests: `host-prewarm-warmup.test.ts` (warm command against a fake host at the shard socket, old-engine fallback,
refusal), `host-prewarm-store-index.test.ts` (new), `host-prewarm-intent.test.ts` (new), `host-prewarm.test.ts`
(awaits the warm instead of reading ensures synchronously).

## 2026-09-29 — Task-host crash lines read in one word and count only what came back

The `host_shard_crash_done:<key>` closing line now reads `N subagent(s) reattached, 0 lost`, or, when anything was lost, `N subagent(s) lost (reattach failed), M reattached` (`, C cancelled` as before). "Reattached" counts only children that actually came back (attached, resumed, continued); the old first number counted lost ones too, so a lost case read "1 reattached: 0 continued mid-turn, 1 lost". The `host_shard_crash:<key>` warning says "reattaching N subagent(s)..." instead of "child/children". Both tokens are unchanged; the Desktop's parser moves to this shape in the same release. `shard-crash-notice.test.ts` pins both shapes.

## task: the session's own host is pre-warmed by default, and warmed up with one throwaway session (rpc-host-sharding PR-A)

`task.host_shard_prewarm` now defaults to `"first-turn"` (schema `packages/omo-config-core/src/schema/task.ts`,
`assets/omo.schema.json`); `"session-start"` and `"off"` stay available. Measured on the compiled binary with a
user-shaped first child (session opens, first turn, mock model latency 1-3 s, then the `task` call): without a pre-warm
the first child waited for a cold host, and a pre-warmed host's first child was still slower than the old shared
host's, because a host pays for its FIRST session (extension compile, lazy task runtime). With the warm-up session,
60 samples over two runs: `first-turn` 1116/1678 ms p50/p95, `session-start` 1115/1648, `off` 1666/3280 (20 samples),
control (previous release, shared host already running) 979/1593. `first-turn` wins over
`session-start`: both hide the boot behind the model call, and `first-turn` starts no host for a session that is
never prompted.

`components/task/host-prewarm.ts`:

- Only the root of a session tree warms (`readSessionRole(pi) === undefined`): a child session is served by its tree's
  host, and a per-process child would boot a host for nothing. `default_execution_mode: "in-process"` never warms.
- The warm goes through the gate's new `warm()` (senpi-task `execution-mode.ts`): a success is kept exactly as the
  first spawn's `ensure()` would keep it, a failure is only logged (`onWarmFailure`) and settles nothing, so the
  first spawn asks again and reports its own `host_unavailable:*` notice; an `ensure()` issued mid-warm joins it.
  `host-execution-mode.ts` `resolveMode` now rejects instead of settling in-process itself; the gate's
  `onEnsureFailure` adds the notice.
- Once the gate answers `process`, one throwaway child session is opened and closed on the session's shard
  (senpi-task `warmHostSession`); its failure is logged and changes nothing for the first child.
- win32 stays excluded: the auto gate resolves in-process there, so no task host exists to warm.

`components/telemetry/omo-native-component.ts` registers nothing for a warm-up session (`isHostWarmupSession`),
so it is never reported as a session, a daily-active ping or a crash reporter.

QA driver: `scripts/qa/task-host-e2e-shard-cost-user-latency.mjs` (new) adds the user-shaped latency scenarios
(`user_first_child_{off,first_turn,session_start,default,control}`, interleaved per round, the control on an
already-running shared host) and the `prewarm_idle` section (default and session-start, a session that never
spawns: footprint and idle exit); `shard-cost-eval.mjs` judges default vs control at p50 and p95.
`teardownSandbox` sweeps and retries on `ENOTEMPTY` instead of losing a section to a host generation still exiting.

Tests: `host-prewarm.test.ts`, `index.test.ts`, `omo-native-component.test.ts`, `shard-cost-eval.test.mjs`.

## docs: engine hosts per session (rpc-host-sharding todo 18)

`AGENTS.md` replaces "Shared engine host" with "Engine hosts per session": children run on their session's own
host, `rpc.sock` stays the operator and thread-tool endpoint, and no cap limits hosts. `src/components/task/AGENTS.md`
gains the `shard-routing.ts` / `host-execution-mode.ts` / `shard-crash-notice.ts` row (the crash notice names
`supervisor pid N`, `1 child` is singular, and the done line gains `, C cancelled`). `src/components/thread/AGENTS.md`
says `ensureHost()` starts one host per endpoint. `thread_read` labelling tool results as role `tool` on the live path
(the transcript fallback already did) is recorded in the root `CHANGELOG.md`. No code changes.

## thread: tools address peer sessions across every host endpoint (rpc-host-sharding todo 11)

`components/thread/live-surface.ts`: the thread tools no longer see only the legacy socket. They enumerate endpoints
with the engine CLI `host status --all --include-workers --json` (reused for 5 s), keep the legacy
`resolveThreadSocket` endpoint in the list (where `omo daemon attach` sessions live), and list every endpoint live on
each call (10 s budget per endpoint), every listing marked `observe: true` so a thread tool call never resets a shard's
idle window. A listed session carries its `socket`, and every per-session request
(`getMessages`, `getState`, `prompt`, `interrupt`, `setSessionName`, `setModel`, `getAvailableModels`,
`setThinkingLevel`, `getAvailableThinkingLevels`) dials that socket through the new `ThreadHost.endpoint(socket)` port,
because routing ids are per-host counters (`rpc-1` on every host). `thread_create` still opens on the legacy socket.
An endpoint that does not answer degrades its sessions to disk truth: the session files its report still claims, or
that it last listed, are read from JSONL and listed by `thread_list` as `resumable` with its failure in `error_note`,
and `thread_read` answers them from JSONL (`source: "session_jsonl"`, `source_incomplete: true`, `error_note`), rendering
only user/assistant/tool message entries. `thread_read` items gain the `tool` role (engine `toolResult`) on both paths.
An engine that cannot enumerate (a pre-release engine rejecting `--all`, no resolvable CLI) degrades to the legacy
endpoint alone - today's behavior, including `host_unavailable` as data when that socket is missing.

Tests: `live-surface-endpoints.test.ts` (new), `live-surface.test.ts`.

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

## Memory reflection moves to the next model on a spent usage or quota limit (#8296, #6808)

`worker/model-miss.ts` classified a reflection child that died on `quota exceeded` as not retryable, so a Kimi quota 403 or any other spent plan ended the reflection run instead of trying the next candidate. The shared model-core classifier no longer keeps a separate STOP list: `isRetryableModelError` now derives quota, usage, and billing limits from `classifyRuntimeFallbackError`, so `classifyRetryableModelMiss` reports them as `provider_unavailable` and `runMemoryModelAttempts` continues down the chain. A quota the provider marks as terminal still stops.

## Kibitzer gate notice names the failing model and its fix; unserved Devin SWE-2 ids warn at startup (#9111)

The persistent-failure notice only said `check Kibitzer model/provider settings`, so a user whose recall category was pinned to a refused model could not tell which setting to change. `observe.onWake` now takes the session's recall settings (`{ category }`, passed by the composition), the gate record carries the additive `category`, and `renderKibitzerGateEntry` draws `last failed model: <model> (memory recall category "<category>")` and `after N consecutive failures; set categories.<category>.model (or memory.recall.category) in omo.json to a model that answers`. The model and category are drawn only as one bounded, secret-free line; an older record, or one with a malformed category, keeps the generic hint. `config-startup` adds one warning when a category or agent names a Devin SWE-2 id Cascade does not serve (`devin/swe-2`, `devin/swe-2-low`, `devin/swe-2-high-lite`; model-core `isUnservedDevinSWE2Selector` / `DEVIN_SWE2_SERVED_LANES`), naming each path and the served lanes `devin/swe-2-medium`, `devin/swe-2-high`, `devin/swe-2-max`. QA: `scripts/qa/kibitzer-sidecar-e2e.mjs --scenario refused-pinned-model` drives the real senpi binary against the built bundle with the pinned model refused (403 `permission_denied`) and a builtin quick rung served; the lane's `assertSandboxEnv` now requires every agent-dir lane to point at the sandbox, the shape `isolatedChildEnv` produces since #8967 (it rejected `OMO_CODING_AGENT_DIR` and so failed every Kibitzer scenario before any wake). Tests: `notice.test.ts`, `observe.test.ts`, `config-startup/index.test.ts`, model-core `model-family-detectors.test.ts`.

## Memory sidecars keep the category's builtin chain after a pinned model (#9111)

A recall (or facts/reflection) category pinned to a model outside its builtin chain, such as `categories.quick.model: "devin/swe-2-low"`, resolved with no fallback rung: `resolveCategory` leaves a user-forced model's chain untouched, so `resolveReflectionModel` returned `fallbacks: []`, the child ran with model fallback off, and a provider that refused the pin (Devin answers an unserved SWE-2 lane with `permission_denied`) failed every Kibitzer wake until the three-failure gate notice. `worker/resolve-model.ts` now appends the category's builtin chain rungs that are connected (senpi-task `builtinCategoryChainCandidates`) after the user's own rungs, on both the resolved path and the stale-snapshot pin path. They are the category's own chain, never the beyond-category ladder the advisor refuses; the pinned model still answers first and transient errors keep the same-model retry. Tests: `worker/resolve-model.test.ts` (a pin outside the chain gets the connected builtin rungs in chain order; a user chain keeps priority over them).

## skill commands: bare `/ulw-execute` and every bundled skill name dispatch like `/skill:` (#9042)

`/ulw-execute <plan>`, the command the ulw-plan handoff and the Native guides tell users to run, was not a command: senpi only expands `/skill:<name>`, so the text reached the model verbatim, no skill body was injected, and the `ulw` in it armed ultrawork, which made the run look started. The new `skill-commands` component rewrites a leading `/<bundled-skill>` into `/skill:<bundled-skill>` in the input event, ahead of every other omo input handler, with the submission's source unchanged, so ultrawork, skill pointers, the ulw-plan gate and the continuation resets see exactly what a typed `/skill:` command gives them. A prompt template or another command with the same name keeps the name; a disabled or unloaded bundled skill gets a warning notice instead of reaching the model. The TUI autocomplete lists each bare name above its `skill:<name>` row. `documented-commands.test.ts` scans the shipped SKILL.md files and the Native guides and fails on a backticked `/command` that nothing registers.

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

