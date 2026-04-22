---
name: brief
description: Returns a 5-line executive summary of recent work. Checks active session first, falls back to latest report. Activates on messages like "brief", "what happened", "morning update", "overnight summary".
---
# Session Brief

Provide a concise executive summary of recent session activity. Designed for morning check-ins, phone/channel consumption, and quick status updates.

## Always-On Delivery Rule

If `config.always_on` is `true` and channels are configured, send all operator-facing output via the configured channel — the terminal is unmonitored in always-on mode. In interactive mode, output to terminal. This applies to all flags below.

## Flags

### --morning (routine mode)

**Delivery:** After composing the brief, deliver it to the operator (see Always-On Delivery Rule above).

Emphasize forward-looking content:
- Read `.claude-code-hermit/cost-summary.md` for cost context. Include: "Yesterday: $X.XX across N sessions" from the trend table.
- Pending proposals needing review
- OPERATOR.md priorities
- If `config.always_on` is `true`: what happened overnight (activity since evening routine)
- If `config.always_on` is `false`: frame as "here's where things stand" rather than "what happened overnight"
- What's queued (NEXT-TASK.md, open proposals)
- If auto-memory seems sparse (new instance, fresh machine), read the latest S-NNN-REPORT.md for context recovery

After composing the morning brief, check `state/micro-proposals.json`:
- If `active` is not null and `status` is `pending` and `follow_up_count` is 0:
  Append as final line: "One thing waiting on you: [question]"
- If `active` is not null and `status` is `pending` and `follow_up_count` is 1:
  Append with softer framing: "Still waiting on: [question] — ignore again to drop it"
  Then increment `follow_up_count` to 2.
- If `active` is not null and `status` is `pending` and `follow_up_count` >= 2:
  Read `active.question` first, then set `status: "expired"`, clear `active` to null. Append `micro-resolved` event via `append-metrics.js` with `"action":"expired","question":"<active.question>"`. Do not resurrect unless fresh evidence accumulates from scratch.
- If no active pending: brief ends without a decision prompt.
Never append more than one pending decision.

### --evening (routine mode)

**Delivery:** After composing the brief, deliver it to the operator (see Always-On Delivery Rule above).

Emphasize backward-looking content:
- Sessions completed today (scan S-NNN reports with today's date in frontmatter `date` field, or `## Summary` for pre-Observatory reports, plus current SHELL.md progress log)
- Read `.claude-code-hermit/cost-summary.md` for today's cost. If the summary is stale (its frontmatter `updated` date is not today), the cost-tracker will regenerate it on the next interaction — use the trend table's today entry or fall back to scanning reports.
- Key findings or patterns noticed
- What to look at tomorrow
- After generating summary: if SHELL.md Status is `in_progress` or has progress entries since last report, note it in the brief (e.g., "Session still open — run /session-close to archive.") and let the operator close explicitly. Idle transitions are owned by the `session` skill and `session-mgr`; brief does not trigger them.

### No flag (default)

Current behavior — general purpose summary as described below.

## Plan

1. Check if `.claude-code-hermit/sessions/SHELL.md` exists:
   - If Status is `in_progress`: summarize the active task (existing behavior below)
   - If Status is `idle` (session between tasks): format as:
     ```
     [Brief] YYYY-MM-DD | idle | N tasks completed
     Session: since [start date]
     Last: [latest Session Summary entry] — [status]
     Cumulative: $X.XX across N tasks
     Status: Idle — ready for what's next
     ```
     Then check for auto-detected proposals (step after Output Format) and return.
2. If no active session: find the most recent `.claude-code-hermit/sessions/S-*-REPORT.md` (sort by filename, take the highest number):
   - If found: summarize that report
3. If neither exists: respond "No session history yet. Run `/claude-code-hermit:session` to start."

## Output Format

Keep the output to 5 lines, plus an optional 6th line for pending proposals (see Rules below):

```
[Brief] YYYY-MM-DD | [tags if present]
Working on: one-line description
Status: completed/partial/blocked (X/Y tasks) | $cost spent
Done: step1, step2, step3
Next: description of next action (or "Session complete" if all done)
```

## Rules

- Never exceed 6 lines total (5 content lines + optional proposal line) — this is designed for phone/channel consumption
- Use the session's date, not today's date
- Include tags in the header only if they exist
- For the "Done" line: list completed task subjects from `TaskList`, comma-separated. If too many, show first 3 and "+ N more"
- For the "Next" line: show the first pending or in_progress task from `TaskList`. If blocked, show "Blocked: reason"
- If summarizing a completed report: "Next" becomes the report's "Next Start Point" content
- After composing the 5-line output: scan `.claude-code-hermit/proposals/` for files with `source: auto-detected` and `status: proposed` (read from YAML frontmatter if present, fall back to bullet metadata). If any exist, append a 6th line: `Proposals: N auto-detected proposal(s) pending review`

## Daily Summary Format

When invoked with "brief today", "daily summary", or "what happened today":

Scan all session reports archived today (match `date` in YAML frontmatter, or `Date` in `## Summary` for pre-Observatory reports) plus the current SHELL.md progress log. Read `.claude-code-hermit/cost-summary.md` for aggregated cost data. Format as a day-level summary covering: work done, cost, and proposals created/resolved.
