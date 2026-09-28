import { spawnSync } from "node:child_process"
import { writeFileSync } from "node:fs"
import { join } from "node:path"

import { pass } from "./task-host-e2e-shards-support.mjs"

const TESTS = [
  "packages/senpi-task/src/runners/rpc-host-own-endpoint.test.ts",
  "packages/senpi-task/src/runners/rpc-host-endpoint.test.ts",
  "packages/senpi-task/src/lifecycle/host-endpoint-inside-host.test.ts",
  "packages/senpi-task/src/lifecycle/host-session-endpoint.test.ts",
  "packages/senpi-task/src/store/rollback-migrate.test.ts",
  "packages/omo-native/test/daemon-rollback.test.ts",
  "packages/omo-native/test/daemon-rollback-options.test.ts",
  "packages/omo-native/test/daemon-drain-wait.test.ts",
  "packages/omo-senpi/src/components/task/shard-routing.test.ts",
  "packages/senpi-task/src/runners/rpc-host/shard-socket.test.ts",
]

const CONTRACT_ROWS = [
  "mixed_engine_host_spawns_shard",
  "handoff_nested_spawn_uses_successor",
  "interactive_handoff_nested_spawn",
  "alt_root_handoff_parent_and_thread",
  "nested_resume_attach_only",
  "rollback_live_endpoint_refused",
  "rollback_drain_wait_gate",
  "rollback_three_store_migration",
  "rollback_r0_resume",
  "rollback_without_prepare_parks",
  "cross_endpoint_open_hazard",
  "idle_gc_index_resume",
  "store_index_registration_precondition",
  "retain_idle_resume",
  "retain_midturn_continuation",
  "migration_recorded_socket_wins",
  "incompatibility_and_entry_fault_isolation",
]

export function runContractMatrix(repoRoot, artifacts) {
  const env = {
    ...process.env,
    PATH: `${process.env.HOME}/.bun/bin:${process.env.PATH}`,
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
  }
  const result = spawnSync("bun", ["test", ...TESTS], {
    cwd: repoRoot,
    env,
    encoding: "utf8",
    timeout: 600_000,
    maxBuffer: 32 * 1024 * 1024,
  })
  const logPath = join(artifacts, "contract-tests.log")
  writeFileSync(
    logPath,
    [
      `command=bun test ${TESTS.join(" ")}`,
      `exit=${result.status}`,
      result.stdout ?? "",
      result.stderr ?? "",
    ].join("\n"),
  )
  if (result.status !== 0) {
    return Object.fromEntries(CONTRACT_ROWS.map((id) => [
      id,
      {
        status: "fail",
        evidence: [logPath],
        reason: `contract test gate exited ${result.status}`,
      },
    ]))
  }
  return Object.fromEntries(CONTRACT_ROWS.map((id) => [
    id,
    pass([logPath], {
      gate: "targeted product contract tests",
      command: `bun test ${TESTS.join(" ")}`,
    }),
  ]))
}
