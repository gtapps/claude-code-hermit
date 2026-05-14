---
name: capture-activity-rpe
description: Captures RPE (1-10) and subjective notes when the operator replies to a strava-sync notification on any configured channel. Triggers on inbound channel messages matching RPE grammar while state/strava-pending-rpe.json has a sync from the last 24h. Channel-agnostic.
allowed-tools:
  - Read
  - Write
  - Bash(rm .claude-code-hermit/state/strava-pending-rpe.json)
  - mcp__plugin_discord_discord__reply
---

# Capture Activity RPE

Records the operator's perceived effort and subjective notes for the most recent synced activity.

Self-triggers on RPE-shaped replies while `state/strava-pending-rpe.json` is fresh. The skill's `description` is intentionally narrower than `claude-code-hermit:channel-responder`'s so the harness picks it for these specific messages; any non-matching message exits silently and the normal `channel-responder` flow proceeds. Re-checks `allowed_users` itself.

## Steps

1. Read `.claude-code-hermit/state/strava-pending-rpe.json`. If the file is absent: exit silently. If `synced_at` is more than 24 hours ago: run `rm .claude-code-hermit/state/strava-pending-rpe.json` and exit silently (reply window closed).

2. **Authorization.** Read `.claude-code-hermit/config.json` → `channels.<channel>.allowed_users` for the inbound channel (extract the channel name from the inbound message metadata):
   - If `allowed_users` exists and the sender's platform user ID is **not** in it: exit silently. No response, no log, no state write.
   - If `allowed_users` is absent: accept (backwards-compatible).
   - If `allowed_users` is `[]`: reject all — exit silently.

3. Parse the inbound message body (case-insensitive, leading/trailing whitespace stripped):

   ```
   ^(?:RPE\s*:?\s*)?(\d{1,2})(?:\s*/\s*10)?(?:[\s,:]+(.+))?$
   ```

   This matches: `7`, `7/10`, `RPE 7`, `RPE: 7`, `RPE:7`, `7 heavy legs`, `RPE 7, heavy legs`, `RPE: 7 heavy legs`.

   - Extract `rpe` (group 1) and `notes` (group 2). If group 2 is absent or an empty string after trim, treat `notes` as `null`.
   - Validate `rpe` is an integer from 1 to 10 inclusive.
   - If parse fails or validation fails: exit silently. (Bare `yes`/`no`/`y`/`n` cannot match `\d{1,2}` so they are naturally excluded; the micro-approval branch in `channel-responder` handles them.)

4. Read `.claude-code-hermit/state/activity-notes.json`, or use `{}` if absent. Set the entry for `<pending.activity_id>` (overwrite if it already exists, silently), then write the file back:
   ```json
   {
     "<pending.activity_id>": {
       "rpe": <int>,
       "notes": <string|null>,
       "recorded_at": "<ISO 8601 with offset>"
     }
   }
   ```
   The `notes` field is always present: `null` when no notes were captured, never missing.

5. Run `rm .claude-code-hermit/state/strava-pending-rpe.json` so the same sync cannot bind twice.

6. Reply via the channel's `reply` tool with `{chat_id, text}`. `allowed-tools` only lists Discord (`mcp__plugin_discord_discord__reply`); on non-Discord channels this step will fail with a permission error, but the RPE is already persisted in step 4. Extend `allowed-tools` when adding Telegram or iMessage.
   ```
   Got it — RPE <rpe>/10 saved for <pending.name>.
   ```
