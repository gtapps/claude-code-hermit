---
name: cost-reflect
description: "The 'why is my bill high' skill: audits where spend goes across token categories (cache_read, cache_write, output, input) and per-session attribution. Invoke for questions like 'cost breakdown', 'which sessions are expensive', 'what's driving spend', or 'cold start costs'. Not for week-over-week trend lines (use hermit-evolution) or simple total-spend summaries."
---
# Cost Reflect

Runs a structural cost audit over the last 7 days of `cost-log.jsonl` and delivers the result to the operator. The math is done by a script — your job is to run it and deliver the output through the right channel.

## Step 0 — Channel reply

If this skill was invoked from a channel-arrived message (the inbound prompt contains a `<channel source="...">` tag), reply via that channel's reply tool. Otherwise emit to conversation.

## Step 1 — Run the analyzer

```
bun ${CLAUDE_PLUGIN_ROOT}/scripts/cost-reflect.ts .claude-code-hermit
```

Capture stdout. If the output starts with "No cost data", report that message and stop — there's nothing to send.

## Step 2 — Relay the report

The script output is already formatted and capped at 1500 characters. Relay it verbatim. Don't summarize, reformat, or add commentary — the output is the report.

## Step 3 — Channel delivery

When this skill fires from a routine or proactively (i.e., not from a direct operator conversation), deliver the report through the operator's channel:

1. Resolve the outbound channel:
   ```
   bun ${CLAUDE_PLUGIN_ROOT}/scripts/resolve-outbound-channel.ts .claude-code-hermit
   ```
   Parse stdout as JSON. On success (`"id"` and `"chat_id"` present), send via `mcp__plugin_<id>_<id>__reply` with `{ chat_id, text: <report> }` where `<id>` is the resolved channel name.

2. If the script exits non-zero or returns `{"error":"no_reachable_channel"}`: if `push_notifications === true` in `config.json`, fire `PushNotification(message="cost-reflect: <first line of report>", status="proactive")` so the summary still reaches the operator. Then append a single Findings line to `.claude-code-hermit/sessions/SHELL.md`: `"cost-reflect: no reachable channel configured, channel-send skipped"`. Only log this once per session to avoid noise.

3. To set a preferred channel, add `"primary": "<channel-name>"` inside `channels` in `config.json`.

## Notes

- **Scheduling:** this skill doesn't self-register a routine. To run it weekly, add it via `/claude-code-hermit:hermit-settings` — a Sunday 22:00 cadence (`0 22 * * 0`) before weekly-review works well.
- **What it measures:** token-type cost composition (cache_read / cache_write / output / input), per-model breakdown (shown when ≥2 models appear, e.g. Sonnet main + Haiku heartbeat), cold-start turns (context warm-ups with no prior cache hit), and per-session cost attribution. For week-over-week totals and autonomy trends, use `/claude-code-hermit:hermit-evolution` instead.
