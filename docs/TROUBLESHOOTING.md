# Troubleshooting

Common issues and their solutions.

---

## Channels Not Responding

- Verify Claude Code was started with the `--channels` flag. Check the boot script output for `[hermit] Channels: discord` (or telegram).
- Check that the bot token is valid and the bot is online.
- Verify the tmux session is alive: `tmux ls`
- Check internet connectivity from the host or container.
- Telegram Bot API has no message history -- if the agent was down when a message was sent, that message is permanently lost.
- If running in Docker with `--network=none`, channels cannot work. See [ALWAYS-ON-OPS.md](ALWAYS-ON-OPS.md#86-network-and-channels).

## Hooks Not Firing

- Check `AGENT_HOOK_PROFILE` in `.claude/settings.json`. Core hooks (cost-tracker, suggest-compact, session evaluation) require `standard` or `strict`. Domain pack hooks (e.g., git-push-guard) require `strict`.
- Verify `hooks/hooks.json` is valid JSON: `cat hooks/hooks.json | python3 -m json.tool`
- Test a hook script manually: `echo '{}' | node scripts/cost-tracker.js`
- If hooks fire for the main agent but not subagents, this is a known limitation. See [ARCHITECTURE.md](ARCHITECTURE.md) for details.

## Session-Start Hangs

- **Workspace trust prompt:** If running with `--dangerously-skip-permissions` for the first time, Claude Code shows a trust dialog. Run `claude` interactively once in the project directory, accept the prompt, then restart the headless agent.
- **Orphaned ACTIVE.md:** A previous crash left an active session. The agent is waiting for you to choose "resume" or "start new." Attach to tmux and respond, or delete `sessions/ACTIVE.md` to start fresh.
- **Auth expired:** Check Claude Code auth with `claude --version`. If not authenticated, run `claude login` on the host.

## Costs Unexpectedly High

- Check `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` in settings (default 50 -- lower means more frequent compactions, which cost tokens).
- Check heartbeat interval -- `every: 5m` with an Opus-class model is expensive. Use 15m or 30m.
- Check if monitoring is running with a very short interval (`/claude-code-hermit:monitor stop` to halt).
- Review ACTIVE.md size -- bloated files cost tokens on every read. Long sessions should compact progress log entries.
- Use `/cost` to check current session spend.

## Morning Brief Not Sending

- Check `config.json`: `morning_brief.enabled` must be `true`.
- Check `config.json`: `morning_brief.channel` must match an active channel in the `channels` array.
- Verify channels are working first -- send "status" via Telegram/Discord manually.
- The brief only sends if the agent is running at the configured time. If the agent was down at 07:00, the brief is skipped.

## Agent Ignoring OPERATOR.md

- Verify the file location: `.claude/.claude-code-hermit/OPERATOR.md`
- Check the **50-line rule:** the SessionStart hook reads only the first 50 lines. Critical context (project description, constraints, sensitive areas) must be in the top 50 lines.
- Verify the SessionStart hook is registered in `hooks/hooks.json`.
- Check that `AGENT_HOOK_PROFILE` is `standard` or `strict` -- the SessionStart hook fires at these profiles.

## Orphaned Session Detected on Every Start

An `ACTIVE.md` exists from a previously crashed session. On every start, the agent asks whether to resume or start fresh.

- Choose **resume** to pick up where you left off.
- Choose **start new** to close the orphaned session (generates a partial report) and begin fresh.
- If this keeps happening, your sessions are crashing regularly. Check system stability, rate limits, disk space, and consider Docker deployment for automatic restart.
