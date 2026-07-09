---
name: brief
description: Returns a 5-line executive summary of recent work. Checks active session first, falls back to latest report. Activates on messages like "brief", "what happened", "morning update", "overnight summary", "status", "progress", "what are you working on", "how's it going".
---
# Session Brief

Provide a concise executive summary of recent session activity. Designed for morning check-ins, phone/channel consumption, and quick status updates.

## Always-On Delivery Rule

If `config.always_on` is `true`, deliver all operator-facing output per `CLAUDE-APPEND.md § Operator Notification`. The terminal is unmonitored in always-on mode. For the push-fallback branch, condense the brief to a single line (≤200 chars, no markdown): include whichever of yesterday's/today's cost, open proposal count, and active heartbeat alerts are present and non-zero; omit zero or unavailable fields. Example: `Brief: 16 proposals open, yesterday $0.42, 1 alert — open CC to view`. In interactive mode, output to terminal. This applies to all flags below.

## Dispatch

Before composing any brief, determine the dispatch mode:

1. Read `session_state` from `.claude-code-hermit/state/runtime.json` (live state — always in main).
2. Resolve the active flag (`--morning`, `--evening`, "brief today"/"daily summary", or no flag).

**Dispatch decision:**
- `--morning` → dispatch (mode: `morning`)
- `--evening` → dispatch (mode: `evening`)
- "brief today" / "daily summary" / "what happened today" → dispatch (mode: `daily`)
- No flag + `session_state` is `in_progress` → **no dispatch** — summarize the live SHELL.md in main (Plan step 1a)
- No flag + `session_state` is `idle` → **no dispatch** — read the live SHELL.md in main and emit the idle block (Plan step 1b)
- No flag + no active session (no SHELL.md / no `session_state`) → dispatch (mode: `default-no-session`, Plan step 1c)

For dispatching modes: invoke `claude-code-hermit:skill-eval-runner` pointed at `${CLAUDE_PLUGIN_ROOT}/skills/brief/reference.md`. Pass in the dispatch prompt: `mode` (one of the values above), `today` (current ISO date), and for `morning` only: `context_recovery` (set to `true` if auto-memory seems sparse — new instance, fresh machine — `false` otherwise).

**Boundary rule:** `sessions/SHELL.md` is the live session document — it stays in main, never goes to the runner. Archived `sessions/S-*-REPORT.md` bodies, `cost-summary.md`, `proposals/*.md` frontmatter, `OPERATOR.md`, and `NEXT-TASK.md` go to the runner.

**Failure policy:** if the runner returns null or malformed JSON, fail-open — compose the brief from whatever live data main holds (TaskList, SHELL.md, `today-cost.ts` output) and skip the runner-derived lines. Note nothing fatal to the operator.

**Eval runner return schema** — the runner returns a JSON object conforming to this block. The schema is byte-identical in `reference.md` (producer) and here (consumer); a contract test asserts this.

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

## Flags

### --morning (routine mode)

**Delivery:** Write the full composed brief text (before any push-fallback single-line condensing) to `.claude-code-hermit/state/last-brief.json` as `{"kind":"morning","text":"<brief text>","generated_at":"<now, ISO>"}`, so the dashboard's "latest brief" section can pick it up. Then refresh the dashboard per `${CLAUDE_PLUGIN_ROOT}/docs/artifacts.md`; if it returns a URL, append a final line `📎 <url>`. Then deliver the brief to the operator (see Always-On Delivery Rule above).

Emphasize forward-looking content. Compose from runner JSON (see Dispatch above) and live main-session data:
- **Cost context:** use `runner.cost_context.yesterday`
- **Pending proposals:** use `runner.pending_proposals`
- **Operator priorities:** use `runner.operator_priorities`
- **Queued work:** use `runner.queued_work`
- **Context recovery:** if `runner.report_summary` is non-null, use it for session context
- If `config.always_on` is `true`: frame as "what happened overnight (activity since evening routine)"
- If `config.always_on` is `false`: frame as "here's where things stand"
- If `config.always_on` is `true`: run `bash "${CLAUDE_PLUGIN_ROOT}/scripts/check-upgrade.sh" "${CLAUDE_PLUGIN_ROOT}"` from the project root. If it emits an `---Upgrade Available---` section, append a final line to the brief: `⚠ Plugin update available: <the version line>` (pass the directive verbatim). Output nothing if the script is silent. (Interactive operators already see this notice at session-start step 2; the gate avoids double-notification.)

