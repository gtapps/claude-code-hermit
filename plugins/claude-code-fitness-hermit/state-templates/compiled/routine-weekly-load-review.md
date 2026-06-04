---
title: "Routine: Weekly Training Load Review"
type: routine-prompt
created: 2026-04-25T00:00:00+00:00
tags: [routine, training]
---

# Routine: Weekly Training Load Review
# Fires: Sunday 18:00
# Purpose: Compute week-over-week load delta, flag trends, send a channel summary

## Task

Pull the last 14 days of Strava activities and compute weekly training load summaries for this week (Mon–Sun) and the prior week (Mon–Sun). Compare against the 4-week rolling baseline stored in `state/strava-weekly-baselines.json` (create if missing).

## Steps

1. Call `mcp__strava__check-strava-connection`. If disconnected, alert the operator via the configured channel and stop. If no channel is configured, log the disconnection to SHELL.md Findings and stop.
2. Call `mcp__strava__get-recent-activities` with `perPage: 30` to cover 14+ days.
3. Determine the two week boundaries: this week is the most recent Mon–Sun period ending today (Sunday); the prior week is the Mon–Sun before that. Compute the exact date ranges from today's date.
4. For each week compute:
   - Run: total distance (km), total elevation (m), session count
   - Bike: total distance (km), session count
   - Strength: session count, total duration in minutes as `strength_minutes` (sum `moving_time` over WeightTraining/Workout activities — already in the Step 2 payload, no extra call; `moving_time` is in seconds, so divide the sum by 60)
   - Total active days
   Also compute **load-adjusted run distance** (`adjusted_km`): for each run activity, derive
   `elev_gain_per_km = elevation_gain_m / distance_km` and apply a heuristic multiplier to account
   for the higher mechanical load of gradient (descents especially):
   `< 10 m/km → 1.0×` · `10 to < 25 m/km → 1.2×` · `25 to < 40 m/km → 1.35×` · `≥ 40 m/km → 1.5×`.
   Sum the adjusted distances to get the week's `adjusted_km`.
5. Read `state/strava-weekly-baselines.json` and `state/activity-notes.json` (or `{}` if absent) in the same turn. The baselines file is used in step 6; the activity notes will be used in step 8.
6. Compare this week's `adjusted_km` to the 4-week rolling average of `adjusted_km` from the
   baseline file. If any historical week lacks `adjusted_km` (written before this feature), use
   that week's raw `km` as its adjusted value for the rolling average.
   - >25% above average → 🔴 "Load spike: [Y]km (adj) vs [avg]km average"
   - >25% below average → 🟡 "Load dip: [Y]km (adj) vs [avg]km average"
   - Within range → 🟢 "Consistent load"
7. Update `state/strava-weekly-baselines.json`: append this week's totals, including `adjusted_km`
   alongside the existing raw `km`, and `strength_minutes`. Keep only the last 8 weeks.
8. From the activity list fetched in step 2, collect the IDs of this week's activities. Filter the `activity-notes.json` read in step 5 to those IDs. If 2 or more RPE entries exist, compute the average (one decimal place) and prepare the line: `💬 Avg RPE: X.X/10 (N=<count>)`. Otherwise prepare no RPE line.

   Send a message via the configured channel. If no channel is configured, log the summary to SHELL.md Progress Log instead and skip the notification.
   ```
   📅 Weekly review — w/e [date]
   🏃 Run: [X]km ([N] sessions, [E]m elev) → load-adj [Y]km [flag]
   🚴 Bike: [X]km ([N] sessions)
   💪 Strength: [N] sessions ([M] min)
   💬 Avg RPE: X.X/10 (N=3)           ← omit this line if fewer than 2 rated
   Next week: [one-sentence recommendation based on load]
   ```
9. Write the load summary to `.claude-code-hermit/compiled/weekly-summary-<YYYY-MM-DD>.md` (today's date) with frontmatter:
   ```yaml
   ---
   title: "Weekly Summary — w/e <date>"
   type: weekly-summary
   created: <ISO 8601>
   session: <current session ID from SHELL.md>
   tags: [weekly-summary, training]
   load_flag: <spike|dip|consistent>
   ---
   ```
   Body: the full week totals, load flag, and recommendation from Steps 4–6.
10. Log one line to SHELL.md Progress Log and close session idle.

## Recommendation Logic

- Load spike: suggest an easier week (fewer hard sessions, one extra rest day)
- Load dip with prior spike: note "Recovery week — expected"
- Load dip with no prior spike: flag "Unplanned reduction — check in with operator"
- Consistent load 4+ weeks: suggest introducing a progression (longer long run, or faster tempo)
- No runs this week: "Zero running week — flag for operator attention"
