# Reflect — Evaluation Reference

This file is the instruction spec for the isolated-context subagent dispatched by SKILL.md step 6.
The subagent reads only files (no inherited session context); writes and notifications are handled by the
calling main session after it receives the subagent's structured JSON return value. Where an instruction
below says "update frontmatter", "append metrics", "write SHELL.md finding", or "note in Findings",
populate the corresponding field in the return JSON instead — the main session applies those actions.

## Inputs (read fresh — do not reuse cached values)

- `.claude-code-hermit/state/reflection-state.json` — for `last_resolution_check`, `last_sparse_nudge`
- `.claude-code-hermit/proposals/PROP-*.md` — for accepted proposals (Resolution Check)
- `.claude-code-hermit/sessions/S-*-REPORT.md` — 3 most recent (read full bodies)
- `.claude-code-hermit/state/routine-metrics.jsonl` — last 400 lines (routine check)
- `.claude-code-hermit/state/channel-replies.jsonl` — last 200 lines (engagement check; skip if absent)
- `.claude/cost-log.jsonl` — last 200 lines (cost join; project root, sibling of `.claude-code-hermit/` — not nested under it)
- `MEMORY.md` — operator's auto-memory index (procedure detection)

The calling skill passes `phases_json` (the precheck output object listing which phases are due) and
`last_resolution_check` (the cursor from reflection-state.json) in the dispatch prompt. Read them from
the prompt; do not re-read reflection-state.json for the cursor (the main session already read it).
It also passes `plugin_root` (the resolved absolute plugin path) — substitute it for `<plugin_root>`
below. Do not use the `${CLAUDE_PLUGIN_ROOT}` token: it is not substituted in this file's content and
is empty as a Bash variable.

## Step 1 — Resolution Check

Run this step only if `resolution_check` is listed in `phases_json`.

**a.** Read all proposals with `status: accepted` from `.claude-code-hermit/proposals/PROP-*.md`.
   Sort by `accepted_date` ascending. Resume from the proposal after `last_resolution_check` (the cursor
   passed in the dispatch prompt), wrapping around. Take up to 5.

**b.** If the accepted list is empty, skip to the return value (emit `resolution_actions: []`).

**c.** For each proposal: read `title`, `success_signal`, `accepted_in_session`, `accepted_date`,
   `tags`, `related_sessions`, and the Evidence section.

   **If `success_signal` is non-null** — run the predicate:
   ```
   bun <plugin_root>/scripts/eval-success-signal.ts .claude-code-hermit "<accepted_date>" "<accepted_in_session|null>" "<success_signal>"
   ```
   Parse the one JSON line on stdout. Branch on `verdict`:
   - `INSUFFICIENT_DATA` → skip; add nothing to `resolution_actions` for this proposal.
   - `MET` → auto-resolve. Populate one `resolution_actions` entry:
     ```json
     { "proposal_id": "PROP-NNN",
       "action": "auto-resolve",
       "frontmatter_patch": { "status": "resolved", "resolved_date": "<now ISO>" },
       "metrics_event": "{\"ts\":\"<now ISO>\",\"type\":\"resolved\",\"proposal_id\":\"PROP-NNN\"}",
       "shell_findings_line": "PROP-NNN resolved — success signal met: avg session cost $<observed> over <sessions_counted> sessions (target <op> $<threshold>)." }
     ```
   - `UNMET` → nudge if debounce allows. Check `last_sparse_nudge.<PROP-NNN>` (from dispatch prompt or
     reflection-state.json if not in prompt). If present and < 7 days elapsed, skip (add nothing).
     Otherwise, populate one `resolution_actions` entry:
     ```json
     { "proposal_id": "PROP-NNN",
       "action": "nudge",
       "frontmatter_patch": null,
       "metrics_event": null,
       "shell_findings_line": "PROP-NNN success signal NOT met: avg session cost $<observed> over <sessions_counted> sessions (target <op> $<threshold>). Run /claude-code-hermit:proposal-act resolve|dismiss PROP-NNN, or revise." }
     ```

   **If `success_signal` is null** — use the prose pattern-absence test:

   Read the 3 most recent `sessions/S-*-REPORT.md` files in full (sort descending by filename, read the
   top 3). Do NOT truncate bodies — if a file exceeds your read window, note truncation explicitly
   per file rather than silently trimming.

   **Same-area guard (absence must be meaningful):** before counting absence, establish work-area overlap —
   collect the proposal's `tags` plus the `tags:` frontmatter of its `related_sessions` reports into a
   tag pool; at least one of the 3 checked sessions must share ≥1 tag from that pool (fallback when the
   pool is empty: a proposal-title keyword match in a session body). If none of the 3 sessions overlaps,
   the absence is vacuous — skip this proposal (add `action: "skip"` to `resolution_actions`).

   **Compute original cadence:** for each report in `related_sessions`, read its `date:` frontmatter.
   `original_cadence_days = max(date) - min(date)` in whole days. Single session → 0. Unreadable /
   empty `related_sessions` → treat as **sparse**.

   If the pattern IS present in any of the 3 sessions: add `action: "skip"`, no other fields.

   If the pattern is **absent** from all 3:
   - **Frequent** (`original_cadence_days ≤ 14`) and ≥ 14 days elapsed since `accepted_date`:
     → auto-resolve (same entry shape as `MET` branch above, `metrics_event` type: `"resolved"`).
   - **Sparse** (`original_cadence_days > 14`) and elapsed ≥ `2 × original_cadence_days` since
     `accepted_date` and debounce allows (same `last_sparse_nudge` check as UNMET branch):
     → nudge (populate `shell_findings_line`:
     `"PROP-NNN appears resolved (pattern absent 3/3 recent sessions, original cadence Nd, Xd since accept). Run /claude-code-hermit:proposal-act resolve PROP-NNN to confirm."`)
   - Elapsed guard not yet met: add `action: "skip"`, no other fields.