<!-- keep in sync with plugins/claude-code-homeassistant-hermit/skills/ha-morning-brief/SKILL.md step 9a — same MP lifecycle protocol -->
After composing the morning brief, check `state/micro-proposals.json → pending` for entries with `status: "pending"` **(fresh read — re-read the file(s) now; do not reuse a value cached in context from before compaction)**:
- If **one or more** pending entries with `follow_up_count` of 0: append each as a final line. Entries without `options`: `MP-YYYYMMDD-N (tier N): [question]` — Reply `"MP-YYYYMMDD-N yes"` or `"MP-YYYYMMDD-N no"`. (Bare `yes`/`no` accepted when only one pending.) Entries with `options`: render them numbered under the question and reply hint `Reply "MP-YYYYMMDD-N <number or label>"` (bare accepted when only one pending).
- For any entry with `follow_up_count` of 1: append with softer framing: "Still waiting on MP-YYYYMMDD-N: [question] — ignore again to drop it" (if the entry has `options`, re-render them numbered beneath it so the choices aren't lost on the re-nudge). Increment `follow_up_count` to 2.
- For any entry with `follow_up_count` >= 2: read `question` first, then set `status: "expired"`, remove from `pending`. Append `micro-resolved` event via stdin heredoc (question may contain apostrophes): `{"ts":"<now ISO>","type":"micro-resolved","micro_id":"<id>","action":"expired","question":"<question>"}`. Do not resurrect unless fresh evidence accumulates from scratch.
- If no pending entries: brief ends without a decision prompt.

### --evening (routine mode)

**Delivery:** Write the full composed brief text (before any push-fallback single-line condensing) to `.claude-code-hermit/state/last-brief.json` as `{"kind":"evening","text":"<brief text>","generated_at":"<now, ISO>"}`, so the dashboard's "latest brief" section can pick it up. Then refresh the dashboard per `${CLAUDE_PLUGIN_ROOT}/docs/artifacts.md`; if it returns a URL, append a final line `📎 <url>`. Then deliver the brief to the operator (see Always-On Delivery Rule above).

Emphasize backward-looking content. Compose from runner JSON (see Dispatch above) and live main-session data:
- **Sessions today:** use `runner.sessions_today`; also note any progress in the current SHELL.md progress log (read SHELL.md in main **(fresh read — re-read the file(s) now; do not reuse a value cached in context from before compaction)**).
- **Today's cost:** run `bun "${CLAUDE_PLUGIN_ROOT}/scripts/today-cost.ts"` (live, in main) — do not use `cost-summary.md` for today's figure; it is only updated once per day and will be stale in always-on deployments.
- **Key findings:** use `runner.findings`
- **Tomorrow:** use `runner.tomorrow`
- After generating summary: if `runtime.json session_state` is `in_progress` or SHELL.md has progress entries since last report, note it in the brief (e.g., "Session still open — run /session-close to archive.") and let the operator close explicitly. Exception: if `config.always_on` is `true` AND `config.routines` contains an enabled entry with `id` `daily-auto-close` (the midnight routine, which invokes `/claude-code-hermit:session-close --scheduled`), suppress the note — the auto-close routine archives it at midnight. Idle transitions are owned by the `session` skill and `scripts/session-archive.ts`; brief does not trigger them.

### No flag (default)

Current behavior — general purpose summary as described below.

## Plan

1. Use `session_state` already read in the Dispatch step:
   - **1a. `in_progress` (no dispatch):** read `.claude-code-hermit/sessions/SHELL.md` **(fresh read — re-read the file(s) now; do not reuse a value cached in context from before compaction)**. Summarize the active task using TaskList for Done/Next lines; produce the standard 5-line output. For the cost line, read `cost_usd` and `tokens` from `.claude-code-hermit/sessions/.status.json` (live per-session totals; fall back to `0`/`0` if missing) rather than the once-daily `cost-summary.md`. Scale the token suffix by magnitude — the same K/M/B convention as `scripts/lib/format.ts`'s `formatTokens` (raw integer under 1K, `K` under 1M, `M` under 1B, `B` beyond, promoting to the next tier when rounding would otherwise overflow to 1000 — e.g. 999999 tokens is `1.0M`, not `1000K`; one decimal place if the scaled value is under 100, otherwise round) — never assume `K`. Then read `.claude-code-hermit/state/alert-state.json`; if its `active` array is non-empty, append one line: `⚠ N alert(s) active — run /claude-code-hermit:hermit-health`.
   - **1b. `idle` (no dispatch):** read SHELL.md **(fresh read — re-read the file(s) now; do not reuse a value cached in context from before compaction)**. For the `Cumulative:` line, read `total_cost_usd` and `total_tokens` from `.claude-code-hermit/cost-summary.md` frontmatter (fall back to `0`/`0` if missing), scaling the token suffix by magnitude as above. Format as:
     ```
     [Brief] YYYY-MM-DD | idle | N tasks completed
     Session: since [start date]
     Last: [latest Session Summary entry] — [status]
     Cumulative: $X.XX (N tokens) across N tasks
     Status: Idle — ready for what's next (run /claude-code-hermit:session-start to begin)
     ```
     Then check for auto-detected proposals (step after Output Format) and return.
   - **1c. No active session (dispatch):** runner JSON is already available (mode: `default-no-session`). Use `runner.report_summary` for the brief. If `report_summary` is null (runner failed), fall back to reading the most recent archived report directly in main.
2. If no session and no runner result: respond "No session history yet. Run `/claude-code-hermit:session` to start."

## Output Format

Keep the output to 5 lines, plus an optional 6th line for pending proposals (see Rules below):

```
[Brief] YYYY-MM-DD | [tags if present]
Working on: one-line description
Status: completed/partial/blocked (X/Y tasks) | $cost spent (N tokens)
Done: step1, step2, step3
Next: description of next action (or "Session complete" if all done)
```

## Rules

- Never exceed 6 lines total (5 content lines + optional proposal line) — this is designed for phone/channel consumption
- Use the session's date, not today's date
- Include tags in the header only if they exist
- For the "Done" line: list completed task subjects from `TaskList`, comma-separated. If too many, show first 3 and "+ N more"
- For the "Next" line: show the first pending or in_progress task from `TaskList`. If blocked, show "Blocked: reason — run /debug to diagnose, or /claude-code-hermit:session for a fresh session" (keeps the actionable pointers on the existing line, no extra line)
- If summarizing a completed report: "Next" becomes the report's "Next Start Point" content
- After composing the 5-line output: scan `.claude-code-hermit/proposals/` for files with `source: auto-detected` and `status: proposed` (read `status:` and `source:` from the **leading `---` YAML frontmatter block only** — do not count files where those phrases appear in the proposal body text; fall back to bullet metadata for pre-frontmatter proposals). **(fresh read — re-read the file(s) now; do not reuse a value cached in context from before compaction).** If any exist, append a 6th line: `Proposals: N auto-detected proposal(s) pending review`

## Daily Summary Format

When invoked with "brief today", "daily summary", or "what happened today":

Compose from runner JSON (mode: `daily`). For today's cost and token total, run `bun "${CLAUDE_PLUGIN_ROOT}/scripts/today-cost.ts"` (live, in main). Use `runner.cost_context.week` and `runner.cost_context.all_time` for aggregates from `cost-summary.md`. Use `runner.sessions_today`, `runner.findings`, and `runner.tomorrow` for the day narrative. Format as a day-level summary covering: work done, cost, and proposals created/resolved.
