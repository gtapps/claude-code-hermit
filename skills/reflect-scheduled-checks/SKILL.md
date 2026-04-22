---
name: reflect-scheduled-checks
description: Scheduled-check sub-skill for reflect. Runs one due interval-triggered scheduled check and returns a structured result block. Called by reflect — not invoked directly by operators.
---
# Reflect Scheduled Checks

Sub-skill invoked by `claude-code-hermit:reflect` when `config.scheduled_checks` has entries with `trigger: "interval"`. Runs at most one check per invocation. Returns a structured result block consumed by reflect in the same turn.

## What counts as a scheduled check

Any skill that satisfies this contract can be registered in `config.scheduled_checks` — including a hermit author's own skills, not just skills from installed plugins:

- **Idempotent** — running it twice in a row is safe and produces the same result.
- **Returns findings or nothing** — either a concrete actionable/contextual observation, or silence. No partial state, no side effects on success.
- **No self-scheduling** — the skill does not invoke itself or register cron/routines; cadence is owned by `scheduled_checks.interval_days`.
- **Safe during reflect/session cadence** — short-running, read-mostly, does not block the caller.

## Inputs (passed by reflect)

Reflect passes this context when calling the skill:
- Current `config.json` `scheduled_checks` entries (filtered to `trigger: "interval"`, `enabled: true`)
- Current `state/reflection-state.json` `scheduled_checks` key (per-check state: `last_run`, `last_unavailable_at`, `consecutive_empty`)

If reflect does not pass this context, read it from the files directly.

## Steps

1. **Filter due checks:** from the `enabled: true`, `trigger: "interval"` entries, filter to those where the matching state entry has:
   - `last_run` null or older than `interval_days`, AND
   - `last_unavailable_at` null or older than `interval_days`

2. **Pick one:** the entry with the oldest `last_run` (null sorts first). If none are due, return an empty result (see Return Format below with `outcome: skipped`).

3. **Invoke:** call the `skill` command string as-is.
   - If Claude reports the skill is unavailable or not installed → `outcome: unavailable`
   - If the call errors or times out → `outcome: error`
   - Otherwise → evaluate the output

4. **Evaluate:**
   - Actionable improvement found → `outcome: actionable`, summarize in `findings`
   - Context improvement (e.g., CLAUDE.md fix) → `outcome: contextual`, summarize in `findings`
   - Nothing found → `outcome: empty`, `findings: none`

5. **Compute state_delta** for the checked entry:
   - `outcome: unavailable` → `last_run: null` (don't update), `last_unavailable_at: <today ISO>`, `consecutive_empty` unchanged
   - `outcome: error` → `last_run: null` (don't update), `consecutive_empty` unchanged
   - `outcome: empty` → `last_run: <today ISO>`, `consecutive_empty: <prior + 1>`
   - `outcome: actionable | contextual` → `last_run: <today ISO>`, `consecutive_empty: 0`
   - `outcome: skipped` → no state_delta

## Return Format

Return exactly one `SCHEDULED-CHECK-RESULT` block at the end of your response:

```
SCHEDULED-CHECK-RESULT
check: <id or "none">
outcome: actionable | contextual | empty | unavailable | error | skipped
findings: <one-line summary or "none">
provenance: scheduled-check/<id or "none">
state_delta_last_run: <ISO date or null>
state_delta_consecutive_empty: <integer or null>
state_delta_last_unavailable_at: <ISO date or null>
END-SCHEDULED-CHECK-RESULT
```

Use `null` for fields that should not be written (e.g., `last_run: null` on unavailable/error).

## How reflect consumes this block

Reflect:
1. Reads the result block.
2. For `actionable` / `contextual` outcomes: treats the findings as a proposal candidate tagged `Evidence Source: scheduled-check/<id>`, passes through the normal `reflection-judge` + `proposal-triage` gates. Context improvements may be applied directly if trivial.
3. For `empty` outcome: no candidate. Uses `consecutive_empty` from state_delta for interval-adjustment logic (stays in reflect — see reflect's Interval adjustment proposals section, which uses the normal Three-Condition Rule and is not tagged `scheduled-check`).
4. For `unavailable` / `error`: notes in SHELL.md Findings once. No candidate.
5. Applies state_delta to `state/reflection-state.json → scheduled_checks.<id>` as part of the consolidated State Update step (reflect writes this; the helper does NOT write state).
