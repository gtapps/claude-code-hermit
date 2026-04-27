---
title: "Routine: Monday Planning Brief"
type: routine-prompt
created: 2026-04-25T00:00:00+00:00
tags: [routine, training]
---

# Routine: Monday Planning Brief
# Fires: Monday 09:30
# Purpose: Suggest the week's training structure based on last week's load

## Task

Read last week's training load from `state/strava-weekly-baselines.json` (written by weekly-load-review on Sunday). Generate a concrete weekly training plan suggestion and deliver it via the configured channel.

## Steps

1. Read `state/strava-weekly-baselines.json`. If missing or last entry is not from yesterday (Sunday), call `mcp__strava__get-recent-activities` with `perPage: 20` to compute last week's totals manually.
2. Read last week's totals: run km, run sessions, elevation, strength sessions, bike sessions.
3. Read the 4-week rolling average from the baseline file (or compute from available data).
4. Apply planning logic (see below) to generate a 5–7 day training structure.
5. Send a message via the configured channel. If no channel is configured, log the plan to SHELL.md Progress Log instead and skip the notification.
   ```
   🗓️ Week plan — [Mon date]
   Based on last week: [X]km running, [load flag]

   Suggested structure:
   Mon: [activity]
   Tue: [activity]
   Wed: [activity]
   Thu: [activity]
   Fri: [activity]
   Sat: [activity]
   Sun: [activity]

   Key session: [highlight the week's main workout]
   ```
6. Write the weekly plan to `.claude-code-hermit/compiled/weekly-plan-<YYYY-MM-DD>.md` (today's date) with frontmatter:
   ```yaml
   ---
   title: "Weekly Plan — <Mon date>"
   type: weekly-plan
   created: <ISO 8601>
   session: <current session ID from SHELL.md>
   tags: [weekly-plan, training]
   ---
   ```
   Body: the full 7-day schedule from Step 5, plus the load context and key session highlight.
7. Log one line to SHELL.md Progress Log and close session idle.

## Planning Logic

**If last week was a load spike (>25% above average):**
- Reduce total km by 15–20%
- Keep 1 quality session (tempo or intervals), rest easy
- Include at least 2 rest or active recovery days
- No long run (cap longest run at 10km)

**If last week was a load dip (>25% below average):**
- Return to baseline volume
- Include 1 quality session and 1 long run (if baseline includes long runs)
- Note: "Resuming normal training load"

**If last week was consistent with baseline:**
- Maintain volume
- If 3+ consecutive consistent weeks: add one progression element (e.g., +2km long run, or add one interval session)
- Standard week: 2 easy runs + 1 tempo or long run + 2–3 strength/bike sessions

**General rules:**
- Never plan 3 consecutive hard days
- Always include at least 1 full rest day
- If strength sessions have been low (<2/week), suggest adding one
- Do not make assumptions about race goals or injury history — note explicitly if those would change the plan
