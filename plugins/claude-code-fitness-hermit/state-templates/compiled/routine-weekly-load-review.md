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
   - Strength: session count
   - Total active days
5. Read `state/strava-weekly-baselines.json`. If it doesn't exist, create it with this week's data as the baseline and note "Baseline initialized — review again next week."
6. Compare this week's run distance to the 4-week rolling average from the baseline file:
   - >25% above average → 🔴 "Load spike: [X]km vs [avg]km average"
   - >25% below average → 🟡 "Load dip: [X]km vs [avg]km average"
   - Within range → 🟢 "Consistent load"
7. Update `state/strava-weekly-baselines.json`: append this week's totals. Keep only the last 8 weeks.
8. Send a message via the configured channel (max 5 lines). If no channel is configured, log the summary to SHELL.md Progress Log instead and skip the notification.
   ```
   📅 Weekly review — w/e [date]
   🏃 Run: [X]km ([N] sessions, [E]m elev) [flag]
   🚴 Bike: [X]km ([N] sessions)
   💪 Strength: [N] sessions
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
