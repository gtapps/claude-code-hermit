
---

<!-- claude-code-hermit: Session Discipline -->

## Session Discipline (claude-code-hermit)

- On startup, always check `.claude/.claude-code-hermit/sessions/SHELL.md`
- If a session is active: resume it — read the task, progress, and blockers
- If no session is active: ask the operator for a task before starting work
- Use `/claude-code-hermit:session-start` to initialize and `/claude-code-hermit:session-close` to end sessions
- Never create session or proposal files by hand — use the skills

## Always-On Session Lifecycle

When running in always-on mode (started via `hermit-start`):
- After completing a task: transition to `idle`, do NOT close the session
- Heartbeat, monitoring, and channels continue during `idle`
- New tasks start within the same session via channel or direct input
- Keep running tally in SHELL.md: tasks completed, cumulative cost
- Session only closes via `hermit-stop` or `/session-close --shutdown`

When running interactively (NOT via `hermit-start`):
- Normal lifecycle: `/session-close` archives and exits
- Heartbeat not recommended (dies when session closes)

## Agent State Directory

All autonomous agent state lives in `.claude/.claude-code-hermit/`:
- `sessions/SHELL.md` — live working document for the current session
- `sessions/S-NNN-REPORT.md` — archived session reports
- `proposals/PROP-NNN.md` — improvement proposals
- `templates/` — templates for sessions and proposals
- `OPERATOR.md` — human-curated project context and constraints

## Subagent Usage

| Agent | When to use | Model |
|-------|------------|-------|
| `session-mgr` | Session start, close, progress tracking | Sonnet |

Additional agents may be available from installed hermit agent plugins (e.g., claude-code-dev-hermit).

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
