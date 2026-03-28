---
name: brief
description: Returns a 5-line executive summary of recent work. Checks active session first, falls back to latest report. Activates on messages like "brief", "what happened", "morning update", "overnight summary".
---
# Session Brief

Provide a concise executive summary of recent session activity. Designed for morning check-ins, phone/channel consumption, and quick status updates.

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

Keep the output to exactly 5 lines maximum:

```
[Brief] YYYY-MM-DD | [tags if present]
Working on: one-line description
Status: completed/partial/blocked (X/Y plan items) | $cost spent
Done: step1, step2, step3
Next: description of next action (or "Session complete" if all done)
```

## Rules

- Never exceed 5 lines — this is designed for phone/channel consumption
- Use the session's date, not today's date
- Include tags in the header only if they exist
- For the "Done" line: list completed step names, comma-separated. If too many, show first 3 and "+ N more"
- For the "Next" line: show the first planned or in_progress step. If blocked, show "Blocked: reason"
- If summarizing a completed report: "Next" becomes the report's "Next Start Point" content
- After composing the 5-line output: scan `.claude-code-hermit/proposals/` for files with `Source: auto-detected` and `Status: proposed`. If any exist, append a 6th line: `Proposals: N auto-detected proposal(s) pending review`

## Daily Summary Format

When invoked with "brief today", "daily summary", or "what happened today":

Scan all session reports archived today (match date in `## Summary`) plus the current SHELL.md progress log. Format as a day-level summary covering: work done, cost, and proposals created/resolved.
