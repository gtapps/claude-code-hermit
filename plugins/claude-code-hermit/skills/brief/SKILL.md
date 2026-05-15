---
name: brief
description: Returns a 5-line executive summary of recent work. Reads SHELL.md and the most recent reflect-digest. Activates on messages like "brief", "what happened", "morning update", "overnight summary".
---
# Brief

Provide a concise executive summary of recent activity. Designed for morning check-ins, phone/channel consumption, and quick status updates.

## Always-On Delivery Rule

If `config.always_on` is `true` and channels are configured, send all operator-facing output via the configured channel — the terminal is unmonitored in always-on mode. In interactive mode, output to terminal. This applies to all flags below.

## Flags

### --morning (routine mode)

**Delivery:** After composing the brief, deliver it to the operator (see Always-On Delivery Rule above).

Emphasize forward-looking content:
- Read `.claude-code-hermit/cost-summary.md` for cost context. Include: "Yesterday: $X.XX" from the trend table.
- Pending proposals needing review
- OPERATOR.md priorities
- If `config.always_on` is `true`: what happened overnight (activity since the evening reflect-digest)
- If `config.always_on` is `false`: frame as "here's where things stand" rather than "what happened overnight"
- What's queued (NEXT-TASK.md, open proposals)
- If auto-memory seems sparse (new instance, fresh machine), read the most recent `compiled/reflect-digest-*.md` for context recovery; fall back to the latest historical `S-*-REPORT.md` if no digest exists yet.

After composing the morning brief, check `state/micro-proposals.json → pending` for entries with `status: "pending"`:
- If **one or more** pending entries with `follow_up_count` of 0: append each as a final line: `MP-YYYYMMDD-N (tier N): [question]` — Reply `"MP-YYYYMMDD-N yes"` or `"MP-YYYYMMDD-N no"`. (Bare `yes`/`no` accepted when only one pending.)
- For any entry with `follow_up_count` of 1: append with softer framing: "Still waiting on MP-YYYYMMDD-N: [question] — ignore again to drop it". Increment `follow_up_count` to 2.
- For any entry with `follow_up_count` >= 2: read `question` first, then set `status: "expired"`, remove from `pending`. Append `micro-resolved` event via `append-metrics.js` with `"action":"expired","question":"<question>"`. Do not resurrect unless fresh evidence accumulates from scratch.
- If no pending entries: brief ends without a decision prompt.

### --evening (routine mode)

**Delivery:** After composing the brief, deliver it to the operator (see Always-On Delivery Rule above).

Emphasize backward-looking content:
- Work done today: scan SHELL.md `## Recent Activity` entries with today's HH:MM stamps, plus the current `## Progress Log` if a focus is active.
- Read `.claude-code-hermit/cost-summary.md` for today's cost. If the summary is stale (its frontmatter `updated` date is not today), the cost-tracker will regenerate it on the next interaction — use the trend table's today entry as authority.
- Key findings or patterns noticed
- What to look at tomorrow
- If SHELL.md `## Focus` has non-placeholder content, note it in the brief (e.g., "Focus still active: <text> — run /done when ready"). The brief does not clear focus; that's `/done`'s job.

### No flag (default)

Current behavior — general purpose summary as described below.

## Plan

1. Read `.claude-code-hermit/sessions/SHELL.md` and `.claude-code-hermit/state/runtime.json`.
2. If neither exists: respond "No hermit state yet. Run `/claude-code-hermit:hatch` to set up."
3. If `runtime.session_state == idle` and SHELL.md `## Focus` is placeholder:
   ```
   [Brief] YYYY-MM-DD | idle
   Last activity: [latest Recent Activity entry]
   Cost: $X.XX (cumulative)
   Status: Idle — ready for what's next
   ```
   Then check for auto-detected proposals (see Rules) and return.
4. If `## Focus` has content: summarize the active focus.
5. If a `compiled/reflect-digest-*.md` is more recent than the latest Recent Activity entry, include its top-line summary as additional context.

## Output Format

Keep the output to 5 lines, plus an optional 6th line for pending proposals:

```
[Brief] YYYY-MM-DD | [tags if present]
Focus: one-line description
Status: <session_state> (X/Y tasks) | $cost spent
Done: recent activity entries (latest 3)
Next: description of next action (or "Awaiting next focus" if cleared)
```

## Rules

- Never exceed 6 lines total (5 content lines + optional proposal line) — this is designed for phone/channel consumption
- Use today's date in the header
- Include tags only if SHELL.md `**Tags:**` is non-empty
- For "Done": pull the latest 3 entries from `## Recent Activity`, comma-separated
- For "Next": show the first pending or in_progress task from `TaskList`. If blocked, show "Blocked: reason"
- After composing the 5-line output: scan `.claude-code-hermit/proposals/` for files with `source: auto-detected` and `status: proposed`. If any exist, append a 6th line: `Proposals: N auto-detected proposal(s) pending review`

## Daily Summary Format

When invoked with "brief today", "daily summary", or "what happened today":

Scan SHELL.md `## Recent Activity` for entries with today's HH:MM stamps. Include any `compiled/reflect-digest-<today>.md` content if present. Read `.claude-code-hermit/cost-summary.md` for aggregated cost data. Format as a day-level summary covering: focuses completed, cost, and proposals created/resolved.

Historical reports (`sessions/S-*-REPORT.md`) remain valid as deeper-context evidence for older work — read on demand if the operator asks about a date before the live-focus model was adopted.
