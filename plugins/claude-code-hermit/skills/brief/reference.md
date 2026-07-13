# Brief — Evaluation Reference

This file is the instruction spec for the isolated-context subagent dispatched by `brief/SKILL.md`.
The subagent reads only files (no inherited session context) and returns the structured JSON
below; the calling main session composes and delivers the brief.

## Inputs (read fresh — do not reuse cached values)

- `.claude-code-hermit/sessions/S-*-REPORT.md` — archived session reports (today's or latest, depending on mode)
- `.claude-code-hermit/cost-summary.md` — yesterday, week, and all-time cost aggregates
- `.claude-code-hermit/proposals/PROP-*.md` — frontmatter only (leading `---` YAML block); for pending-review scan
- `.claude-code-hermit/OPERATOR.md` — operator priorities (morning only; skip silently if absent)
- `.claude-code-hermit/NEXT-TASK.md` — queued work (morning only; skip silently if absent)

The calling skill passes the following scalars in the dispatch prompt (do not re-read from files):

- `mode` — one of: `morning`, `evening`, `daily`, `default-no-session`
- `today` — ISO date string (e.g. `2026-06-14`)
- `context_recovery` — `true` or `false` (morning only: main judged auto-memory sparse)

## Per-mode Instructions

### morning

1. Read `.claude-code-hermit/cost-summary.md`. Find the trend table row whose Date column matches
   the day before `today`. Populate `cost_context.yesterday` as
   `"Yesterday: <Cost> (<Tokens>) across <Sessions> sessions"`, copying the Cost, Tokens, and
   Sessions cells from that row **verbatim** (e.g. `"Yesterday: $1189.14 (532M tokens) across
   44 sessions"`) — do not reformat the token count. Set `cost_context.week` and
   `cost_context.all_time` to `null`.
2. Scan `.claude-code-hermit/proposals/PROP-*.md` — read the leading `---` YAML block only for
   each file. Collect files where `status: proposed` AND `source: auto-detected`. Populate
   `pending_proposals` as `["PROP-NNN: <title>", ...]`. Empty list if none.
3. Read `.claude-code-hermit/OPERATOR.md` if it exists. Extract actionable priority items
   (bullet points, numbered items, any section labelled "Priorities", "TODO", or "Current Focus").
   Populate `operator_priorities` as a list of strings. Empty list if absent or no priorities found.
4. Read `.claude-code-hermit/NEXT-TASK.md` if it exists. Extract the queued items. Populate
   `queued_work` as a list of strings. Empty list if absent.
5. If `context_recovery` is `true`: find the most recent `.claude-code-hermit/sessions/S-*-REPORT.md`
   (highest numbered) and read its YAML frontmatter: `date`, `tags`, `task` (Working-on/Goal), `status`,
   `cost_usd`/`tokens` (session cost), and `next_start` (Next Start Point). Populate `report_summary`
   from those fields. A report whose frontmatter lacks the `next_start` key is legacy — read it in full
   instead and extract the same fields from `## Summary`/`## Overview` and the session-cost line, as
   before. Set `report_summary: null` if `context_recovery` is `false`.
6. Set `sessions_today: []`, `findings: []`, `tomorrow: []`.

### evening

1. Sort `.claude-code-hermit/sessions/S-*-REPORT.md` by filename descending. Collect reports
   where the `date:` YAML frontmatter field matches `today` (or, for pre-Observatory reports,
   where `## Summary` contains that date). Read each collected report's YAML frontmatter; a
   report whose frontmatter lacks the `next_start` key is legacy — read its body in full instead.
2. For each collected report: produce one entry in `sessions_today` with `session: S-NNN` and
   a one-line `summary` (the `task` field; for a legacy report, the Working-on/Goal line or first
   sentence of `## Summary`).
3. Aggregate `findings`: for a legacy report, collect bullet points from its `## Findings` section
   (or `## Key Findings`) as before. For a non-legacy report, Grep the file for `^## (Key )?Findings`
   with a bounded `-A` to extract just that section rather than reading the full body. Deduplicate
   across reports. Populate as a list of strings.
4. Aggregate `tomorrow`: collect the `next_start` field from each collected report; for a legacy
   report, collect items from its `## Next Steps`, `## Tomorrow`, or equivalent future-looking
   section instead. Populate as a list of strings.
5. Set `report_summary: null`, `cost_context: null`, `pending_proposals: []`, `operator_priorities: []`, `queued_work: []`.

### daily

1. Same report collection as evening (steps 1–4): collect reports with `date:` matching `today`,
   frontmatter first (legacy reports in full), populate `sessions_today`, `findings`, `tomorrow`.
2. Read `.claude-code-hermit/cost-summary.md`. Populate `cost_context.week` and
   `cost_context.all_time` as `"$X.XX (<Tokens> tokens) across N sessions"`, copying the Cost and
   Sessions values and the already magnitude-suffixed Tokens figure from the `## This Week` and
   `## All Time` sections **verbatim** (e.g. `"$1189.14 (532M tokens) across 44 sessions"`) — do
   not reformat or rescale the token count. Set `cost_context.yesterday` to `null` (today's live
   cost runs in the calling main session via `today-cost.ts`).
3. Set `report_summary: null`, `pending_proposals: []`, `operator_priorities: []`, `queued_work: []`.

### default-no-session

1. Find the most recent `.claude-code-hermit/sessions/S-*-REPORT.md` (highest numbered). Read its
   YAML frontmatter: `date`, `tags`, `task` (Working-on/Goal), `status`, `cost_usd`/`tokens`
   (session cost), `next_start` (Next Start Point). Populate `report_summary` from those fields.
2. A report whose frontmatter lacks the `next_start` key is legacy — read it in full instead and
   extract the same fields from `## Summary`/`## Overview` and the session-cost line, as before.
3. Set `sessions_today: []`, `findings: []`, `tomorrow: []`, `cost_context: null`,
   `pending_proposals: []`, `operator_priorities: []`, `queued_work: []`.

## Return Value

Return a single JSON object — no prose, no markdown wrapping. Every field is required; use
`null`/`[]` for fields not relevant to the active mode.

<!-- brief-eval-schema:start -->
```json
{
  "report_summary": { "date": "<ISO>", "tags": ["<tag>"], "working_on": "<one-line>",
                       "status": "<completed|partial|blocked>", "cost_line": "<$X.XX (N tokens)>",
                       "next_start_point": "<text>" }|null,
  "sessions_today": [ { "session": "S-NNN", "summary": "<one-line>" } ],
  "findings": ["<text>"],
  "tomorrow": ["<text>"],
  "cost_context": { "yesterday": "<text>"|null, "week": "<text>"|null, "all_time": "<text>"|null }|null,
  "pending_proposals": ["<PROP-NNN: title>"],
  "operator_priorities": ["<text>"],
  "queued_work": ["<text>"]
}
```
<!-- brief-eval-schema:end -->
