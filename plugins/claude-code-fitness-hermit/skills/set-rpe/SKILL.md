---
name: set-rpe
description: Manually record RPE and subjective notes for a specific Strava activity. Use for backfilling, correcting entries, or rating a non-latest activity that the auto-capture skill skipped.
allowed-tools:
  - Read
  - Edit
  - Write
  - mcp__strava__get-recent-activities
---

# Set RPE

Records perceived effort and subjective notes for any Strava activity.

## Usage

```
/claude-code-fitness-hermit:set-rpe <activity-id|latest> <rpe> [notes...]
```

## Steps

1. Parse arguments:
   - First arg: activity ID (integer) or the literal string `latest`.
   - Second arg: RPE (must be an integer 1–10).
   - Remaining args: optional free-text notes. If absent or whitespace-only after join, set `notes` to `null`.
   - If `latest`: call `mcp__strava__get-recent-activities` with `perPage: 1` and use the returned activity's `id`.
   - If any required arg is missing or `rpe` is outside 1–10, respond with usage and stop.

2. Read `.claude-code-hermit/state/activity-notes.json`, or use `{}` if absent. Record the previous value for this activity_id if one exists.

3. Write the entry (create or overwrite). The `notes` field is always present: `null` when no notes were provided, never missing.
   ```json
   {
     "<activity_id>": {
       "rpe": <int>,
       "notes": <string|null>,
       "recorded_at": "<ISO 8601 with offset>"
     }
   }
   ```

4. Confirm:
   - If no prior entry: `"Saved RPE <rpe>/10 for activity <id>."`
   - If overwriting: `"Updated RPE for activity <id>. (was: RPE <old_rpe>/10 — <old_notes>)"`
