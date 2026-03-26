# Troubleshooting

---

## Channels Not Responding

- Verify Claude Code was started with `--channels`. Check boot script output for `[hermit] Channels: discord`.
- Check bot token and bot online status.
- Verify tmux session: `tmux ls`
- If Docker `--network=none`, channels can't work.
- Telegram has no message history — messages sent while the agent was down are lost.

## Hooks Not Firing

- Check `AGENT_HOOK_PROFILE` in `.claude/settings.json`. Core hooks need `standard` or `strict`. Hermit hooks (e.g., git-push-guard) need `strict`.
- Validate hooks.json: `cat hooks/hooks.json | python3 -m json.tool`
- Test manually: `echo '{}' | node scripts/cost-tracker.js`
- Hooks may not fire for subagent tool calls — see [Architecture](ARCHITECTURE.md).

## Session-Start Hangs

- **Workspace trust:** Run `claude` interactively once first and accept the trust prompt. Then restart headless.
- **Orphaned SHELL.md:** A crash left an active session. Attach to tmux and choose resume/new, or delete `sessions/SHELL.md`.
- **Auth expired:** Check with `claude --version`. Run `claude login` if needed.

## Costs Unexpectedly High

- Check `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` (default 50).
- Check heartbeat interval — 5m with Opus is expensive. Use 15m or 30m.
- Check if monitors are running with short intervals (`/claude-code-hermit:monitor stop`).
- Review SHELL.md size — bloated files cost tokens on every read.
- Use `/cost` to check current session spend.

## No Auto-Proposals Appearing

- Pattern detection requires **3+ completed sessions**. Until then, it's skipped entirely.
- Check that session reports exist: `ls .claude/.claude-code-hermit/sessions/S-*-REPORT.md`
- Pattern detection runs during `/session-close`, not during work.

## Agent Ignoring OPERATOR.md

- Verify location: `.claude/.claude-code-hermit/OPERATOR.md`
- **50-line rule:** The SessionStart hook reads only the first 50 lines. Critical context must be at the top.
- Verify the SessionStart hook is registered in `hooks/hooks.json`.

## Orphaned Session on Every Start

SHELL.md from a crashed session persists. Choose **resume** or **start new** (generates a partial report). If this keeps happening, check system stability, rate limits, disk space, and consider Docker for auto-restart.

## Morning Brief Not Sending

- `config.json`: `morning_brief.enabled` must be `true`, `morning_brief.channel` must match an active channel.
- Verify channels work first — send "status" manually.
- The brief only sends if the agent is running at the configured time.
