---
name: capture-activity-rpe
description: Captures RPE (1-10) and subjective notes when the operator replies to a strava-sync notification on any configured channel. Triggers on inbound channel messages matching RPE grammar while state/strava-pending-rpe.json has a sync from the last 24h. Channel-agnostic.
---

# Capture Activity RPE

Records the operator's perceived effort and subjective notes for the most recent synced activity.

## Steps

1. Read `.claude-code-hermit/state/strava-pending-rpe.json`. If the file is absent: exit silently. If `synced_at` is more than 24 hours ago: delete the file and exit silently — the reply window has closed.

2. **Authorization.** Read `.claude-code-hermit/config.json` → `channels.<channel>.allowed_users` for the inbound channel (extract the channel name from the inbound message metadata):
   - If `allowed_users` exists and the sender's platform user ID is **not** in it: exit silently. No response, no log, no state write.
   - If `allowed_users` is absent: accept (backwards-compatible).
   - If `allowed_users` is `[]`: reject all — exit silently.

3. Parse the inbound message body (case-insensitive, leading/trailing whitespace stripped):

   ```
   ^(?:RPE\s*:?\s*)?(\d{1,2})(?:\s*/\s*10)?(?:[\s,:]+(.+))?$
   ```

   This matches: `7`, `7/10`, `RPE 7`, `RPE: 7`, `RPE:7`, `7 heavy legs`, `RPE 7, heavy legs`, `RPE: 7 heavy legs`.

   - Extract `rpe` (group 1) and `notes` (group 2, may be absent).
   - Validate `rpe` is an integer from 1 to 10 inclusive.
   - **Exclude bare `yes`, `no`, `y`, `n`** — those belong to the micro-approval branch in core's channel-responder.
   - If parse fails or validation fails: exit silently.

4. Read `.claude-code-hermit/state/activity-notes.json`, or use `{}` if absent. Write the entry:
   ```json
   {
     "<pending.activity_id>": {
       "rpe": <int>,
       "notes": <string or null>,
       "recorded_at": "<ISO 8601 with offset>"
     }
   }
   ```
   If an entry already exists for this activity_id, overwrite it silently.

5. Delete `.claude-code-hermit/state/strava-pending-rpe.json` so the same sync cannot bind twice.

6. Reply via the channel's `reply` tool with `{chat_id, text}`:
   ```
   Got it — RPE <rpe>/10 saved for <pending.name>.
   ```
