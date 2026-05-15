---
name: pulse
description: Returns a compact summary of the current focus state. Channel-optimized (under 10 lines). Pass --full to append infrastructure health (proposals, routines, last activity, knowledge). Activates on messages like "status", "progress", "what are you working on", "how's it going".
---
# Pulse

Provide a compact summary of the current focus state. Designed for channel responses (Telegram, Discord) where brevity matters.

## Plan

1. Read `.claude-code-hermit/sessions/SHELL.md` and `.claude-code-hermit/state/runtime.json`.
2. If neither exists: respond "No hermit state. Run `/claude-code-hermit:hatch` to set up."
3. If `runtime.session_state == idle` (no active focus), format as:
   ```
   Idle | started YYYY-MM-DD | Cost: $X.XX (cumulative)
   Last activity: [latest Recent Activity entry]
   Ready for work. Tell me what's next, or run /claude-code-hermit:steer.
   ```
   Return this output and stop — do not proceed to step 4.
4. Parse the following fields from SHELL.md:
   - **Tags** from `**Tags:**` line (if present and non-empty)
   - **Budget** from `**Budget:**` line (if present and non-empty)
   - **Focus** — first non-comment, non-empty line after `## Focus`
   - **Task progress** — call `TaskList` and count by status. Total = all tasks, completed = `completed` tasks.
   - **Current step** — first task with status `in_progress`
   - **Blockers** — content under `## Blockers` (if any non-comment content)
   - **Cost** — content under `## Cost` (if any non-comment content)
5. Format as a compact output (under 10 lines):

```
Focus | <session_state> | [tags if present]
Working on: one-line summary
Progress: X/Y tasks | Current: Step N - description
Budget: $spent / $total (percentage%)
Blockers: none (or brief description)
Cost: $X.XX (NNK tokens)
```

- Omit the Budget line if no budget is set
- Omit tags from the header if none are set
- The `session_state` is `in_progress` or `waiting` — if `waiting`, append "(awaiting answer)" to clarify
- If blocked, append: "Run `/debug` to diagnose, or `/claude-code-hermit:done` to clear and pick something else."

## --full flag

When the operator passes `--full`, append infrastructure health sections after the focus block above.
This answers "is my hermit healthy?" — not a config dump (that's `hermit-settings`), not a work summary (that's `brief`).

6. Read `.claude-code-hermit/config.json`
7. Glob `.claude-code-hermit/proposals/PROP-*.md`. For each file, parse the `status` field from YAML frontmatter (or bullet-point metadata for legacy files). Count per status (proposed, accepted, in_progress, resolved, dismissed, deferred).
8. Read `.claude-code-hermit/state/micro-proposals.json`. Count entries where `status` is `pending`.
9. From config.json `routines` array: list each routine as `id (schedule, on/off)`.
10. Read `.claude-code-hermit/state/reflection-state.json` for `last_reflection` timestamp and `counters`. Read `.claude-code-hermit/state/alert-state.json` for the most recent alert timestamp. Compute relative age ("2h ago", "45m ago").
11. Glob file counts: `.claude-code-hermit/raw/**` (excluding `.archive/`), `.claude-code-hermit/compiled/**`, `.claude-code-hermit/raw/.archive/**`.

Format the additional sections:

```
Proposals: N proposed, N accepted, N in_progress
Micro: N pending decision
Routines: reflect-digest (23:00 daily), weekly-review (23:00 sun, off)
Last: reflect 2h ago, heartbeat 45m ago
Reflect: N runs, N empty | judge: N accepted / N downgraded / N suppressed | output: N proposals, N micro | since YYYY-MM-DD
Knowledge: N raw, N compiled, N archived
```

- If a section has no data or the source file is missing, show `—` (not an error)
- Omit the Micro line entirely if there are zero pending micro-proposals
- **Reflect line rules:**
  - If `counters` is absent: `Reflect: —`
  - If `total_runs` is 0: `Reflect: no runs yet (since YYYY-MM-DD)`
  - Otherwise: full format as above; omit the `| output: ...` clause if both `proposals_created` and `micro_proposals_queued` are 0
- Total output (focus + infrastructure) should stay under 12 lines
