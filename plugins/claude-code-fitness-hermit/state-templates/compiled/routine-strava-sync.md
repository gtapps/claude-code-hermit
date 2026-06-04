---
title: "Routine: Daily Strava Sync"
type: routine-prompt
created: 2026-04-25T00:00:00+00:00
tags: [routine, strava]
---

# Routine: Daily Strava Sync
# Fires: 21:30 every day
# Purpose: Detect new activities, log them, flag anomalies

## Task

Check for new Strava activities uploaded today. Compare against the last known activity ID stored in `state/strava-last-activity-id.txt` (create with "none" if missing).

## Steps

1. Call `mcp__strava__check-strava-connection`. If disconnected, alert the operator via the configured channel and stop. If no channel is configured, log the disconnection to SHELL.md Findings and stop.
2. Call `mcp__strava__get-recent-activities` with `perPage: 5`.
3. Read `state/strava-last-activity-id.txt` to get the last known ID. If the file doesn't exist, treat as "none".
4. Identify new activities (ID not seen before). If none: log "No new activities today." to SHELL.md Progress Log and close idle.
5. If any new activities are runs, call `mcp__strava__get-athlete-zones` once now and hold the zone boundaries in context for the steps below. (Call only once regardless of how many runs are new.)
6. For each new activity:
   - Log: date, type (run/ride/weight training), distance (km), duration, name
   - If it's a **run > 10km**: call `mcp__strava__get-activity-streams` with keys `heartrate,velocity_smooth,altitude,cadence`. Compute average HR zone distribution using the zone boundaries from Step 5. Flag if >30% time in Z4+.
   - If it's a **run on a day after a hard session (Z4+ flagged)**: note "recovery day recommended tomorrow".
   - If it's a **WeightTraining or Workout**: derive a fatigue tier from `moving_time` (already in the Step 2 payload, in seconds; divide by 60 for minutes) — `≥45 min → moderate`, `30–44 min → light`, `<30 min → none`. Track the highest tier seen across all new strength activities today (`moderate` > `light` > `none`).
   - If **no activity today** (0 new): check if yesterday also had 0 new. If 2+ consecutive rest days after a non-rest day, log: "2 consecutive rest days — intentional recovery or missed session?"
7. Write the highest new activity ID to `state/strava-last-activity-id.txt`.
8. For each new activity whose Strava `type` is `Run`, invoke `/claude-code-fitness-hermit:activity-deep-dive <id>` to produce a full coaching analysis.
   - Cap at 3: if more than 3 new runs exist, process the 3 most recent by ID.
   - If the cap is hit, log the skipped IDs to SHELL.md Progress Log: `Skipped deep-dive (cap): <id>, <id>, ...`
   - If a deep-dive invocation fails, log `Deep-dive failed: <id>` to SHELL.md Progress Log and continue. The cursor advanced at step 7, so failed analyses are not retried — the log is the only record.
9. Send a summary via the configured channel. Format:
   ```
   Daily sync: [X run Xkm, Y ride, Z weights]. [Flag if any]
   ⚠️ Strength session today [light|moderate] — monitor leg fatigue on tomorrow's run.   ← omit if tier is none or no strength activity
   Reply 'RPE 1-10 [notes]' to log perceived effort (e.g. '7, heavy legs').
   ```
   If no channel is configured, log the summary (without the RPE prompt) to SHELL.md Progress Log and proceed to step 10.
   - After a successful send, write `.claude-code-hermit/state/strava-pending-rpe.json` with the activity whose ID matches the cursor from step 7:
     ```json
     {"activity_id": <id>, "name": "<name>", "sport": "<Run|Ride|WeightTraining|…>", "synced_at": "<ISO 8601>"}
     ```
   - If the send failed or was skipped, do not write this file — a stale pending entry could bind a future RPE reply to unseen activities.
10. Close session idle.

## Anomaly Flags

- Run pace >30s/km slower than 30-day average → "Unusual pace — fatigue or easy day?"
- HR >10bpm above typical for given pace → "Elevated HR — check recovery"
- Run distance >20km on a weekday → "Long weekday run — deliberate?"
- 3+ consecutive days with activity, all Z3+ → "Accumulating load — rest day soon"
