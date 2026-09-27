# Computer use in OmO Native

OmO Native can capture your desktop, inspect windows and accessibility trees, and send mouse and keyboard input to native applications. The `computer` tool is backed by the `senpi-desktop-engine` binary; the OmO Senpi component registers the tool but starts the engine only on activation. Computer use is available on supported macOS, Linux and Windows hosts. It does not control web pages through a browser API.

The tool's parameters and permission classification are in [the computer tool reference](../reference/computer.md). This feature belongs to OmO Native; the same `computer` block does not enable it in the OpenCode or Codex editions.

## Find and control the tool

The agent can find the search-exposed tool with `tool_search` for `computer`. After activation, JavaScript and Python eval kernels receive a `computer` global. The user controls the session with:

| Command | Effect |
|---------|--------|
| `/computer` or `/computer status` | Report whether the tool is enabled and active, engine and stop-path state, and current capabilities |
| `/computer on` and `/computer off` | Activate or deactivate computer use for this session |
| `/computer stop` | Suspend desktop input and release held keys and buttons |
| `/computer resume` | Lift suspension; only the user can do this |

Set `computer.enabled` to `false` to keep the tool unavailable at session start. The model cannot call `/computer resume` through the computer tool.

## Configure OmO Native

Put the `computer` block in `~/.omo/omo.jsonc` (or `~/.omo/omo.json`) for your account, or `.omo/omo.jsonc` in a project. The closest project layer wins. The schema is defined in `packages/omo-config-core/src/schema/computer.ts`; all keys are **snake_case**:

```jsonc
{
  "[native]": {
    "computer": {
      "enabled": true,
      "max_width": 3840,
      "max_height": 2400,
      "screenshot_max_bytes": 5000000,
      "allow_host_relay_only_stop": false,
      "macos_canary": "session",
      "audit_log": { "enabled": true },
      "screenshot_gc": { "enabled": true },
      "cua_adapter": false
    }
  }
}
```

You may also place `computer` at the shared top level; it remains effective only in OmO Native. `display` selects a display (the default captures all), `stop_hotkey` overrides the platform chord, and `engine_path` specifies an engine binary explicitly. Engine discovery tries `computer.engine_path` first; without it, the locator checks the compiled executable's sidecar, the `@oh-my-opencode/senpi-desktop-engine` package's native prebuild, and then the development build at `target/release/senpi-desktop-engine` (`packages/senpi-desktop-engine/src/locator.ts`). To make a development build, run `cargo build --release -p senpi-desktop-engine`.

`cua_adapter: true` adds the `computer_actions` tool for computer-use actions. It uses the same permissions, audit and stop path as `computer`, not a separate input channel.

## Permissions and the emergency stop

Screenshots, window lists, accessibility reads and `run` with `read_only: true` require `computer:read`. Input, mutations, `close`, and malformed requests require `computer:exec`. A non-interactive run cannot answer an `ask` decision, so allow the tier explicitly or the call is blocked. For example:

```sh
senpi --permission computer:read=allow --permission computer:exec=deny
```

This permits inspection while refusing clicks and typing. The OmO component uses the engine's permission parser in `packages/senpi-desktop-tool/src/permission.ts`.

The default global stop chord is Control+Option+Command+Escape on macOS and Ctrl+Alt+Shift+Escape on Linux and Windows. A stop suspends input until `/computer resume`. Input fails with `StopPathUnavailable` if the global chord cannot be armed. `allow_host_relay_only_stop: true` allows `/computer stop` as the only stop path instead; use it only when the host provides a reliable relay.

## Platform requirements

- **macOS:** grant Screen Recording and Accessibility to the application that launches OmO, and run from an unlocked graphical console. An SSH login cannot use that console's grants. Background keyboard input to a process with several windows can report `BackgroundUnavailable`; use accessibility or foreground delivery where appropriate.
- **Linux X11:** capture uses RandR, input uses XTEST or XSendEvent, and accessibility uses AT-SPI on the session D-Bus. Toolkits can reject synthetic background input; `BackgroundUnavailable` signals this instead of silently dropping it.
- **Linux Wayland:** capture depends on ScreenCast/PipeWire or the screenshot portal. Input uses the RemoteDesktop portal and libei; the portal may require consent. The global stop path requires a compositor with GlobalShortcuts support, otherwise use the host relay setting.
- **Windows:** per-monitor DPI and UI Automation are supported. Windows UIPI refuses input to a higher-integrity application; some toolkits, including WPF, refuse posted background messages.

Inspect `/computer status` for the current backend, permission flags, stop path and screen-lock state. A `native-unavailable` result means the binary could not be found at any of the locations above.

## Engine modes and bunshin

The engine supports `--stdio` (JSON-RPC over NDJSON), `--serve <socket>` (daemon), `--oneshot` (one request forwarded to the daemon), `--resume` (user-controlled stop recovery), and `--mcp` (MCP stdio server). In `--mcp` mode, `tools/list` offers engine methods as `desktop_<method>` tools; capture results include MCP images, and input still goes through the same safety gate. Never expose the user-only resume operation as a model tool.

The descriptor in `packages/senpi-desktop-engine/bunshin/descriptor.mjs` uses the `--oneshot` bridge. `bun script/install-bunshin-desktop-capability.mjs` installs it into the bunshin agent capability directory for a locally available engine; use `--engine <path>` for a specific binary or `--remove` to uninstall the descriptor. Installing a descriptor does not itself start an agent or grant desktop permissions.

Every mutating action is written to `.computer-audit.jsonl` in the session directory. Text input is represented by its length and digest rather than its content; set `audit_log.enabled: false` to disable the audit. Screenshots are managed by the `screenshot_gc` settings.
