---
name: status
description: Returns a compact summary of the current session state. Channel-optimized (under 10 lines). Activates on messages like "status", "progress", "what are you working on", "how's it going".
---
# Session Status

Provide a compact summary of the current session state. Designed for channel responses (Telegram, Discord) where brevity matters.

## Steps

1. Read `.claude/.claude-code-hermit/sessions/ACTIVE.md`
2. If the file does not exist: respond "No active session. Run `/claude-code-hermit:session` to start one."
2b. If Status is `idle` (always-on session between missions), format as:
   ```
   Session (idle) | started YYYY-MM-DD | N missions completed
   Last: [latest Session Summary entry]
   Waiting for next mission. Send one via channel or run /claude-code-hermit:session-start
   Cost: $X.XX (cumulative)
   ```
   Return this output and stop — do not proceed to step 3.
3. Parse the following fields from ACTIVE.md:
   - **ID** from `**ID:**` line
   - **Status** from `**Status:**` line
   - **Tags** from `**Tags:**` line (if present and non-empty)
   - **Budget** from `**Budget:**` line (if present and non-empty)
   - **Mission** — first non-comment, non-empty line after `## Mission`
   - **Step counts** — count rows in the Steps table by status (`done`, `in_progress`, `blocked`, `planned`). Total = all rows, completed = `done` rows.
   - **Current step** — first row with status `in_progress`
   - **Blockers** — content under `## Blockers` (if any non-comment content)
   - **Cost** — content under `## Cost` (if any non-comment content)
4. Format as a compact output (under 10 lines):

```
Session S-NNN | in_progress | [tags if present]
Mission: one-line summary
Progress: X/Y steps | Current: Step N - description
Budget: $spent / $total (percentage%)
Blockers: none (or brief description)
Cost: $X.XX (NNK tokens)
```

- Omit the Budget line if no budget is set
- Omit tags from the header if none are set
- If the session is blocked, append: "Run `/debug` to diagnose, or `/claude-code-hermit:session` to start a new session."
