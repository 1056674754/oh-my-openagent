## memory: a late Kibitzer verdict no longer steers an extra turn after the final answer

- `components/memory/kibitzer/delivery.ts`: an accepted verdict steers at once only while the running session has a
  tool call executing. The host reads its steering queue after every turn, so a steer queued once the final answer
  was streaming or streamed started one more assistant turn after it; a headless `senpi -p` consumer that posts only
  the last assistant text then lost the real answer (observed as `answer -> omo-kibitzer:recall -> "NO_REPLY"`). Such a
  verdict is now held for the next `tool_result` steer or the next prompt's drain, like any other held nudge.
- `components/memory/kibitzer/hooks.ts`: `tool_call` / `tool_result` report the executing call ids to delivery, and a
  new `turn_end` hook clears them so a call that never reports a result (blocked, aborted) cannot outlive its turn.

## model-profile, task: builtin lanes and the category notice never route to an unlisted gateway (#9146)

- `components/model-profile/resolve.ts`: every builtin rung, in `recommended` and in the `daily-*`/`geeky-*` lanes, is
  served only by its listed providers, so a lane never lands the session on a gateway's copy of its model
  (`opengateway/anthropic/claude-opus-5-5`). A lane no listed provider serves is `unavailable` and keeps the session
  model with the existing one-line notice. A user's bare model id, which names no provider, still matches anywhere.
  `rankedProvidersOnly` is gone: it was the only builtin that had the listed-only rule, which is now the rule.
- `components/task/category-unavailable-warning.ts`: when only an unlisted provider serves a hidden category's chain,
  the one notice per session names it and the exact opt-in line
  (`categories.<name>.model = "<gateway>/<model>"`); `details.unlisted_provider_model` carries it for remote clients.

