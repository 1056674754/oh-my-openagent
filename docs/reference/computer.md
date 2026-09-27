# The `computer` tool

The OmO Native computer-use component registers a search-exposed `computer` tool and, after activation, a `computer` global in JavaScript and Python eval kernels. For setup, stop paths, platform limits and permissions, see [Computer use](../guide/computer-use.md).

## Source of the contract

- Component registration, session lifecycle and resource discovery: `packages/omo-senpi/src/components/computer-use/index.ts`
- Typed native-only configuration: `packages/omo-config-core/src/schema/computer.ts`
- Tool actions and validation: `packages/senpi-desktop-tool/src/tool.ts`, `packages/senpi-desktop-tool/src/params.ts`
- User command and permission tiers: `packages/senpi-desktop-tool/src/command.ts`, `packages/senpi-desktop-tool/src/permission.ts`
- Eval facade and model-facing guidance: `packages/senpi-desktop-prelude/src/prelude.js`, `packages/senpi-desktop-prelude/src/prelude.py`
- Engine client and protocol: `packages/senpi-desktop-service/src`, `packages/senpi-desktop-protocol/src`
- Engine and platform backends: `crates/senpi-desktop-engine`, `crates/senpi-desktop-backend-macos`, `crates/senpi-desktop-backend-x11`, `crates/senpi-desktop-backend-wayland`, `crates/senpi-desktop-backend-win32`

## Actions

| `action` | Parameters | Result |
|----------|------------|--------|
| `call` | `chain`: a desktop helper `{ method, args? }`, optionally followed by one window or element method | The helper's result; a screenshot also returns image content |
| `run` | `code`: JavaScript async function body with `desktop`, `wait`, `assert` and `tool`; optional `read_only` and `timeout` in seconds | The returned value and displays |
| `capabilities` | None | Backend, capture/input/AX permissions, stop path and focus guard |
| `close` | None | Ends the desktop session |

For example, `{ "action": "call", "chain": [{ "method": "screenshot" }] }` captures the desktop. A `run` can call `await desktop.screenshot()` then `await desktop.click(x, y)` using a coordinate from that frame. Screenshots are limited to a coordinate-safe size when passed to a model; a stale frame is rejected with `InvalidCoordinateFrame`.

The `computer` eval global offers the same operations as a fluent facade. A `run` marked `read_only: true` is constrained by the runtime, so attempted input fails rather than escaping the read tier.

## Permission classification

`capabilities`, inspection-only `call` chains, and `run` with `read_only: true` use `computer:read`. `close`, other calls and runs, unknown methods and malformed inputs use `computer:exec`. The host checks the tier before the engine receives an action, so an exec-denied click is not audited as an engine click. Rules may target the entire `computer` tool or the `computer:read` and `computer:exec` tiers. An approval for read never approves exec.

## Coordinates and delivery

Pointer coordinates refer to the latest screenshot of the same target, while accessibility coordinates are global desktop coordinates. Each accessibility snapshot changes the reference generation; old refs fail with `StaleRef`.

Input defaults to background delivery when supported. On macOS it leaves the frontmost app, its focused window, the cursor and the destination of the user's next keystroke unchanged, but a clicked target window may rise directly under the user's front window. Foreground delivery uses a focus guard to restore the previous window and cursor; restoration failures are reported instead of hidden. A stop chord, screen lock, lost stop path or missing OS permission refuses input before a backend action.

## Engine interoperability

Engine discovery checks `computer.engine_path`, a compiled sidecar, the package prebuild and `target/release` in that order (`packages/senpi-desktop-engine/src/locator.ts`). Outside OmO Native, `senpi-desktop-engine --mcp` serves the same engine operations over MCP stdio, forwarding through the daemon and preserving its stop-path and audit checks. A host using relay-only stop must keep the heartbeat alive; the model cannot invoke the user-only resume operation.
