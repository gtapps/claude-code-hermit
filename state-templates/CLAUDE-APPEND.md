
---

<!-- claude-code-hermit: Session Discipline -->

## Session Discipline (claude-code-hermit)

- On startup, check `.claude-code-hermit/sessions/SHELL.md`
- If active (`in_progress`/`waiting`): resume — read task, check plan via `TaskList`, check blockers
- If `idle`: ask what to help with
- If none: ask what to help with
- Use `/claude-code-hermit:session-start` and `/claude-code-hermit:session-close`

## Agent State

| Path | Contents |
|------|----------|
| `sessions/SHELL.md` | Live working document |
| `sessions/S-NNN-REPORT.md` | Archived reports |
| `proposals/PROP-NNN.md` | Improvement proposals |
| `state/` | Runtime state (alert dedup, reflection, routine queue, metrics) |
| `OPERATOR.md` | Human-curated context (read-only for agent) |

## Subagent: `session-mgr` (Sonnet) — session lifecycle

## Quick Reference

`/session` `/session-close` `/pulse` `/brief` `/heartbeat` `/hermit-settings` `/proposal-list` `/proposal-act` `/proposal-create` `/hermit-upgrade` `/docker-setup` `/hermit-takeover` `/hermit-hand-back`
(All prefixed with `/claude-code-hermit:`)

## Rules

- **Rate limits:** Log pause/resume in Progress Log. Never silently stall.
- **Self-awareness:** If stuck — say so, log it, alert via channel. Don't push through silently.
- **Secrets:** Never log API keys, tokens, passwords, or credentials to SHELL.md, reports, or proposals. Session files may be committed to git.
- **Proposals mandatory:** Every improvement goes through `/proposal-create` → operator accepts → implement. Trivial fixes (typos, one-liners) exempt.
- **Tasks:** Use `TaskCreate`/`TaskUpdate` for multi-step work. `tasks-snapshot.md` is auto-generated — don't edit.
