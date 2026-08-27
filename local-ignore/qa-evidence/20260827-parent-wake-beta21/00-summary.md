# Parent-wake callback delivery verification — OMO 5.0.0-beta.21-sscity

**Date:** 2026-08-27 | **Verify:** live E2E on standalone opencode server
**Context:** Running plugin was 4.19.3-sscity (installed 2026-07-30). Three background
subagents completed with 0/3 result notifications delivered to the parent (the bug
behind community issues #4169/#1967-family). Fork merged upstream v5.0.0-beta.21
(16 betas, incl. the parent-wake rewrite) and deployed it to
`~/.config/opencode/node_modules/oh-my-opencode` (backup: `oh-my-opencode.pre-beta21-20260827-094657`).

## Environment

- opencode server: `~/.opencode/bin/opencode` 1.18.16-sscity, standalone on 127.0.0.1:39999
- plugin: 5.0.0-beta.21-sscity (built from fork commit 73bc0ad49, `bun run build` + `npm pack`)
- parent agent: "Sisyphus - ultraworker" (zhipuai-coding-plan/glm-5.2)
- subagent: explore (openai/gpt-5.6-luna)
- plugin log: `$TMPDIR/oh-my-opencode.log`

## Verdicts

| Scenario | Expected | Observed | Verdict |
|---|---|---|---|
| A: parent idle — 3 bg agents complete | 3 launches, ≥1 notification, 3 background_output calls | 3 / 3 reminders / 3 | **PASS** |
| B: parent busy (3 reads + 600-word synthesis) while 3 bg agents complete | notifications queued during busy window, delivered after turn, consumed | 42 wake defers (1/s) during busy window, then delivered; 2 reminders, 3 background_output calls | **PASS** |

Files: `01-final-verdicts.txt` (API-level counts), `02-scenarioB-wake-timeline.txt`
(defer cadence), `03-scenarioA-timeline.txt`, `04-errors-check.txt` (zero relevant errors).

## Conclusion

The 0/3 notification loss observed on 4.19.3-sscity is **fixed by the upstream
beta.6→beta.21 parent-wake rewrite** (pending queue + dispatched tracker + window
recovery + admit-only deposits). Busy-parent behavior is now correct-by-design:
wakes defer while the parent turn is active, deliver when idle, and the parent
consumes results via background_output. No fork-side delivery-guarantee work is
required on top of beta.21.

Remaining: restart OpenChamber so the embedded server (currently 4.19.3 in memory)
picks up the deployed plugin.
