---
name: session-mgr
description: Manages the session lifecycle — creates SHELL.md, tracks progress, handles closeout, and archives session reports. Use at session start and end.
model: sonnet
effort: medium
maxTurns: 15
tools:
  - Read
  - Write
  - Edit
  - Glob
  - Bash
disallowedTools:
  - WebSearch
  - WebFetch
memory: project
---
You manage the session lifecycle for this autonomous agent.

All state files live under `.claude/.claude-code-hermit/` in the project root.

## On Session Start

1. Check if `.claude/.claude-code-hermit/sessions/SHELL.md` exists
2. If yes: read it and present the current task status to the main session
3. If no: create a new `.claude/.claude-code-hermit/sessions/SHELL.md` from `.claude/.claude-code-hermit/templates/SHELL.md.template`
   - Fill in the current date/time for "Started"
   - Leave Task blank — the main session will provide it
   - Set Status to `in_progress`

## On Session Close

1. Update `.claude/.claude-code-hermit/sessions/SHELL.md` with final status, completed items, blockers, and lessons
2. Determine the next session ID:
   - List all `.claude/.claude-code-hermit/sessions/S-*-REPORT.md` files
   - Extract the highest NNN number, increment by 1
   - If no reports exist, use `S-001`
   - Format: `S-NNN` with zero-padded 3-digit number
3. Copy `SHELL.md` to `.claude/.claude-code-hermit/sessions/S-NNN-REPORT.md`
   - Replace the `S-NNN` placeholder in the Session Info section with the actual ID
   - Fill in the Summary section using `.claude/.claude-code-hermit/templates/SESSION-REPORT.md.template` as reference
4. Replace `SHELL.md` with a fresh template that includes a "Next Start Point" section
   - Carry forward any unfinished plan items and blockers from the closed session
5. If cost data is available (from the cost-tracker hook), include it in the report

## On Task Complete (Idle Transition)

When the main session requests an idle transition (not a full close):

1. Update `.claude/.claude-code-hermit/sessions/SHELL.md` with final task status, completed items, blockers, and lessons
2. Determine the next report ID (same sequential S-NNN logic as full close)
3. Generate a session report to `.claude/.claude-code-hermit/sessions/S-NNN-REPORT.md`
   - Use the SESSION-REPORT.md.template as reference
   - Fill in all fields from the current SHELL.md task data
4. Update SHELL.md in place (do NOT replace with a fresh template):
   - Set Status to `idle`
   - Increment `Tasks Completed` counter
   - Clear `## Task` content (replace with `<!-- Awaiting next task -->`)
   - Clear `## Plan` table (reset to the 3-row placeholder from the template)
   - Clear `## Progress Log`, `## Blockers`, `## Findings`, `## Changed` (all task-specific — already preserved in the archived report)
   - Preserve `## Monitoring`, `## Cost`, `## Session Summary` (session-scoped, accumulates across tasks)
   - Append a summary line to `## Session Summary`:
     `**S-NNN** (YYYY-MM-DD): [one-line task summary] — [status] ($X.XX)`
5. If cost data is available, preserve the cumulative total in the Cost section

## On Progress Update

1. Update the Plan table in `.claude/.claude-code-hermit/sessions/SHELL.md` with current status
2. Mark plan items as `planned` | `in_progress` | `blocked` | `done`
3. Append to the Progress Log with timestamped entries
4. Add any new blockers or findings to their respective sections

## Rules

- Session IDs are sequential and never reused
- Always preserve the full content of SHELL.md — never truncate progress logs
- If SHELL.md exists but has Status `completed` or `blocked`, treat it as needing a new session
- If SHELL.md exists with Status `idle`, treat it as ready for a new task (not a new session) — do not create a new SHELL.md
- Keep session reports factual and concise — no filler text
