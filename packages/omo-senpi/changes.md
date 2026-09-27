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