**d.** Set `last_resolution_check` in the return value to the last PROP-NNN checked (or null if the
   batch was empty).

**e.** Set the top-level `last_sparse_nudge` return field to the union of every proposal nudged this
   run: for each `resolution_actions` entry with `action: "nudge"` (both the UNMET and sparse-pattern
   branches above), add `{ "PROP-NNN": "<now ISO>" }`. Emit `{}` if no proposal was nudged. This
   top-level map is the only nudge write-back — the calling session merges it into `reflection-state.json`
   to honour the 7-day debounce. Do not return nudge timestamps inside the individual `resolution_actions`
   entries; only the top-level map is read.

## Step 2 — Routine Check

Run this step only if `session_state` in `.claude-code-hermit/state/runtime.json` is `idle` (the
calling skill reads runtime.json in main; the dispatch prompt may pass this). If not in idle state,
emit `routine_candidates: []` and skip this step.

**Errored-routine detection:**

Read the last 400 lines of `state/routine-metrics.jsonl` via `Bash` (e.g. `tail -400`). Parse
per-line with JSON.parse, skipping malformed lines. Count entries where `event == "fired"` and where
`event == "started"` per `routine_id` where `ts` falls within the last 14 days.

`errored = count(started) − count(fired)` per `routine_id`. If `errored >= 2` for any routine,
produce a `routine_candidates` entry:
```json
{ "routine_id": "<id>", "action": "diagnostic", "tier": 1, "schedule": null,
  "evidence": "routine '<id>' fired but errored before completion N× in the last 14 days",
  "sessions": [],
  "shell_findings_line": "routine '<id>' fired but errored before completion N× in the last 14 days — its output and cost are unattributed." }
```

**Uncited-routine detection:**

For each routine with ≥5 fires in the last 14 days: read the 3 most recent `sessions/S-*-REPORT.md`
(reuse the bodies already read in Step 1 if available). If no session report cites the routine's
`routine_id` or skill output as producing findings, decisions, or follow-ups — apply the
Three-Condition Rule:
1. Repeated pattern: ≥5 fires with zero citation.
2. Meaningful consequence: routine runs but produces no downstream effect.
3. Operator-actionable: disable or reschedule.
If all three hold, produce a `routine_candidates` entry with `action: "disable"` or `"retime"` (prefer
retime if timing mismatch is apparent from `fired` timestamps vs. session activity times):
```json
{ "routine_id": "<id>", "action": "disable", "tier": 1, "schedule": null,
  "evidence": "<fire count + window + citation count>",
  "sessions": ["<S-NNN>", ...],
  "shell_findings_line": null }
```

**Channel-engagement detection:**

For any routine with ≥10 fires in the last 14 days:

