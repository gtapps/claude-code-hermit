
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
| `reviews/` | Weekly review reports |
| `state/` | Runtime state (alert dedup, reflection, routine queue, metrics) |
| `OPERATOR.md` | Human-curated context (read-only for agent) |

## Subagent: `session-mgr` (Sonnet) — session lifecycle

## Quick Reference

`/session` `/session-close` `/pulse` `/brief` `/heartbeat` `/hermit-settings` `/proposal-list` `/proposal-act` `/proposal-create` `/hermit-evolve` `/docker-setup` `/hermit-takeover` `/hermit-hand-back` `/obsidian-setup` `/connections-refresh` `/weekly-review`
(All prefixed with `/claude-code-hermit:`)

## Operator Notification

When you need to notify the operator proactively:

- If no channels are configured, respond in conversation.
- If a channel is configured and there is exactly one allowed user for that channel:
  - Read `config.json` → `channels.<channel>.dm_channel_id` (e.g. `channels.discord.dm_channel_id`).
  - **If found:** use that value as `chat_id` in the channel plugin's `reply` tool call.
  - **If not found:** the DM channel ID is unknown (no inbound message received yet). Log the unsent content to SHELL.md Findings and record a deduped `channel-send-unavailable` issue — do not use the user ID as a substitute (it will fail for Discord DMs).
- If outbound send fails, or if there is no unambiguous outbound target:
  - Log the unsent content to SHELL.md Findings
  - Record a deduped `channel-send-unavailable` issue if appropriate
  - Continue without retry spam

## Rules

- **Rate limits:** Log pause/resume in Progress Log. Never silently stall.
- **Self-awareness:** If stuck — say so, log it, alert via channel. Don't push through silently.
- **Secrets:** Never log API keys, tokens, passwords, or credentials to SHELL.md, reports, or proposals. Session files may be committed to git.
- **Proposals mandatory:** Every improvement goes through `/proposal-create` → operator accepts → implement. Trivial fixes (typos, one-liners) exempt.
- **Tasks:** Use `TaskCreate`/`TaskUpdate` for multi-step work. `tasks-snapshot.md` is auto-generated — don't edit.
