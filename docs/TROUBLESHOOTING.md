# Troubleshooting

---

## Channels Not Responding

- Verify Claude Code was started with `--channels`. Check boot script output for `[hermit] Channels: discord`.
- Check bot token and bot online status.
- **Stale token in settings.local.json:** If `.claude/settings.local.json` has `DISCORD_BOT_TOKEN` or `TELEGRAM_BOT_TOKEN` in its `env` key, it overrides the token file at `.claude.local/channels/<plugin>/.env`. Remove the token from settings.local.json — it should only live in the channel's `.env` file. `hermit-start` cleans these automatically on boot, but if the token was added manually or by a previous channel plugin setup, it may persist.
- Verify tmux session: `tmux ls`
- If Docker `--network=none`, channels can't work.
- Telegram has no message history — messages sent while your hermit was down are lost.

## Hooks Not Firing

- Check `AGENT_HOOK_PROFILE` in `config.json` `env` (written to `.claude/settings.local.json` at boot). Core hooks need `standard` or `strict`. Hermit hooks (e.g., git-push-guard) need `strict`. View/change with `/hermit-settings env`.
- Validate hooks.json: `cat hooks/hooks.json | python3 -m json.tool`
- Test manually: `echo '{}' | node scripts/cost-tracker.js`
- Hooks may not fire for subagent tool calls — see [Architecture](ARCHITECTURE.md).

## Session-Start Hangs

- **Workspace trust:** Run `claude` interactively once first and accept the trust prompt. Then restart headless.
- **Orphaned SHELL.md:** A crash left an active session. Attach to tmux and choose resume/new, or delete `sessions/SHELL.md`.
- **Auth expired:** Check with `claude --version`. Run `claude login` if needed.

## Costs Unexpectedly High

- Check `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` in `config.json` `env` (default 50). Adjust with `/hermit-settings env`.
- Check heartbeat interval — 5m with Opus is expensive. Use 15m or 30m.
- Check if monitors are running with short intervals (`/claude-code-hermit:monitor stop`).
- Review SHELL.md size — bloated files cost tokens on every read.
- Use `/cost` to check current session spend.

## No Auto-Proposals Appearing

- Reflection runs at task boundaries, during heartbeat idle checks, and at end of day. If you're closing sessions before finishing work, reflection may not trigger.
- Check that `idle_behavior` is set to `"discover"` in config — without it, idle-time reflection won't fire.
- If you just started using Hermit, give it a few sessions to build up memory. Proposals come from patterns, and patterns take repetition.
- Check proposals exist: `ls .claude-code-hermit/proposals/PROP-*.md`

## Agent Ignoring OPERATOR.md

- Verify location: `.claude-code-hermit/OPERATOR.md`
- **50-line rule:** The SessionStart hook reads only the first 50 lines. Critical context must be at the top.
- Verify the SessionStart hook is registered in `hooks/hooks.json`.

## Orphaned Session on Every Start

SHELL.md from a crashed session persists. Choose **resume** or **start new** (generates a partial report). If this keeps happening, check system stability, rate limits, disk space, and consider Docker for auto-restart.

## Routines Not Firing

- Check the `routines` array in config.json — each routine must have `enabled: true`.
- Routines are managed by the routine watcher, which runs in its own tmux window. Check it: `tmux select-window -t <session>:routines`.
- Each routine fires once per day — check `/tmp/hermit-routines-<session>` for dedup state to see if a routine already fired today.
- Verify your timezone is set correctly: `/claude-code-hermit:hermit-settings timezone`. The routine watcher reads `config.timezone` and sets `TZ=`.
- Check `.claude-code-hermit/.status` — if stuck on `in_progress`, routines skip (they only fire during idle).

## Idle Agency Not Working

- Check `idle_behavior` in config.json — must be `"discover"` for maintenance tasks. `"wait"` only checks tasks and channels.
- Your hermit must be in `idle` state (check SHELL.md status). Idle agency only runs between tasks.
- NEXT-TASK.md pickup is gated by escalation level: `conservative` only alerts, `balanced` auto-starts, `autonomous` runs fully unattended.
- If no NEXT-TASK.md exists: idle agency picks up `IDLE-TASKS.md` items (first unchecked, capped by `idle_budget`), then falls back to reflection (every 4+ hours), then priority alignment via OPERATOR.md context.

## Morning Brief Not Sending

- See "Routines Not Firing" above — the morning brief is a routine (`claude-code-hermit:brief --morning`).
- Verify channels work first — send "status" manually from your phone.

## Hermit Keeps Suggesting Dismissed Proposals

As of v0.0.8, reflect checks dismissed and deferred proposals before creating new ones. If you're still seeing re-suggestions:
- Check your plugin version: the proposal is in `.claude-plugin/plugin.json` — should be `0.0.8` or later.
- Run `/claude-code-hermit:hermit-upgrade` to ensure the latest reflect skill is active.
- If significantly more evidence has accumulated since the dismissal, Hermit may intentionally revisit — this is by design.

## SHELL.md Getting Large / Bloated

A bloated SHELL.md costs tokens on every read. Keep it lean:
- Use `/compact` between steps to free context.
- The progress log should stay under ~30 entries. If it's growing beyond that, close the session and start a new one.
- The `session-diff` hook auto-populates `## Changed` — don't manually list files.
- If SHELL.md is already bloated, run `/claude-code-hermit:session-close` to archive it and start fresh.

## Docker Build Fails

Common causes:
- **UID mismatch:** The Dockerfile matches your host UID. If you're not UID 1000, rebuild after checking `id -u`. The generated Dockerfile should handle this, but manual edits may break it.
- **Network issues during build:** `apt-get` or `npm install` fails. Check your network, proxy settings, and Docker DNS config.
- **npm permission errors:** Claude Code installs globally. The Dockerfile sets `NPM_CONFIG_PREFIX` for the `claude` user — if you modified the Dockerfile, ensure this is preserved.
- **Ubuntu 24.04 default user conflict:** UID 1000 is taken by the default `ubuntu` user. The generated Dockerfile runs `userdel -r ubuntu` first — don't remove this line.
- **Rebuild after config changes:** If you changed `docker.packages` in config.json, rebuild: `docker compose -f docker-compose.hermit.yml build --no-cache`

## Upgrade Says Nothing to Update

- Check plugin version: `cat .claude-plugin/plugin.json | grep version` (or check the installed plugin path).
- Check config version: `cat .claude-code-hermit/config.json | grep _hermit_versions`.
- If both match, there's genuinely nothing to upgrade. New features may have landed as skill changes (no config migration needed).
- If the plugin was updated but the marketplace cache is stale: `claude plugin marketplace add gtapps/claude-code-hermit` to force refresh, then reinstall.

