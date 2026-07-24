# Troubleshooting

---

## Channels Not Responding

- **Not set up yet (local/tmux)?** Run `/claude-code-hermit:channel-setup` — it installs the plugin, writes the token, and guides pairing. Requires [Bun](https://bun.sh).
- Verify Claude Code was started with `--channels`. Check boot script output for `[hermit] Channels: discord`. If hermit-start printed a bun or token warning, that channel was skipped.
- Check bot token and bot online status.
- **Stale token in settings.local.json:** If `.claude/settings.local.json` has `DISCORD_BOT_TOKEN` or `TELEGRAM_BOT_TOKEN` in its `env` key, it overrides the token file at `.claude.local/channels/<plugin>/.env`. Remove the token from settings.local.json — it should only live in the channel's `.env` file. `hermit-start` cleans these automatically on boot, but if the token was added manually or by a previous channel plugin setup, it may persist.
- Verify tmux session: `tmux ls`
- If Docker `--network=none`, channels can't work.
- Telegram has no message history — messages sent while your hermit was down are lost.

## Channel Sends Not Working

Hermit uses proactive channel sends for heartbeat alerts, morning briefs, and idle transition notifications. If messages aren't arriving:

- **Check `channels.<name>.dm_channel_id`:** Outbound DM notifications require the channel-side DM ID, not the operator's user ID. This is learned automatically from the first inbound message. If it's `null`, send any message to the bot to populate it. A channel with no `dm_channel_id` is not eligible for proactive sends and the resolver will skip it.
- **Check `channels.<name>.allowed_users`:** A channel with `allowed_users: []` (explicit empty array) is treated as disabled for proactive sends and skipped by the resolver. Omitting the field, or listing one or more user IDs, both make the channel eligible. Edit via `/hermit-settings channels`.
- **Check `channels.<name>.enabled`:** `enabled: false` skips the channel. Default (omitted) is treated as enabled.
- **Verify resolver output:** run `bun ${CLAUDE_PLUGIN_ROOT}/scripts/resolve-outbound-channel.ts .claude-code-hermit`. On success it prints `{"id":"<channel>","chat_id":"<id>"}` (exit 0). On miss it prints `{"error":"no_reachable_channel"}` (exit 1). When `channels.primary` is unset the resolver returns the first eligible entry in `channels` (operator's config order); set `channels.primary: "<name>"` in `config.json` to pin a preferred channel.
- **Verify the `reply` tool is available:** Channels must be started with `--channels` for the plugin's `reply` tool to be accessible. Check boot output.
- **`channel-send-unavailable` alert:** If sends are failing, heartbeat records this as a deduped alert. Check SHELL.md Findings for the unsent message content.
- **Always-on vs interactive:** In interactive mode, channel plugins may not be running. Proactive sends only work when Claude Code is launched with `--channels`.
- **Channel unreachable or skipped?** Enable `push_notifications` in `config.json` (`true`) to receive a desktop notification (plus mobile push if Remote Control is connected) on proactive alerts. Fires when no channel is enabled (channels block absent, empty, or all entries `enabled: false`) OR when a configured channel is unreachable (missing `dm_channel_id`, empty `allowed_users`). Also fires as a last-resort signal if a successful resolve's reply call fails (e.g. token expired). In always-on Docker or headless tmux only the Remote Control mobile push will be visible. Push is one-way — operator→hermit replies (micro-proposals, session recovery prompts) still require a channel. Toggle via `/claude-code-hermit:hermit-settings push-notifications`.

---

## Scheduled Checks Not Running

Scheduled checks run during idle reflection via `reflect`. If configured checks aren't being invoked:

- **Check `scheduled_checks` in config.json:** Must have entries with `enabled: true`. View with `/hermit-settings scheduled-checks`.
- **Check reflection cadence:** Reflection runs every 4+ hours during idle. If the hermit is always `in_progress`, scheduled checks won't fire (they're idle-only).
- **Unavailable suppression:** If a check's skill is missing or uninstalled, the check is suppressed for 4 hours (transient cooldown). A persistent `error` outcome suppresses for `interval_days`. Check `state/reflection-state.json` for `last_unavailable_at` and `last_error_at`.
- **One per reflect:** Only one scheduled check runs per reflect invocation. If multiple are due, the oldest fires first.

---

## `$CLAUDE_PLUGIN_ROOT` Empty in Skill Bash Calls

`$CLAUDE_PLUGIN_ROOT` is injected by Claude Code's harness in hook invocations but is not forwarded to the tmux shell environment in always-on mode. This means Bash tool calls inside skills that use `${CLAUDE_PLUGIN_ROOT}` may fail in cron-triggered sessions.

**Fixed in hermit-start.ts** (v1.0.16+): the env file written before launching the tmux session now derives and exports `CLAUDE_PLUGIN_ROOT` from hermit-start.ts's own location. Upgrade hermit to get the fix; no operator action needed.

**If still occurring after upgrade:** verify the always-on session was restarted (Docker: `.claude-code-hermit/bin/hermit-docker down && .claude-code-hermit/bin/hermit-docker up`; tmux: stop the running `bin/hermit-start` session and relaunch). The env file is only written at launch.

---

## Hooks Not Firing

- Check `AGENT_HOOK_PROFILE` in `config.json` `env` (written to `.claude/settings.local.json` at boot). Core hooks need `standard` or `strict`. Hermit hooks (e.g., git-push-guard) need `strict`. View/change with `/hermit-settings env`.
- Validate hooks.json: `cat hooks/hooks.json | python3 -m json.tool`
- Test manually: `echo '{}' | bun scripts/cost-tracker.ts`
- Hooks may not fire for subagent tool calls — see [Architecture](architecture.md).

## Session-Start Hangs

- **Workspace trust:** Run `claude` interactively once first and accept the trust prompt. Then restart headless.
- **Orphaned SHELL.md:** A crash left an active session. Attach to tmux and choose resume/new, or delete `sessions/SHELL.md`.
- **Auth expired:** Check with `claude --version`. Run `claude /login` if needed.

## Costs Unexpectedly High

- Check `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` in `config.json` `env` (default 65). Adjust with `/hermit-settings env`.
- Check heartbeat interval — 5m with Opus is expensive. Default is 2h; use 15m-30m only if you need faster monitoring.
- Check if watches are running with short intervals (`/claude-code-hermit:watch stop`).
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

## Stuck "shutting down" / orphaned process

If `hermit-stop` reports survivors or exits non-zero, a claude process outlived the stop — the process tree was verified and did not fully exit (`last_error: orphaned_process`). Find it with `pgrep -af "claude --channels"` and `kill` the reported PID.

After a survivor-blocked stop the shutdown gate keeps the channel silent, because `shutdown_requested_at` stays set (never paired with a `shutdown_completed_at`) and every inbound message gets a deterministic "shutting down" reply. To un-stick without killing anything, either boot again — a fresh `hermit-start` / `hermit-docker up` clears the shutdown stamps for the same project — or manually null `shutdown_requested_at` in `.claude-code-hermit/state/runtime.json`.

## Routines Not Firing

- Check the `routines` array in config.json — each routine must have `enabled: true`.
- Verify state: `/claude-code-hermit:hermit-routines status`. Monitor mode shows the monitor's liveness + interval and the anchor's CronList entry; fallback mode lists one CronCreate per enabled routine, prefixed with `[hermit-routine:<id>]`.
- If `status` shows nothing loaded: confirm `always_on: true` in config.json (only always-on hermits auto-register on launch). Manual fix: run `/claude-code-hermit:hermit-routines load`.
- Inspect fire history: `tail .claude-code-hermit/state/routine-metrics.jsonl` — a `started` (or `fired`) event means the routine ran; `skipped-waiting` means `run_during_waiting: false` suppressed it because session was `waiting`; `skipped-paused` means the hermit was paused. The `delivery` field is `monitor` or `cron-create`.
- **Monitor mode** defers only while an operator turn is genuinely open — a `state/operator-turn-open.json` marker written on operator prompts and cleared at Stop (60-min TTL backstop against an orphaned marker). A stuck `session_state: in_progress` no longer starves routines on its own. A mark deferred past the 24h scan window **is** dropped — only the latest occurrence fires, there's no catch-up.
- **CronCreate fallback/anchor mode** is idle-gated by the harness. If Claude was mid-task when the cron time hit, the fire is **deferred until idle, not dropped**. Long mid-task spans push fires later but never lose them. CronCreate auto-expires after 7 days — the daily `heartbeat-restart` routine (4am) re-runs `load` to reset the clock; if you've disabled it, fallback-mode routines will silently stop firing after a week.

## Routine Monitor Not Ticking

- Run `/claude-code-hermit:hermit-doctor` and check the `routine-monitor` line. `ok` naming `croncreate-fallback mode` means Monitor is unavailable on this platform (Bedrock/Google Cloud Agent Platform/Foundry, or `DISABLE_TELEMETRY`/`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`) and routines are running via CronCreate instead — nothing to fix.
- `fail` naming "Monitor subprocess spawn likely blocked" usually means seccomp or nested-user-namespace restrictions inside a container prevented the subprocess from starting — the same failure mode that blocks `/watch` streams and the heartbeat monitor. Check `state/routine-monitor-liveness.json` for a `last_peek_at` timestamp; if it's missing or stale, the subprocess isn't running.
- `/claude-code-hermit:hermit-routines load` re-registers the monitor and, if registration or liveness-verify fails, automatically falls back to CronCreate — re-run it after fixing the underlying container/sandbox restriction to return to monitor mode.

## Idle Agency Not Working

- Check `idle_behavior` in config.json — must be `"discover"` for maintenance tasks. `"wait"` only checks tasks and channels.
- Your hermit must be in `idle` state (check `session_state` in `.claude-code-hermit/state/runtime.json`). Idle agency only runs between tasks.
- NEXT-TASK.md pickup is gated by escalation level: `conservative` only alerts, `balanced` auto-starts, `autonomous` runs fully unattended.
- If no NEXT-TASK.md exists: idle agency runs reflection (every 4+ hours), then priority alignment via OPERATOR.md context.

## Morning Brief Not Sending

- See "Routines Not Firing" above — the morning brief is a routine (`claude-code-hermit:brief --morning`).
- Verify channels work first — send "status" manually from your phone.

## Hermit Keeps Suggesting Dismissed Proposals

Reflect checks dismissed and deferred proposals before creating new ones. If you're still seeing re-suggestions:

- Run `/claude-code-hermit:hermit-evolve` to ensure the latest reflect skill is active.
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
- **Ubuntu 26.04 default user conflict:** UID 1000 is taken by the default `ubuntu` user. The generated Dockerfile runs `userdel -r ubuntu` first — don't remove this line.
- **Rebuild after config changes:** If you changed `docker.packages` in config.json, rebuild: `docker compose -f docker-compose.hermit.yml build --no-cache`

## Upgrade Says Nothing to Update

- Check plugin version: `cat .claude-plugin/plugin.json | grep version` (or check the installed plugin path).
- Check config version: `cat .claude-code-hermit/config.json | grep _hermit_versions`.
- If both match, there's genuinely nothing to upgrade. New features may have landed as skill changes (no config migration needed).
- If the plugin was updated but the marketplace cache is stale: `claude plugin marketplace add gtapps/claude-code-hermit` to force refresh, then reinstall. `hermit-docker update` / `hermit-update` refresh the catalog automatically before moving pins, so this manual step is mainly for driving `plugin update` by hand.

## Docker Container Keeps Restarting

Check logs first:

```bash
.claude-code-hermit/bin/hermit-docker logs
```

Common causes:

- **Auth expired:** `hermit-docker login` to re-authenticate, then `hermit-docker restart`. On a hermit using a long-lived login token, use `hermit-docker setup-token` instead — see below.
- **Workspace trust not accepted:** Attach once (`hermit-docker attach`), accept the trust prompt, then detach (`Ctrl+B, D`).
- **Missing `.env`:** If using API key auth, ensure `.env` exists with `ANTHROPIC_API_KEY` set.

## Hermit Went Dark / Authentication Errors

If the hermit stops responding and the logs show `401` or `Invalid authentication credentials`, its login has lapsed.

**On a hermit using a long-lived login token, you shouldn't need to do anything from a terminal.** Within a few minutes the watchdog messages you on your channel saying it's down and asking you to reply `reauth`. Do that when you're at a browser; it sends a one-time sign-in link, takes the code back, and restarts itself. Nothing is minted until you reply, so a link never expires unused.

To check or drive it yourself:

```bash
# What auth is this hermit on, and when does it expire?
.claude-code-hermit/bin/hermit-docker bash -c \
  '.claude-code-hermit/bin/hermit-run setup-token-mint status'

# Renew from the terminal instead of over chat
.claude-code-hermit/bin/hermit-docker setup-token
```

Notes:

- **Never run `/logout` inside the container.** It wipes the stored credentials *and* resets first-launch state, after which the interactive wizard demands a login and refuses the token — turning a two-minute renewal into a rebuild. Renewal never needs it.
- If the relay never messages you, the hermit has no reachable channel. It stops rather than minting a link it can't deliver; renew from the terminal with `hermit-docker setup-token`.
- `hermit-docker login` on a token-mode hermit deliberately does nothing but tell you so — the hermit authenticates with its login token, not `/login` credentials.
- The original login's `.credentials.json` is parked to `.credentials.json.pre-token.bak` when the token installs (and at boot). This matters: an interactive session prefers a stored `/login` credential over the token, so a hermit that kept the file would 401 once that stored login lapsed (~8h), even with a valid year-long token. If you converted before this behavior shipped and the hermit is dark, park it by hand (`mv .../.credentials.json .../.credentials.json.pre-token.bak`) and restart.

## Permission Denied Inside Container

Usually a UID mismatch between the host and the container user. The generated Dockerfile creates a `claude` user matching your host UID. If you changed your system user or are running on a different machine:

1. Check your host UID: `id -u`
2. Rebuild the image: `docker compose -f docker-compose.hermit.yml build --no-cache`

## Channel Messages Not Arriving

**Docker:**
- Verify the channel plugin is installed inside the container: `hermit-docker attach`, then check with `claude plugin list`.
- Check bot pairing: send a test message to the bot and watch the logs (`hermit-docker logs`).
- For Discord: ensure `channels.discord.state_dir` is set in `config.json` (e.g. `.claude.local/channels/discord`) and the directory is bind-mounted in `docker-compose.hermit.yml`. `hermit-start` resolves relative paths and derives `DISCORD_STATE_DIR` at boot.
- For Telegram: ensure `channels.telegram.state_dir` is set and the bot token is in the state directory's `.env` file.

**Local/tmux:**
- Run `/claude-code-hermit:channel-setup` to verify and repair the full setup (bun, plugin, token, pairing, access.json location).
- Check `hermit-start` output for bun or token warnings — the channel is skipped if either is missing.
