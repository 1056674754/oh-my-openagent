# omo daemon — per-session engine hosts

`omo daemon` is the operator's view of every senpi RPC host in one agent directory.
The operator endpoint stays at `rpc.sock`; process-mode task trees use `p-*` shards,
and Desktop interactive threads use `i-*` shards. A crash or handoff on one shard
does not take the other sessions' hosts with it.
Everything that decides *who serves the socket* lives in the engine (`senpi host`);
this command supplies omo's launch spec, reads the policy out of `omo.json`, and
turns the engine's answer into an exit code a script can branch on.

```bash
omo daemon run                 # ensure a daemon serves this agent dir: start, reuse, or hand off
omo daemon run --json          # the engine's JSON line verbatim
omo daemon attach              # print the env a child needs to reach it
omo daemon attach --model x    # run omo against the daemon (a normal launch, shared socket)
omo daemon status [--include-workers]
omo daemon gc [--json]         # remove dead endpoint state and matching owner sidecars
omo daemon stop [--drain]      # the operator endpoint only
omo daemon stop --all          # every discovered endpoint
omo daemon stop --drain --all --wait --timeout 600
omo daemon handoff             # upgrade-gated handoff across every live endpoint
omo daemon rollback-prepare    # migrate retained records to rpc.sock before downgrading
```

Bare `omo` never ensures a daemon. Only `run`, `attach` and `handoff` can bring one
into existence; `status` and `stop` work on an install whose plugin payload was
never built.

## Per-session hosts

Task trees use `<shardRoot>/p-<key>.sock`, where `key` is the first 16 hexadecimal
characters of `sha256("p:" + rootParentSessionId)`. Desktop threads use the same
rule with `i:`. The default shard root is `<agentDir>/rpc/shards`; a socket whose
handoff siblings would exceed the platform path limit uses
`/tmp/omo-rpc-<sha256(agentDir)[:8]>` instead.

Who owns a shard is recorded beside it in `<kind>-<key>.meta.json`. `status` joins
that sidecar to the engine's read-only `host status --all` result, prints one row
per endpoint and generation, then prints a machine aggregate. `--json` returns:

```json
{
  "endpoints": [
    {
      "socket": "/tmp/example/rpc/shards/p-0123456789abcdef.sock",
      "shard": { "kind": "p", "key": "0123456789abcdef" },
      "owner": { "owner_session_id": "session-id" },
      "rss_mb": 120,
      "host_rss_mb": 88,
      "generations": []
    }
  ],
  "aggregate": {
    "live": 1,
    "shards": 1,
    "threads": 0,
    "sessions": 2,
    "rss_mb": 120,
    "host_rss_mb": 88,
    "crashes": 0
  }
}
```

`status` never prunes, signals, unlinks, or refreshes an idle host. A dead row is
kept until `omo daemon gc` asks the engine to validate that no generation, live
claim, or responding socket remains. Only after the engine reports an endpoint
removed does OmO delete its matching owner sidecar. The durable task-store index
is not endpoint state and survives ordinary gc; only
`gc --prune-store-index` removes entries whose store directory no longer exists.

## Where it lives

| What | Where |
| --- | --- |
| Operator socket | `<agentDir>/rpc/rpc.sock` (the canonical agent dir, see `omo doctor`) |
| Session hosts | `<agentDir>/rpc/shards/{p,i}-*.sock` or the short alternate root above |
| Host owner sidecar | Beside a shard socket as `{p,i}-<key>.meta.json` |
| Host state | `<agentDir>/rpc-host-daemon/<sha256(socket)[:16]>/` |
| Endpoint log | `<host-state>/stderr.log` |
| Crash records | `<host-state>/crashes.jsonl` (newest 50 counted by status) |
| Launch spec | `<pluginRoot>/daemon-launch-spec.json`, shipped inside the omo plugin payload |
| Child env | `OMO_ENABLE_SHARED_HOST=1` and `OMO_RPC_SOCKET=<socket>` (what `attach` prints) |

## Launch spec

The spec is the **only** argv source for the daemon — `omo daemon run`, a
child-triggered ensure and the desktop server all read the same file, so they
cannot drift from one another. It is a small JSON document:

```json
{ "schemaVersion": 1, "argv": ["--mode", "rpc", "..."], "env": { } }
```

Trust rules match the engine's own: a group- or world-writable spec, or one whose
path contains `..`, is refused before anything is started. Edit the spec by
rebuilding the plugin, not by hand.

