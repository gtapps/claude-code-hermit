---
name: pulse
description: Returns a compact summary of the current session state. Channel-optimized (under 10 lines). Pass --full to append infrastructure health (proposals, routines, last activity, knowledge). Activates on messages like "status", "progress", "what are you working on", "how's it going".
---
# Session Status

Provide a compact summary of the current session state. Designed for channel responses (Telegram, Discord) where brevity matters.

## Plan

1. Read `.claude-code-hermit/sessions/SHELL.md`
2. If the file does not exist: respond "No active session. Run `/claude-code-hermit:session` to start one."
2b. If Status is `idle` (session between tasks), format as:
   ```
   Session (idle) | started YYYY-MM-DD | N tasks completed
   Last: [latest Session Summary entry]
   Ready for work. Tell me what's next, or run /claude-code-hermit:session-start
   Cost: $X.XX (cumulative)
   ```
   Return this output and stop — do not proceed to step 3.
3. Parse the following fields from SHELL.md:
   - **ID** from `**ID:**` line
   - **Status** from `**Status:**` line
   - **Tags** from `**Tags:**` line (if present and non-empty)
   - **Budget** from `**Budget:**` line (if present and non-empty)
   - **Task** — first non-comment, non-empty line after `## Task`
   - **Task progress** — call `TaskList` and count by status. Total = all tasks, completed = `completed` tasks.
   - **Current step** — first task with status `in_progress`
   - **Blockers** — content under `## Blockers` (if any non-comment content)
   - **Cost** — content under `## Cost` (if any non-comment content)
4. Format as a compact output (under 10 lines):

```
Session S-NNN | in_progress | [tags if present]
Working on: one-line summary
Progress: X/Y tasks | Current: Step N - description
Budget: $spent / $total (percentage%)
Blockers: none (or brief description)
Cost: $X.XX (NNK tokens)
```

- Omit the Budget line if no budget is set
- Omit tags from the header if none are set
- If the session is blocked, append: "Run `/debug` to diagnose, or `/claude-code-hermit:session` to start a new session."

## --full flag

When the operator passes `--full`, append infrastructure health sections after the session block above.
This answers "is my hermit healthy?" — not a config dump (that's `hermit-settings`), not a work summary (that's `brief`).

5. Read `.claude-code-hermit/config.json`
6. Glob `.claude-code-hermit/proposals/PROP-*.md`. For each file, parse the `status` field from YAML frontmatter (or bullet-point metadata for legacy files). Count per status (proposed, accepted, in_progress, resolved, dismissed, deferred).
7. Read `.claude-code-hermit/state/micro-proposals.json`. Count entries where `status` is `pending`.
8. From config.json `routines` array: list each routine as `id (schedule, on/off)`.
9. Read `.claude-code-hermit/state/reflection-state.json` for `last_reflection` timestamp. Read `.claude-code-hermit/state/alert-state.json` for the most recent alert timestamp. Compute relative age ("2h ago", "45m ago").
10. Glob file counts: `.claude-code-hermit/raw/**` (excluding `.archive/`), `.claude-code-hermit/compiled/**`, `.claude-code-hermit/raw/.archive/**`.

Format the additional sections:

```
Proposals: N proposed, N accepted, N in_progress
Micro: N pending decision
Routines: morning-brief (08:00 daily), weekly-deps (09:00 mon, off)
Last: reflect 2h ago, heartbeat 45m ago
Knowledge: N raw, N compiled, N archived
```

- If a section has no data or the source file is missing, show `—` (not an error)
- Omit the Micro line entirely if there are zero pending micro-proposals
- Total output (session + infrastructure) should stay under 12 lines
