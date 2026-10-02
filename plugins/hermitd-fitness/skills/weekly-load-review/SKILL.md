---
name: weekly-load-review
description: Review weekly training load against the rolling baseline and deliver a coaching summary.
---

# Weekly Training Load Review

## Goal

Pull the last 14 days of Strava activities and compute weekly training load summaries for this week (Mon–Sun) and the prior week (Mon–Sun). Compare against the 4-week rolling baseline stored in `state/strava-weekly-baselines.json` (create if missing).

## Steps

1. Call `mcp__strava__check-strava-connection`. If disconnected, alert the operator via the configured channel and stop. If no channel is configured, pipe the disconnection into `.hermit/bin/hermitd-run task note .hermit <id>` only inside an open record's turn (otherwise skip the note) and stop.
2. Call `mcp__strava__get-recent-activities` with `perPage: 30` to cover 14+ days.
3. Determine the two week boundaries: this week is the most recent Mon–Sun period ending today (Sunday); the prior week is the Mon–Sun before that. Compute the exact date ranges from today's date.
4. For each week compute:
   - Run: total distance (km), total elevation (m), session count
   - Bike: total distance (km), session count
   - Strength: session count, total duration in minutes as `strength_minutes` (sum `moving_time` over WeightTraining/Workout activities: already in the Step 2 payload, no extra call; `moving_time` is in seconds, so divide the sum by 60)
   - Total active days
   Also compute **load-adjusted run distance** (`adjusted_km`): for each run activity, derive
   `elev_gain_per_km = elevation_gain_m / distance_km` and apply a heuristic multiplier to account
   for the higher mechanical load of gradient (descents especially):
   `< 10 m/km → 1.0×` · `10 to < 25 m/km → 1.2×` · `25 to < 40 m/km → 1.35×` · `≥ 40 m/km → 1.5×`.
   Sum the adjusted distances to get the week's `adjusted_km`.
5. Read `state/strava-weekly-baselines.json` and `state/activity-notes.json` (or `{}` if absent) in the same turn. The baselines file is used in step 6; the activity notes will be used in step 8.
6. Compare this week's `adjusted_km` to the 4-week rolling average of `adjusted_km` from the
   baseline file. If any historical week lacks `adjusted_km`, use
   that week's raw `km` as its adjusted value for the rolling average.
   - >25% above average → 🔴 "Load spike: [Y]km (adj) vs [avg]km average"
   - >25% below average → 🟡 "Load dip: [Y]km (adj) vs [avg]km average"
   - Within range → 🟢 "Consistent load"
7. Update `state/strava-weekly-baselines.json`: append this week's totals, including `adjusted_km`
   alongside the existing raw `km`, and `strength_minutes`. Keep only the last 8 weeks.
8. From the activity list fetched in step 2, collect the IDs of this week's activities. Filter the `activity-notes.json` read in step 5 to those IDs. If 2 or more RPE entries exist, compute the average (one decimal place) and prepare the line: `💬 Avg RPE: X.X/10 (N=<count>)`. Otherwise prepare no RPE line.

   Send a message via the configured channel. If no channel is configured, pipe the summary into `.hermit/bin/hermitd-run task note .hermit <id>` only inside an open record's turn (otherwise skip the note) instead and skip the notification.
   Compose in the operator's configured voice, covering the weekly totals, load flag, available RPE, and next-week recommendation. Example shape:
   ```
   📅 Weekly review: w/e [date]
   🏃 Run: [X]km ([N] sessions, [E]m elev) → load-adj [Y]km [flag]
   🚴 Bike: [X]km ([N] sessions)
   💪 Strength: [N] sessions ([M] min)
   💬 Avg RPE: X.X/10 (N=3)           ← omit this line if fewer than 2 rated
   Next week: [one-sentence recommendation based on load]
   ```
9. Write the load summary to `.hermit/compiled/weekly-summary-<YYYY-MM-DD>.md` (today's date) with frontmatter:
   ```yaml
   ---
   title: "Weekly Summary: w/e <date>"
   type: weekly-summary
   created: <ISO 8601>
   task: <T-... for the open record in this turn; omit this field otherwise>
   tags: [weekly-summary, training]
   load_flag: <spike|dip|consistent>
   ---
   ```
   Body: the full week totals, load flag, and recommendation from Steps 4–6.
10. Pipe one line into `.hermit/bin/hermitd-run task note .hermit <id>` only inside an open record's turn (otherwise skip the note) and finish this workflow.

## Recommendation Logic

- Load spike: suggest an easier week (fewer hard sessions, one extra rest day)
- Load dip with prior spike: note "Recovery week: expected"
- Load dip with no prior spike: flag "Unplanned reduction: check in with operator"
- Consistent load 4+ weeks: suggest introducing a progression (longer long run, or faster tempo)
- No runs this week: "Zero running week: flag for operator attention"
