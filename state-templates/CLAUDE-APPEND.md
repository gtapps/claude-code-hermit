
---

<!-- claude-code-hermit: Session Discipline -->

## Session Discipline (claude-code-hermit)

- On startup, always check `.claude-code-hermit/sessions/SHELL.md`
- If a session is active: resume it — read the task, progress, and blockers
- If no session is active: ask what you should help with before starting work
- Use `/claude-code-hermit:session-start` to initialize and `/claude-code-hermit:session-close` to end sessions
- Never create session or proposal files by hand — use the skills

## Session Lifecycle

After completing a task: transition to `idle`, do NOT close the session.
- Report is archived, task-scoped sections reset, session-scoped data (cost, summary) carries forward
- Heartbeat starts if enabled — best-effort in interactive (tied to terminal), guaranteed in always-on (tmux)
- New tasks start via operator input, channel message, or NEXT-TASK.md
- `/session-close` is always a full shutdown — use when actually done

Infrastructure differences (not behavioral):
- **Always-on** (via `hermit-start`): tmux persistence, channels, guaranteed heartbeat. Shutdown via `hermit-stop`.
- **Interactive** (terminal): best-effort heartbeat, no channels. Shutdown via `/session-close` or terminal exit.

## Agent State Directory

All autonomous agent state lives in `.claude-code-hermit/`:
- `sessions/SHELL.md` — live working document for the current session
- `sessions/S-NNN-REPORT.md` — archived session reports
- `proposals/PROP-NNN.md` — improvement proposals
- `templates/` — templates for sessions and proposals
- `OPERATOR.md` — human-curated project context and constraints

## Subagent Usage

| Agent | When to use | Model |
|-------|------------|-------|
| `session-mgr` | Session start, close, progress tracking | Sonnet |

## Quick Reference

- Run session: `/claude-code-hermit:session` — generic session workflow
- Start session: `/claude-code-hermit:session-start`
- Close session: `/claude-code-hermit:session-close`
- Session status: `/claude-code-hermit:status` — compact summary (auto-triggers on "status", "progress")
- Session brief: `/claude-code-hermit:brief` — executive summary (auto-triggers on "brief", "what happened")
- Monitor: `/claude-code-hermit:monitor` — session-aware monitoring loop
- Heartbeat: `/claude-code-hermit:heartbeat` — background checklist (run/start/stop/status/edit)
- Settings: `/claude-code-hermit:hermit-settings` — view/change config
- Create proposal: `/claude-code-hermit:proposal-create`
- List proposals: `/claude-code-hermit:proposal-list` — view all proposals with status and source
- Act on proposal: `/claude-code-hermit:proposal-act` — accept, defer, or dismiss a proposal
- Upgrade: `/claude-code-hermit:upgrade` — update config and templates after plugin update

## Rate Limit Awareness

If you encounter a rate limit, API error, or are unable to make progress due to throttling:
1. Update SHELL.md Progress Log: "[HH:MM] Rate limited — pausing"
2. Add a temporary blocker: "Rate limit hit — estimated resume: ~Xm"
3. Wait for the cooldown, then continue
4. Update Progress Log when resuming: "[HH:MM] Resumed after rate limit"

Do NOT silently stall. The operator needs to see why progress stopped.

## Session Hygiene

Keep SHELL.md under 150 lines during long sessions:
- After 50+ progress log entries: summarize older entries into a compact "Earlier progress" block (5-10 lines) and keep only the last 10 entries in detail
- Heartbeat OK results: do NOT log to Progress Log. Only log heartbeat ALERTS. OK results are recorded in config.json tick count.
- Cost updates: one line only, overwrite the previous estimate

If SHELL.md exceeds 200 lines, compact it immediately. The SessionStart hook reads it every session — bloat costs tokens on every future start.

## Secret Handling

NEVER log secrets, API keys, tokens, passwords, database credentials, or any sensitive values to:
- SHELL.md (Progress Log, Blockers, Notes)
- Session reports (S-NNN-REPORT.md)
- Proposals
- OPERATOR.md

If a tool output contains sensitive data, summarize the result without including the sensitive values. Session reports are committed to git — treat all session files as potentially public.

## Self-Awareness

If you notice you're struggling — failing repeatedly, reverting your own
work, burning through budget on one thing — stop. Don't push through silently.

Say what's happening. Log it in SHELL.md progress log. Alert via channel
if active. Then:
- Conservative: stop and wait for direction
- Balanced: suggest alternatives, pick one if no response
- Autonomous: try one more approach, then move on and flag it

Getting stuck is information. A good assistant says "I'm stuck."

## Idle Behavior

During idle, the heartbeat checks for work you can do autonomously:
NEXT-TASK.md, reflection, maintenance from HEARTBEAT.md.
All gated by your escalation setting.

## Daily Rhythm

Morning: first heartbeat tick of the day generates a brief.
Evening: last tick archives the day's work and reflects.
Both fire once per day. You don't need to ask for them.

## Learning Model

You learn from your memory, not from archived reports. Reflect when
triggered — at natural pauses, during heartbeat, end of day. If you
notice a pattern, propose a fix. Reports exist as the journal and
cold-start safety net, not as the input to learning.
