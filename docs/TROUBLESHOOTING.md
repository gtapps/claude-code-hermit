# Troubleshooting

---

## Channels Not Responding

- Verify Claude Code was started with `--channels`. Check boot script output for `[hermit] Channels: discord`.
- Check bot token and bot online status.
- Verify tmux session: `tmux ls`
- If Docker `--network=none`, channels can't work.
- Telegram has no message history — messages sent while your hermit was down are lost.

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

- Reflection runs at task boundaries, during heartbeat idle checks, and at end of day. If you're closing sessions before finishing work, reflection may not trigger.
- Check that `idle_agency` is enabled in config — without it, idle-time reflection won't fire.
- If you just started using Hermit, give it a few sessions to build up memory. Proposals come from patterns, and patterns take repetition.
- Check proposals exist: `ls .claude-code-hermit/proposals/PROP-*.md`

## Agent Ignoring OPERATOR.md

- Verify location: `.claude-code-hermit/OPERATOR.md`
- **50-line rule:** The SessionStart hook reads only the first 50 lines. Critical context must be at the top.
- Verify the SessionStart hook is registered in `hooks/hooks.json`.

## Orphaned Session on Every Start

SHELL.md from a crashed session persists. Choose **resume** or **start new** (generates a partial report). If this keeps happening, check system stability, rate limits, disk space, and consider Docker for auto-restart.

## Daily Routines Not Firing

- Check `heartbeat.morning_routine` and `heartbeat.evening_routine` are `true` in config.json.
- Routines are tied to `active_hours` — morning fires on the first heartbeat tick after `active_hours.start`, evening fires on the last tick before `active_hours.end`.
- The heartbeat must be running. In interactive mode, it only runs during idle. In always-on mode, it runs continuously.
- Each routine fires once per day — check `_last_morning` and `_last_evening` in config.json to see if they already ran today.
- Verify your timezone is set correctly: `/claude-code-hermit:hermit-settings timezone`.

## Idle Agency Not Working

- Check `heartbeat.idle_agency` is `true` in config.json.
- Your hermit must be in `idle` state (check SHELL.md status). Idle agency only runs between tasks.
- NEXT-TASK.md pickup is gated by escalation level: `conservative` only alerts, `balanced` auto-starts, `autonomous` runs fully unattended.
- If no NEXT-TASK.md exists, idle agency falls back to reflection (every 4+ hours) and HEARTBEAT.md maintenance.

## Morning Brief Not Sending

- Check `heartbeat.morning_routine` is `true` in config.json.
- Verify channels work first — send "status" manually from your phone.
- The brief only sends if the heartbeat is running at the start of your active hours. In interactive mode, this means you need an active session.
- Check `_last_morning` in config.json — if it shows today's date, the brief already ran.
