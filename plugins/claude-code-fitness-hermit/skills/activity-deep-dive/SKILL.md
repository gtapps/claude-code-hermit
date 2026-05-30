---
name: activity-deep-dive
description: Per-activity coaching analysis from Strava. Computes zone breakdown, pace/HR efficiency, cardiac drift, recovery estimate; saves a compiled artifact and returns a compact summary. Run after a workout or to retro-analyze a specific activity.
allowed-tools:
  - Read
  - Write
  - Edit
  - mcp__strava__check-strava-connection
  - mcp__strava__get-athlete-zones
  - mcp__strava__get-recent-activities
  - mcp__strava__get-activity-details
  - mcp__strava__get-activity-laps
  - mcp__strava__get-activity-streams
---

# Activity Deep-Dive

Produces a standardised per-activity coaching note: zone breakdown, pace/HR efficiency, cardiac drift, recovery estimate, and a coaching note. Saves a compiled artifact and returns a compact summary.

## Usage

```
/claude-code-fitness-hermit:activity-deep-dive <activity-id>
/claude-code-fitness-hermit:activity-deep-dive latest
```

## Steps

1. Call `mcp__strava__check-strava-connection` — abort if disconnected.
2. Fetch athlete zones via `mcp__strava__get-athlete-zones` (needed for zone calculations).
3. Resolve activity:
   - If `"latest"`: call `mcp__strava__get-recent-activities` with limit 1, extract the activity ID.
   - Otherwise: use the provided activity ID directly.

3b. Read `.claude-code-hermit/state/activity-notes.json`. If the file exists and contains an entry for the resolved activity ID, hold `rpe` and `notes` in context for steps 6 and 7.

4. Issue all four calls in a single turn so they execute concurrently:
   - `mcp__strava__get-activity-details` — name, type, date, distance, duration, avg/max HR, avg pace, elevation
   - `mcp__strava__get-activity-laps` — lap splits
   - `mcp__strava__get-activity-streams` with keys `heartrate,velocity_smooth,altitude,cadence` (add `watts` if sport type is Ride — use `altitude,cadence` as the baseline keys and add `watts` only when sport type is known to be Ride)
   - `mcp__strava__get-recent-activities` with `perPage: 5` — for the pace/HR efficiency comparison below (filter by sport type after all results arrive)
5. Compute metrics:

   **Zone breakdown** — from HR stream vs athlete zone boundaries. Calculate % of stream datapoints in each zone (Z1–Z5). If HR stream absent: note "HR data unavailable".

   **Pace/HR efficiency** — average pace (min/km) divided by average HR. Lower = more efficient. From the `get-recent-activities` result fetched in Step 4: filter for activities of the same sport type, exclude the current activity ID, take up to the 4 most recent. Compute the same ratio for each. Report delta vs prior mean.

   **Cardiac drift** — compare average HR in first 20% of HR stream vs last 20%. Flag if difference > 10 bpm at similar pace (± 15 sec/km). Report: `drift: +N bpm`.

   **Recovery estimate** (scale 1–5):
   - 1 = easy (< 5% Z3+, avg HR < Z3 floor, < 60 min)
   - 2 = moderate (5–20% Z3, < 60 min)
   - 3 = quality (20–50% Z3, or any Z4, < 90 min)
   - 4 = hard (> 50% Z3 or > 10% Z4, or > 90 min hard)
   - 5 = race-level (> 20% Z4+, or peak HR > 95% max)
   Include recommended recovery window: 1→24h, 2→36h, 3→48h, 4→72h, 5→5–7 days.

   **Coaching note** — 2–3 sentences grounded in the numbers. Highlight what was executed well and one concrete thing to monitor or adjust next time. Reference specific metrics (e.g. "cardiac drift of +14 bpm suggests pacing started too hot").

6. Format output (8–10 lines):
```
Activity: <name> | <date> | <distance>km in <duration>
Zones: Z1 N% / Z2 N% / Z3 N% / Z4 N% / Z5 N%
Pace/HR efficiency: X.XX min·km⁻¹·bpm⁻¹ (vs prior 4: ±X%)
Cardiac drift: +N bpm (flag if > 10 bpm)
Recovery: N/5 — recommended rest: Xh
Subjective: RPE N/10 — <notes>          ← include only when RPE data exists from step 3b
Coaching: <2–3 sentences>
```

7. Save compiled artifact to `.claude-code-hermit/compiled/activity-<id>-<YYYY-MM-DD>.md`:
```yaml
---
title: "Activity Note — <name> <date>"
type: activity-note
created: <ISO 8601>
session: <current session ID from SHELL.md>
source: manual
tags: [activity-analysis]
activity_id: <id>
sport_type: <Run|Ride|WeightTraining|…>
rpe: <int>                               # include only when RPE data exists from step 3b
subjective_notes: "<string>"             # include only when notes exist from step 3b
---
```
Body: the full output above.

7b. Write signal-only coaching observations to `.claude-code-hermit/sessions/SHELL.md` Findings.

   From the computed metrics and coaching note, derive 0–N observations that carry a coaching signal worth tracking across sessions: a flagged cardiac drift, a zone-distribution anomaly, a recovery estimate that conflicts with subjective RPE, an efficiency regression vs the prior mean. Do NOT write routine confirmations ("session completed normally") unless they represent a pattern break. If nothing clears the signal bar, skip this step.

   First `Read` `.claude-code-hermit/sessions/SHELL.md` (Edit requires the file in context, and you need its current `## Findings` content to dedup). For each qualifying observation, anchor on the HTML comment and append one line:

   ```
   old_string: "<!-- Anything unexpected found during work. Proposal-worthy items get their own file. -->"
   new_string:  "<!-- Anything unexpected found during work. Proposal-worthy items get their own file. -->\nCoaching observation [<label>] (activity <id>): <one-line description grounded in a specific metric>"
   ```

   Skip the append if a line with the same `[<label>] (activity <id>)` already exists in `## Findings`; re-running the deep-dive must not duplicate observations. If the anchor comment is absent (operator edited SHELL.md), append directly under the `## Findings` heading instead.

   Labels are kebab-case and reused across sessions for consistency. Prefer an existing label over inventing a synonym. Seed vocabulary: `cooldown-hr-elevated`, `vo2max-stimulus-confirmed`, `cardiac-drift-high`, `interval-pacing-inconsistent`, `recovery-insufficient`, `efficiency-regression`. Add a new kebab-case label only when none fit.

   These lines feed reflect's `current-session` evidence path; the label convention lets reflect recognize recurrence across sessions, and recurring observations graduate to proposals through the normal `reflection-judge` / `proposal-triage` gates.

8. Return the formatted output to the caller.