## Policy and configuration (`omo.json`)

| Key | Values | Meaning |
| --- | --- | --- |
| `task.host_engine_policy` | `upgrade` (default) · `fallback` · `never` | what `run` may do when a host from another build already serves the socket |
| `task.host_idle_exit_ms` | milliseconds | the daemon exits after this long with no sessions |
| `task.host_shard_prewarm` | `off` (default) · `first-turn` · `session-start` | when to warm this session's derived task host; resumed sessions with suspended host children always warm their recorded hosts |
| `task.default_execution_mode` | `auto` · `in-process` · `process` | see *Execution mode* below |
| `task.process_runner` | `host` · `child-process` | which runner a `process` child gets |

`--no-upgrade` on the command line forces `never` for that call. A flag beats
config; config beats the default.

### Generations and handoff

Every build carries an ordinal (`<calver>+<build epoch>.<sha>`) and a launch
profile id. With `upgrade`, a newer build that finds an older host serving the
socket asks it to **hand off**: the old generation drains, the new one takes the
socket, live sessions keep their transcripts (the same session path, more lines,
never fewer) and the old process exits. Two builds whose ordinals cannot be
compared — different launch profiles, or an ordinal the host does not report —
never hand off; the newer side reuses or refuses, and says why.

`omo daemon handoff` applies that same gate independently. The operator endpoint
uses `host handoff`; every other discovered endpoint uses
`host ensure --policy upgrade --socket <socket>`. An older client therefore cannot
replace a newer host.

## Drain and rollback

`stop --drain --all` requests a drain and returns immediately with
`requested (not awaited)`. Use `--wait` for a downgrade gate. It exits zero only
after every generation pid is dead and every live session-path claim is released;
reachability is deliberately not evidence because a draining supervisor refuses
new connections while it finishes existing work.

After a successful wait, run `omo daemon rollback-prepare`. It discovers task
stores from `<agentDir>/rpc/task-stores.json`, surviving sidecars, and explicit
`--store <dir>` values. It refuses before writing if coverage is unknown or any
recorded endpoint is still live. Records are rewritten through the normal locked
task store path to `rpc.sock` and receive one `host_session_migrated` event.
`--dry-run` reports the same plan without writing. A missing index requires a
complete explicit store list or the deliberate `--allow-missing-index` override.

## Execution mode: what `auto` does

With `task.default_execution_mode: auto` the parent session resolves the mode
**once**, at its first daemon ensure:

- daemon reachable and it advertises what `auto` needs (session kind/context,
  retain-on-disconnect, the host protocol) → children run as **sessions in the
  daemon** (`process` mode, `host` runner);
- otherwise → **in-process**, exactly as before.

An unresolved `auto` reads as in-process, so no child is ever routed on a guess.
A user-set `in-process` / `process`, and every per-agent `execution_mode`, still
wins over the daemon check. Real fallbacks to a per-child process happen only for
a capability or policy `engine_mismatch`, on win32, or on a Node without bun.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | done — the engine's `action` says which of start / reuse / handoff |
| 2 | usage: no subcommand, or an unknown one (the engine is not called) |
| 3 | `status`: no daemon answers (`daemon: not running`) |
| 4 | unsupported platform: win32 has no unix socket to share (the engine is not called) |
| 5 | the engine refused — read its line; the launch spec may be missing |

## Troubleshooting

**`daemon: not running`** — nothing serves the socket. `omo daemon run` starts one;
if it exits 5, read the engine's reason (a missing spec means the plugin payload
was not built for this install).

**`omo doctor` endpoint rows** — each live daemon, shard, thread, and other
layout-2 endpoint reports pid, generation, engine, sessions, whole-tree RSS,
supervisor-plus-host RSS, descriptors, and crash count. Dead retained state is a
warning that points to `omo daemon gc`. The closing `INFO Hosts:` line is the
machine aggregate.

**`legacy host (no session context)`** — an older engine, started before the v2
state dir, is serving the socket. It has no session kind/context and cannot be
handed off to; `omo daemon stop` (or wait for its idle exit), then `run`.

**Threads grow with sessions** — about one OS thread per session is expected while
the `config-reload` builtin spawns a filesystem-watch worker per session
(tracked upstream as senpi#1794); with that builtin disabled the increment is 0.
It is linear, not flat; size a long-lived daemon from those numbers.

See also: [omob dev binary](./omob-dev-binary.md), [omo.json](./omo-json.md),
[senpi-task guide](../guide/senpi-task.md).
