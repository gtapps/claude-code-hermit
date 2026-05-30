---
name: activity-deep-dive
description: Per-activity coaching analysis from Strava. Detects interval vs steady-state sessions and branches the metrics accordingly. Computes zone breakdown and recovery estimate; saves a compiled artifact and returns a compact summary. Run after a workout or to retro-analyze a specific activity.
allowed-tools:
  - Read
  - Write
  - mcp__strava__check-strava-connection
  - mcp__strava__get-athlete-zones
  - mcp__strava__get-recent-activities
  - mcp__strava__get-activity-details
  - mcp__strava__get-activity-laps
  - mcp__strava__get-activity-streams
---

# Activity Deep-Dive

Produces a standardised per-activity coaching note. Detects interval vs steady-state sessions and branches accordingly: interval sessions get work-interval HR progression and between-bout recovery quality; steady sessions get pace/HR efficiency and cardiac drift. Both get zone breakdown, recovery estimate, and a coaching note. Saves a compiled artifact and returns a compact summary.

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

4. Issue the following three calls in a single turn so they execute concurrently:
   - `mcp__strava__get-activity-details` — name, type, date, distance, duration, avg/max HR, avg pace, elevation
   - `mcp__strava__get-activity-laps` — lap splits
   - `mcp__strava__get-activity-streams` with keys `heartrate,velocity_smooth,altitude,cadence` (add `watts` if sport type is Ride — use `altitude,cadence` as the baseline keys and add `watts` only when sport type is known to be Ride)

4b. **Classify session kind** — using the lap data and HR stream already fetched:

   - **Primary signal (HR alternation):** does the HR stream show ≥ 3 repeated high→low→high cycles?
     Divide the stream into segments aligned with laps (or into 8–12 equal windows if lap data is sparse).
     If alternating segments show a ≥ 15 bpm differential between "work" and "recovery" phases, the
     session is a candidate for `interval`.
   - **Corroborating (lap clustering):** do laps cluster into two groups — high-HR laps and low-HR
     laps — with the groups alternating?
   - **Default to `steady`** when the alternation pattern is absent or ambiguous (e.g. a tempo run
     with gradually rising HR, a progression run, or a steady run with 1 km auto-laps that have
     flat HR across all laps).
   - Hold the result as `session_kind` (`interval` or `steady`) and the interval structure —
     `N` work bouts (the high-HR lap group identified by the clustering signal) and their avg
     duration in minutes — for steps 5 and 6.

5. Compute metrics:

   **Zone breakdown** — from HR stream vs athlete zone boundaries. Calculate % of stream datapoints in each zone (Z1–Z5). If HR stream absent: note "HR data unavailable".

   **Pace/HR efficiency** *(steady sessions only)* — average pace (min/km) divided by average HR.
   Lower = more efficient. Call `mcp__strava__get-recent-activities` with `perPage: 5` now (only
   needed for this metric): filter for activities of the same sport type, exclude the current
   activity ID, take up to the 4 most recent. Compute the same ratio for each. Report delta vs
   prior mean.

   **Cardiac drift** *(steady sessions only)* — compare average HR in first 20% of HR stream vs last
   20%. Flag if difference > 10 bpm at similar pace (± 15 sec/km). Report: `drift: +N bpm`.

   **Work-interval HR progression** *(interval sessions only)* — per-lap avg HR across work laps
   in sequence (e.g. `I1 157 → I4 168 bpm — progressive ✓`). Include the activity `max HR`
   (from `get-activity-details`) to note the peak bout (e.g. "peaked at 174 bpm on I3"). Use
   activity `max HR` as HRmax — do NOT use the Z5 floor from `get-athlete-zones` as HRmax.

   **Recovery between intervals** *(interval sessions only)* — using per-lap avg HR for recovery
   laps: did HR return toward a recovery zone (Z1–Z2) between bouts? Report as a qualitative
   observation (e.g. "recovered to ~130 bpm between bouts — adequate" or "incomplete recovery:
   HR only dropped to 155 bpm before next bout").

   **Recovery estimate** (scale 1–5):
   - 1 = easy (< 5% Z3+, avg HR < Z3 floor, < 60 min)
   - 2 = moderate (5–20% Z3, < 60 min)
   - 3 = quality (20–50% Z3, or any Z4, < 90 min)
   - 4 = hard (> 50% Z3 or > 10% Z4, or > 90 min hard)
   - 5 = race-level (> 20% Z4+, or peak HR > 95% max)
   Include recommended recovery window: 1→24h, 2→36h, 3→48h, 4→72h, 5→5–7 days.

   **Coaching note** — 2–3 sentences grounded in the numbers. Highlight what was executed well and one concrete thing to monitor or adjust next time. Reference specific metrics (e.g. "cardiac drift of +14 bpm suggests pacing started too hot").

6. Format output (8–10 lines):

   **Steady session:**
   ```
   Activity: <name> | <date> | <distance>km in <duration>
   Session type: Steady
   Zones: Z1 N% / Z2 N% / Z3 N% / Z4 N% / Z5 N%
   Pace/HR efficiency: X.XX min·km⁻¹·bpm⁻¹ (vs prior 4: ±X%)
   Cardiac drift: +N bpm (flag if > 10 bpm)
   Recovery: N/5 — recommended rest: Xh
   Subjective: RPE N/10 — <notes>          ← include only when RPE data exists from step 3b
   Coaching: <2–3 sentences>
   ```

   **Interval session:**
   ```
   Activity: <name> | <date> | <distance>km in <duration>
   Session type: Interval (N×~Xmin)
   Zones: Z1 N% / Z2 N% / Z3 N% / Z4 N% / Z5 N%
   Intervals: I1 NNNbpm → IN NNNbpm — <progressive ✓ / regressive / flat>; peaked at NNNbpm on IN
   Between-bout recovery: HR to ~NNNbpm — <adequate / incomplete>
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
session_kind: <interval|steady>
rpe: <int>                               # include only when RPE data exists from step 3b
subjective_notes: "<string>"             # include only when notes exist from step 3b
---
```
Body: the full output above.

8. Return the formatted output to the caller.