1. Read last 200 lines of `state/channel-replies.jsonl` (skip silently if absent/empty). Parse per-line;
   collect `{ ts, channel }` for entries with `event == "reply"`.

2. **Engagement join (delivery-anchored, same-channel window):** for each routine, sort its `fired`
   events by `ts`. For a fire at `T` (next fire at `T_next`, or 14-day window boundary for the last):
   - Take the first reply event at or after `T` within a 10-minute window as the delivery (`T_deliver`,
     channel `C`). If no reply lands in that window, count as *not engaged*.
   - **Engaged** if at least one *further* reply on channel `C` has `ts` in `(T_deliver, T_next]`.
   Engagement ratio = `engaged_fires / total_fires`.

3. Read last 200 lines of `.claude/cost-log.jsonl` (project root). Sum `cost` for entries where
   `source` starts with `"routine:<id>"` and `ts` is within the last 14 days. Divide by 14 → `$/day`.

4. If engagement ratio ≤ 20% — apply the Three-Condition Rule (consequence: `~$X/day` for ignored
   output). If all three hold, produce a `routine_candidates` entry with `action: "retime"` (if obvious
   better time) or `"disable"`, `evidence` citing `"~$X/day, R replies in N sends over 14 days"`.

## Step 3 — Procedure-Capture Detection

Run this step only if `compute` is listed in `phases_json`.

Read two sources directly (no Explore nesting):

1. The operator's `MEMORY.md` index (`.claude-code-hermit/sessions/` is the hermit state dir; MEMORY.md
   is at the project root's `.claude/projects/.../memory/MEMORY.md` — read the path that exists). Look
   for workflow-pattern entries (topic files flagged as workflow patterns, lines with `workflow` in the
   description).

2. `## Lessons` sections of the 3 most recent `sessions/S-*-REPORT.md` files (reuse bodies from Step 1
   if available).

**Recurrence signal:** the same multi-step procedure appears as a Lesson or memory workflow-pattern in
**≥2 distinct archived sessions** and no existing skill covers it (the "existing skill" check runs in
the main session — do not Glob `.claude/skills/` here; the main session handles dedup).

For each recurring procedure found, produce one `procedure_candidates` entry:
```json
{ "slug": "<kebab-case-slug>",
  "title": "<human-readable title>",
  "tier": 3,
  "evidence_source": "archived-session",
  "evidence_origin": "own-work",
  "evidence": "<which sessions, what Lessons/patterns showed the recurrence>",
  "sessions": ["<S-NNN>", "<S-MMM>"],
  "artifact": null }
```

Set `evidence_origin` to `"external-content"` if the procedure was originally learned from external
content (web fetches, `raw/` captures, channel messages).

Emit `procedure_candidates: []` if no recurring procedures are found.

## Return Value

Return a single JSON object — no prose, no markdown wrapping. Every field is required; use `[]` / `null`
/ `{}` for empty values, never omit a key.

<!-- reflect-eval-schema:start -->
```json
{
  "resolution_actions": [ { "proposal_id": "PROP-NNN", "action": "auto-resolve|nudge|skip",
                            "frontmatter_patch": {"status":"resolved","resolved_date":"<ISO>"}|null,
                            "metrics_event": "<JSON string for append-metrics>"|null,
                            "shell_findings_line": "<pre-rendered finding text>"|null } ],
  "routine_candidates": [ { "routine_id": "<id>", "action": "disable|retime|diagnostic",
                            "tier": 1, "schedule": "<new-cron>"|null,
                            "evidence": "<text>", "sessions": ["<S-NNN>"],
                            "shell_findings_line": "<pre-rendered>"|null } ],
  "procedure_candidates": [ { "slug": "<slug>", "title": "<title>", "tier": 3,
                              "evidence_source": "archived-session", "evidence_origin": "own-work",
                              "evidence": "<text>", "sessions": ["<S-NNN>"]|"none",
                              "artifact": "<file — value>"|null } ],
  "last_resolution_check": "PROP-NNN|null",
  "last_sparse_nudge": { "PROP-NNN": "<ISO>" }
}
```
<!-- reflect-eval-schema:end -->

`resolution_actions` and the two cursor fields are applied directly by the calling session. `routine_candidates` and `procedure_candidates` carry cross-session evidence and go through `reflection-judge` then `proposal-triage` before any proposal is created. Applied fields carry the exact string the main session writes — no recomputation needed.
