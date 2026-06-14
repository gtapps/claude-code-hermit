# Hermit Evolution — Evaluation Reference

This file is the instruction spec for the isolated-context subagent dispatched by SKILL.md.
The subagent reads files and runs scripts in a fresh context (no inherited session state), then
returns the assembled evolution report. The calling main session decides where to deliver it
(channel reply vs conversation) — this spec produces the report text, it does not send anything.

## Inputs (read fresh — do not reuse cached values)

The calling skill passes `plugin_root` (the resolved absolute plugin path) in the dispatch prompt. Substitute that value wherever `<plugin_root>` appears below. Do not use the `${CLAUDE_PLUGIN_ROOT}` token — it is not substituted in this file's content and is empty as a Bash variable.

Gracefully skip any file, glob, or script that doesn't exist or exits non-zero.

Steps are independent — read files and run scripts concurrently where possible.

1. `.claude-code-hermit/compiled/review-weekly-*.md` — glob all, sort by `week` frontmatter
   descending, read the 8 most recent. Extract per-file: `week`, `total_cost_usd`,
   `self_directed_rate`, `proposals_created`, `proposals_resolved`.
2. `.claude-code-hermit/cost-summary.md` — frontmatter `total_cost_usd` for the current partial
   week if the review file for it doesn't exist yet.
3. `.claude-code-hermit/state/proposal-metrics.jsonl` — scan from the end (most recent first); stop
   at entries older than 30 days. Use `resolved_at` and `created_at` to compute resolution days.
4. Run `bun <plugin_root>/scripts/proposal-metrics-report.ts .claude-code-hermit` and
   capture stdout. Skip gracefully if unavailable. (Steps 4 and 5 may run concurrently.)
5. Run `bun <plugin_root>/scripts/cost-reflect.ts .claude-code-hermit 30` and capture
   stdout. This produces a 30-day cost breakdown including a `### Cost by source` section. Skip
   gracefully if unavailable.
6. `.claude-code-hermit/config.json` — read `routines[]` (id, schedule, enabled), `monitors[]`
   (id, enabled), `heartbeat.every`.
7. `.claude-code-hermit/state/routine-metrics.jsonl` — count entries where `event == "fired"` per
   `routine_id` where `ts` is within the last 30 days.
8. `.claude-code-hermit/sessions/S-NNN-REPORT.md` files for the last 30 days — read Artifacts and
   Changed sections plus `proposals_created` and `operator_turns` frontmatter. List filenames in
   `.claude-code-hermit/compiled/` created in the last 30 days.
9. `.claude-code-hermit/OPERATOR.md` and `<plugin_root>/state-templates/OPERATOR.md` —
   read both.
10. List dirs under `.claude/skills/` in the target project root and under
    `<plugin_root>/skills/`.

## Analysis

**Cost:** From review files, extract `total_cost_usd` per week and show the 4 most recent as a
trend with Δ% between the two most recent weeks. If fewer than 2 reviews exist, note "not enough
data". From the step 5 output, locate the `### Cost by source` block and compute two buckets:
**scheduled** (sum of all `routine:*` and `heartbeat` lines) vs **interactive** (the `other`
line). Note that watches (Monitor tool) cost ~0 tokens when quiet and will not appear. If step 5
is unavailable, omit the split.

**Autonomy:** From review files, `self_directed_rate` (fraction of sessions with no operator
turns) for the latest week and Δ vs the prior week. If fewer than 2 reviews: "not enough data".

**Proposal velocity:** From `proposal-metrics.jsonl`, median days `created_at` → `resolved_at`
for proposals resolved in the last 30 days. From step 4 output, show the acceptance-by-source
table (rows with n>0 only). Note any triggered kill gates.

**Routines & watches:** From config.json, list enabled routines with their `schedule` cron
string. Cross-reference routine-metrics.jsonl to show fire counts for the last 30 days. List
enabled monitors and heartbeat cadence. Omit disabled entries.

**Top-3 produced (inferred):** From step 8, rank outputs by operator signal — prefer: (1)
proposals accepted or resolved, (2) compiled outputs cited in sessions with `operator_turns > 0`,
(3) sessions with Artifacts/Changed and `operator_turns = 0` (autonomous wins). Pick the top 3
and describe each in one line. Label: _inferred — no operator-used signal exists._

**Grown since hatch (approximated):** From step 9, diff `.claude-code-hermit/OPERATOR.md`
against the template and note sections the operator added or meaningfully filled in. From step 10,
list skill names present under `.claude/skills/` but absent from `<plugin_root>/skills/`
— those are organically created. Label: _approximated — no hatch baseline stored._

## Return Value

Assemble the report as a single `report` string, target ≤1500 chars. If data is abundant, drop
to one line per section rather than letting it balloon. Use this structure (omit sections with
no data rather than showing a heading with an empty body; keep each bullet to one line):

```
### Cost
- Trend (weekly): $A → $B → $C → $X (Δ +/-N%)
- Last 30d: $X.XX total — scheduled (routines/heartbeat): $Y (N%), interactive: $Z (N%)

### Autonomy
- Self-directed: N% this week (vs M% prior, Δ +/-N pp)

### Proposal velocity
- Median resolution: Nd (N proposals, last 30d)
[acceptance-by-source table, rows n>0 only; note triggered kill gates]

### Routines & watches
- heartbeat: every X
- <routine-id>: <cron> · fired N× in last 30d
- watch <monitor-id>: active

### Top-3 produced (inferred)
- <one-line description>
- <one-line description>
- <one-line description>
(inferred — no operator-used signal exists)

### Grown since hatch (approximated)
- OPERATOR.md: <sections added, or "no additions vs template">
- Skills: <project-local skill names, or "none">
(approximated — no hatch baseline stored)
```

Return a single JSON object — no prose, no markdown wrapping. The field is required.

<!-- hermit-evolution-eval-schema:start -->
```json
{
  "report": "<assembled ≤1500-char report, section structure above>"
}
```
<!-- hermit-evolution-eval-schema:end -->
