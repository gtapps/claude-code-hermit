---
name: weekly-coaching-patterns
description: "Interval scheduled check — detects multi-session cardiac-drift trends across recent compiled activity notes. Runs weekly via the scheduled-checks routine; findings are routed through the proposal pipeline as Evidence Source: scheduled-check/weekly-coaching-patterns."
---

# Weekly Coaching Patterns

Scheduled-check skill: reads the last 4 `compiled/activity-*.md` artifacts for steady sessions and detects whether cardiac drift is trending upward over time. Returns a fixed findings block for `reflect --scheduled-checks` to classify and route.

**Contract:** idempotent, read-only, no self-scheduling, short-running. Returns findings or silence — never creates proposals itself.

## Steps

1. **Glob activity notes.** Use `Glob` on `.claude-code-hermit/compiled/activity-*.md`. If no files match, output the zero-findings block (Step 5, no-trend path) and stop.

2. **Read and filter.** For each matched file, Read it. Keep only entries where the YAML frontmatter has `type: activity-note` AND `session_kind: steady`. Sort by `created` date descending (most recent first). Take the 4 most recent steady sessions.

   If fewer than 4 steady sessions exist across all artifacts, output the zero-findings block and stop. This is expected on weeks with predominantly interval or strength training — insufficient data is not an error.

3. **Extract cardiac-drift values.** Working oldest-to-newest (reverse the most-recent-first list), for each of the 4 steady sessions parse the body for a line starting with `Cardiac drift:`. Extract the **signed** integer bpm value, preserving the sign (`+12` → `+12`, `-5` → `-5`). A negative value means HR fell over the session (an improving signal) and must compare as less than any positive value — never strip the sign to magnitude. Treat a missing line as no data and exclude that session from the series.

   If fewer than 4 values are extractable after exclusions, output the zero-findings block and stop.

4. **Evaluate the drift trend.** A trend **holds** when the 4 values are strictly increasing oldest-to-newest — every value greater than the one immediately before it (all 3 adjacent pairs rising). A single flat or falling pair breaks the trend. This is a deliberately strict bar for v1: a clean monotonic rise is unambiguous and avoids false positives from noisy week-to-week variation.

   **Anti-duplication guard:** emit a finding ONLY for this quantitative upward numeric trend across the 4-session bpm series. Do NOT emit on label recurrence alone.

5. **Output the findings block.** Always output a plain-text findings block to stdout, regardless of outcome. `reflect --scheduled-checks` classifies the result from this block.

   **Trend holds (4 values strictly rising):**
   ```
   weekly-coaching-patterns findings — <YYYY-MM-DD>
   Coaching patterns: 1
   - Coaching pattern detected [cardiac-drift-high]: cardiac drift rising across 4 consecutive steady sessions (<V1>→<V2>→<V3>→<V4> bpm) — check pacing strategy and hydration; consider an easy recovery run next session
   ```
   Replace `<V1>`…`<V4>` with the four drift values oldest-to-newest (each rendered with its sign, e.g. `+6`), and `<YYYY-MM-DD>` with today's date.

   **No trend (including insufficient data):**
   ```
   weekly-coaching-patterns findings — <YYYY-MM-DD>
   No actionable findings.
   ```

   The `[cardiac-drift-high]` label reuses the seed vocabulary from `activity-deep-dive` step 7b — no new label is introduced.

## Example

Four steady sessions, oldest-to-newest, with drift lines `+4`, `+7`, `+9`, `+13`:

```
weekly-coaching-patterns findings — 2026-05-31
Coaching patterns: 1
- Coaching pattern detected [cardiac-drift-high]: cardiac drift rising across 4 consecutive steady sessions (+4→+7→+9→+13 bpm) — check pacing strategy and hydration; consider an easy recovery run next session
```

The same four sessions with values `+4`, `+7`, `+6`, `+13` do **not** hold (the `+7→+6` pair falls), so the output is the `No actionable findings.` block. A series of `-3`, `+1`, `+5`, `+9` **does** hold (every pair rises; the leading negative compares as smallest).

## Extend-if-useful (not in v1)

The following metrics follow the same steady-session pattern and would add items to the Coaching patterns list. NOT implemented in v1 — cardiac drift alone proves the mechanism end-to-end.

- **Z2 pace/HR efficiency slope** — extract `Pace/HR efficiency: X.XX min·km⁻¹·bpm⁻¹` from each artifact; detect a strictly declining trend across the 4 steady sessions. Label: `efficiency-regression`.
- **Recovery-score trend** — extract `Recovery: N/5` from each artifact (applies to both steady and interval sessions); detect a strictly hardening trend across the 4 sessions. Label: `recovery-insufficient`.

## Notes

- **This skill writes no artifact.** All output goes to stdout for `reflect --scheduled-checks` to classify and route. Runtime state (`last_run`, `consecutive_empty`, etc.) is written by `reflect --scheduled-checks` to `state/reflection-state.json → scheduled_checks.weekly-coaching-patterns` — not by this skill.
- **Registered by `/claude-code-fitness-hermit:hatch`** step 8c via a `scheduled_checks` config entry (`interval_days: 7`). The core daily `scheduled-checks` routine fires `reflect --scheduled-checks`, which picks it up once 7+ days have elapsed since `last_run`.
- **The `[cardiac-drift-high]` label has two upstream producers.** `activity-deep-dive` step 7b writes single-session observations (graduated to proposals via reflect's current-session path); this skill emits on a multi-session trend. Both flow into `proposal-triage`, which dedups — so a triage `DUPLICATE` verdict here is expected behavior, not a bug.
