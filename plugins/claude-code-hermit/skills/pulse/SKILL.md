---
name: pulse
description: Returns a compact summary of the current session state. Channel-optimized (under 10 lines). Activates on messages like "status", "progress", "what are you working on", "how's it going".
---
# Session Status

Provide a compact summary of the current session state. Designed for channel responses (Telegram, Discord) where brevity matters.

## Plan

1. Read `.claude-code-hermit/sessions/SHELL.md`
2. If the file does not exist: respond "No active session. Run `/claude-code-hermit:session` to start one."
2b. Read `session_state` from `.claude-code-hermit/state/runtime.json`. If `session_state` is `idle` (session between tasks), format as:
   ```
   Session (idle) | started YYYY-MM-DD | N tasks completed
   Last: [latest Session Summary entry]
   Ready for work. Tell me what's next, or run /claude-code-hermit:session-start
   Cost: $X.XX (12.3K tokens, cumulative)
   ```
   Read `total_cost_usd` and `total_tokens` from `.claude-code-hermit/cost-summary.md` frontmatter for the cumulative figures.
   Return this output and stop — do not proceed to step 3.
3. Parse the following fields from SHELL.md:
   - **ID** from `**ID:**` line
   - **Tags** from `**Tags:**` line (if present and non-empty)
   - **Task** — first non-comment, non-empty line after `## Task`
   - **Task progress** — call `TaskList` and count by status. Total = all tasks, completed = `completed` tasks.
   - **Current step** — first task with status `in_progress`
   - **Blockers** — content under `## Blockers` (if any non-comment content)
   - **Cost and tokens** — read `cost_usd` and `tokens` from `.claude-code-hermit/sessions/.status.json` (live per-session totals). Fall back to `0`/`0` if the file is missing.
4. Format as a compact output (under 10 lines). Use `session_state` from runtime.json for the status field in the header:

```
Session S-NNN | in_progress | [tags if present]
Working on: one-line summary
Progress: X/Y tasks | Current: Step N - description
Blockers: none (or brief description)
Cost: $X.XX (12.3K tokens)
```

- Omit tags from the header if none are set
- If the session is blocked, append: "Run `/debug` to diagnose, or `/claude-code-hermit:session` to start a new session."
- Read `.claude-code-hermit/state/alert-state.json`. If the `active` array is non-empty, append one line: `⚠ N alert(s) active — run /claude-code-hermit:hermit-health`
