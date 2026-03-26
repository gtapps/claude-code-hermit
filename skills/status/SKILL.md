---
name: status
description: Returns a compact summary of the current session state. Channel-optimized (under 10 lines). Activates on messages like "status", "progress", "what are you working on", "how's it going".
---
# Session Status

Provide a compact summary of the current session state. Designed for channel responses (Telegram, Discord) where brevity matters.

## Plan

1. Read `.claude/.claude-code-hermit/sessions/SHELL.md`
2. If the file does not exist: respond "No active session. Run `/claude-code-hermit:session` to start one."
2b. If Status is `idle` (session between tasks), format as:
   ```
   Session (idle) | started YYYY-MM-DD | N tasks completed
   Last: [latest Session Summary entry]
   Waiting for next task. Give the next task directly or run /claude-code-hermit:session-start
   Cost: $X.XX (cumulative)
   ```
   Return this output and stop — do not proceed to step 3.
3. Parse the following fields from SHELL.md:
   - **ID** from `**ID:**` line
   - **Status** from `**Status:**` line
   - **Tags** from `**Tags:**` line (if present and non-empty)
   - **Budget** from `**Budget:**` line (if present and non-empty)
   - **Task** — first non-comment, non-empty line after `## Task`
   - **Plan item counts** — count rows in the Plan table by status (`done`, `in_progress`, `blocked`, `planned`). Total = all rows, completed = `done` rows.
   - **Current step** — first row with status `in_progress`
   - **Blockers** — content under `## Blockers` (if any non-comment content)
   - **Cost** — content under `## Cost` (if any non-comment content)
4. Format as a compact output (under 10 lines):

```
Session S-NNN | in_progress | [tags if present]
Task: one-line summary
Progress: X/Y plan items | Current: Step N - description
Budget: $spent / $total (percentage%)
Blockers: none (or brief description)
Cost: $X.XX (NNK tokens)
```

- Omit the Budget line if no budget is set
- Omit tags from the header if none are set
- If the session is blocked, append: "Run `/debug` to diagnose, or `/claude-code-hermit:session` to start a new session."
