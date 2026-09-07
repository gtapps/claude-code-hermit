# Always-On Operations (Non-Docker)

tmux-based setup for running your hermit without Docker, plus the lifecycle reference that applies to all always-on modes. For Docker setup, see [Always-On Setup](always-on.md).

---

## Prerequisites

| Requirement              | For          | Notes                                      |
| ------------------------ | ------------ | ------------------------------------------ |
| **tmux**                 | Boot scripts | `brew install tmux` / `apt install tmux` — see [Installing tmux](https://github.com/tmux/tmux/wiki/Installing) for other platforms |
| **Node.js 22+**          | Hooks        | Cost tracking, session evaluation          |
| **Claude Code v2.1.263+** | Channels, sandbox | Minimum supported version |

tmux is required. Channels are optional.

---

## 1. Starting a Persistent Session

```bash
cd /path/to/your/project
.claude-code-hermit/bin/hermit-start
```

This reads `config.json`, starts a tmux session with your configured channels and permissions, and auto-runs `/claude-code-hermit:session`. To stop:

```bash
.claude-code-hermit/bin/hermit-stop        # graceful (sends /session-close first)
.claude-code-hermit/bin/hermit-stop --force # immediate kill
```

To pause/resume the running session without stopping it (also triggerable from a channel via the `/pause`/`/resume`/`/snooze <dur>` message commands):

```bash
.claude-code-hermit/bin/hermit-pause on|off|snooze <dur>|status
```

**Config options:** If `remote: true`, adds `--remote-control` and names the session after `agent_name`. If `remote: false`, boot writes `isolatePeerMachines: true`, so cross-machine peer messages require operator approval. If `model` is set, passes it to Claude Code.

**Restarting dead sessions.** The first tmux always-on boot (`hermit-start`) registers the watchdog scheduler on a 5-minute schedule (systemd user timer on Linux/WSL2, LaunchAgent on macOS, a cron line printed as fallback). That tick restarts dead sessions, nudges wedged ones, and keeps long-running context compacted. The first registration also sets `watchdog.enabled: true` in `config.json`; a repair re-run of install leaves that setting as you have it. Opt out with `.claude-code-hermit/bin/hermit-watchdog uninstall` — it removes the timer and sets both flags off. Setting `watchdog.scheduler_enabled: false` by hand only stops future boots from re-registering; an already-installed timer keeps ticking. On Linux add `loginctl enable-linger` if the hermit has to come back after a reboot before anyone logs in. Docker hermits need none of this: the entrypoint runs the same watchdog on its own cycle, and the container restart policy handles a dead session.

### Manual tmux (alternative)

```bash
tmux new-session -d -s hermit
tmux attach -t hermit
cd /path/to/your/project
claude --permission-mode auto
```

> **Why `--permission-mode auto`?** The default `auto` mode lets a classifier review each action before it runs — safer than `bypassPermissions`, more reviewed than `acceptEdits`. Deny patterns and hooks provide an additional safety layer. **Run `claude` interactively once first** to accept the workspace trust prompt — without this, the agent hangs in tmux.
>
> For fully unattended containers/VMs where any pause would stall the hermit, set `permission_mode: "bypassPermissions"` in `config.json` — `hermit-start` maps this to `--dangerously-skip-permissions`. See [Always-On Setup](always-on.md) for the Docker workflow and [Permission Modes](https://code.claude.com/docs/en/permission-modes).

### Remote access

[Remote control](https://code.claude.com/docs/en/remote-control) connects from any browser or phone. Enable via config (`/hermit-settings remote`) or `--remote-control`. Connect at [claude.ai/code](https://claude.ai/code).

To spawn *new* sessions into a project from your phone, run `/claude-code-hermit:rc-gate` yourself — the hermit does not open the gate on its own — or supervise a standalone server per project with the systemd recipe in [Remote Endpoint](remote-endpoint.md). Both need a claude.ai `/login` on the machine.

---

## 2. Always-On Lifecycle

> The lifecycle below applies to both interactive and always-on sessions — Docker or tmux. This is the core reference for how sessions behave.

In always-on mode, the session stays open between tasks. Heartbeat, monitors, and channels keep running the whole time. Your hermit works, finishes, waits for the next thing — and stays productive in between.

### State flow

```
hermit-start -> [in_progress] -> task done -> [idle] -> new task -> [in_progress] -> ...
                      |                                                               |
                      +---> blocked on input -> [waiting] --+                         |
                      |                                     |                         |
                      |     timeout or operator reply ------+-> [idle] or [in_progress]
                      |                                                               |
                      +-------------------------------hermit-stop -> [archived]
```

1. `hermit-start` sets `always_on: true`, launches Claude Code in tmux
2. Work finishes — **idle transition**: report archived, SHELL.md reset, heartbeat keeps running
3. New request comes in (channel, NEXT-TASK.md, terminal) — back to `in_progress`
4. Blocked on operator input — **waiting transition**: session stays open, heartbeat skips stale checks, configurable `waiting_timeout` auto-transitions to idle
5. `hermit-stop` — **full shutdown**: close task, stop heartbeat, archive, kill tmux

### Close modes

|                     | Idle Transition (task boundary)                                            | Waiting (blocked on input)     | Auto-Close (12h idle OR midnight + 10min lull) | Full Shutdown (`/session-close`) |
| ------------------- | -------------------------------------------------------------------------- | ------------------------------ | ---------------------------------------------- | -------------------------------- |
| **When**            | Work done — automatic                                                      | Blocked on operator input      | 12h since last operator action, OR midnight daily-routine fires and operator goes idle ≥10min | You explicitly close             |
| **Report archived** | Yes                                                                        | No (session stays open)        | Yes (frontmatter `closed_via: auto`)           | Yes                              |
| **Reflection runs** | Yes                                                                        | No                             | No (deferred to next session's heartbeat cycle) | Yes                              |
| **Heartbeat**       | Keeps running (or starts)                                                  | Runs (skips stale checks)      | Keeps running                                  | Stopped                          |
| **Monitors**        | Keep running                                                               | Keep running                   | Keep running                                   | Stopped (TaskStop + registry cleared) |
| **Channels**        | Keep running (always-on only)                                              | Keep running                   | Keep running                                   | Stopped                          |
| **SHELL.md**        | Reset in-place, Monitoring & Summary compacted if over threshold           | Unchanged (state in runtime.json) | Replaced with fresh template                | Replaced with fresh template     |
| **Applies to**      | Both interactive and always-on                                             | Both interactive and always-on | Both interactive and always-on                 | Both interactive and always-on   |

Default: idle transition when work finishes. Waiting when blocked on operator input (configurable `waiting_timeout` auto-transitions to idle). Auto-close on either 12h operator inactivity OR the daily midnight routine once the operator is idle ≥10 min; a queued midnight close can be drained by either heartbeat or the Monitor-mode routine poll, both of which additionally defer while an operator turn is open and share one drain backoff marker (30 minutes, halved by the heartbeat drainer once `heartbeat.every` reaches 30 minutes). Neither threshold is configurable. Full shutdown only via explicit `/session-close` or `hermit-stop`.

### How sessions compound

```
  Task 1 -> work -> complete -> archive S-001
  Task 2 -> work -> complete -> archive S-002
  Task 3 -> work -> complete -> archive S-003
     |-- Reflection fires at task boundaries and idle checks
     |-- Auto-proposals created if patterns noticed

  Throughout: heartbeat ticks on schedule
  Morning: brief + priority check. Evening: daily journal.
```

**Hooks fire throughout the session:** `cost-tracker.ts` (costs), `session-diff.ts` (changed files), and `evaluate-session.ts` (quality nudges) run on every assistant turn (Stop). `channel-hook.ts` + `heartbeat-touch.ts` run on tool use (PostToolUse). Banned commands are native `permissions.deny` / `permissions.ask` entries, not a PreToolUse hook.

### When learning fires

Your hermit reflects on its own memory — not archived reports. Reflection triggers at these moments:

| Trigger              | When                                          |
| -------------------- | --------------------------------------------- |
| Task boundary        | After completing work, during idle transition |
| Heartbeat idle check | Every 4+ hours during idle                    |
| Evening routine      | Last heartbeat tick of the day                |
| Session close        | Before archiving the final report             |

**Feedback loop:** When an accepted proposal's pattern stops recurring (based on memory), it auto-resolves. The heartbeat self-evaluates every 20 ticks — suggesting stale checks to remove and relevant ones to add.

**Cost model:** Heartbeat EVALUATE runs in an isolated-context subagent (fresh ~40k context, not the main session's 200k–500k). It reads only files and needs none of the inherited conversational history. The main session applies the resulting writes and notifications. After a clean EVALUATE, the `clean_recheck_cooldown` (default `"6h"`) suppresses re-evaluation until a change-detecting gate (stale session, micro-proposal, pending-close, suppressed-digest) fires — reducing LLM wakes to ~3× per active-day for a healthy hermit.

### Daily rhythm

If routines are configured (default after init or upgrade):

- **Morning routine** — `brief --morning` at configured time (default: active hours start + 30m): generates a brief, reviews pending proposals, checks priorities. Framing adapts to `always_on` setting.
- **Evening routine** — `brief --evening` at configured time (default: active hours end - 30m): summarizes the day's work, archives via session-close, flags tomorrow's priorities.

Both fire from `/claude-code-hermit:hermit-routines` — a persistent Monitor subprocess where available, per-session CronCreate jobs as fallback. Configure with `/claude-code-hermit:hermit-settings routines`.

### Idle agency

When the session is idle, the heartbeat tick checks `sessions/NEXT-TASK.md` and picks up an accepted proposal left there, gated by escalation level: `conservative` sends one notice and parks the session in `waiting`, `balanced` and `autonomous` start it via `session-start`. Pickup requires `always_on` — an interactive hermit is presented the queued task at its next `session-start` instead.

Reflection is not driven by idleness; it runs on the `reflect` schedule under `/claude-code-hermit:hermit-routines`.

`idle_behavior` (`"discover"` / `"wait"`, set via `/hermit-settings idle`) is reserved and currently makes no difference to any of this. `"discover"` previously added a priority-alignment pass against OPERATOR.md and the cost log; that pass was removed when pickup moved into the tick.

### Edge cases

- **Crash during work:** SHELL.md persists. On restart, offers to resume.
- **Crash during idle:** SHELL.md persists as `idle`. Asks what to work on next.
- **Crash during waiting:** SHELL.md persists as `waiting`. On restart, re-enters waiting state and checks for operator response.
- **hermit-start when already running:** Checks `state/runtime.json` before reporting health. Valid → prints attach guidance and exits 0. Missing, unreadable, or carrying no lifecycle record (`runtime_mode`/`tmux_session` empty) → exits 1 and tells you to restart the session: lifecycle state can't be rebuilt for a session already in flight, and inventing it would erase the `transition` / `last_error` markers session-start recovery reads. Until you restart, attach and the watchdog stay degraded.
- **Docker SIGTERM:** The entrypoint traps SIGTERM and attempts a graceful session close (30s timeout) before the container exits. Sessions are archived even on raw `docker compose down`.

---

## Routines

Routines are time-triggered skills managed by the `/claude-code-hermit:hermit-routines` skill. Where the Monitor tool is available, all enabled routines except `heartbeat-restart` run from one persistent Monitor subprocess: it evaluates every routine's cron schedule directly (no LLM needed to check the clock), so a skipped fire costs zero model tokens and routines due in the same poll batch into a single wake. `heartbeat-restart` stays a CronCreate re-arm anchor that keeps the monitor alive. Where Monitor is unavailable, `load` falls back to registering every enabled routine as its own per-session CronCreate job, idle-gated at the harness turn level.

### Config

Routines live in `config.json` as a `routines` array:

```json
"routines": [
  {"id": "morning", "schedule": "30 8 * * *", "skill": "claude-code-hermit:brief --morning", "run_during_waiting": true, "enabled": true},
  {"id": "evening", "schedule": "30 22 * * *", "skill": "claude-code-hermit:brief --evening", "run_during_waiting": true, "enabled": true},
  {"id": "heartbeat-restart", "schedule": "0 4 * * *", "skill": "claude-code-hermit:hermit-routines load", "run_during_waiting": true, "enabled": true},
  {"id": "weekly-deps", "schedule": "0 9 * * 1", "skill": "claude-code-hermit:session-start --task 'dependency audit'", "enabled": false}
]
```

- `id`: unique name for dedup and display
- `schedule`: 5-field cron expression (`minute hour dom month dow`), written in `config.timezone`. Monitor mode evaluates it directly in that timezone; the CronCreate anchor/fallback path converts it to machine-local time at registration (see [Config reference — routines.schedule](../docs/config-reference.md#cron-schedule-rules))
- `skill`: full slash-command name (e.g. `claude-code-hermit:brief --morning` for plugin skills, `ha-refresh-context` for local project skills)
- `run_during_waiting`: optional — if `true`, fires even when session status is `waiting` (default: `false`)
- `model`: optional — one of `opus`, `sonnet`, `haiku`. Runs the skill in a subagent at that model to save cost on lightweight routines (e.g. URL checks, threshold comparisons). Subagents run in isolated context and return only a one-line status, so only use it on stateless routines — not ones whose value is chat/transcript output, and not `heartbeat-restart` (ignored there). See [config-reference](config-reference.md#idle-agency--routines) for details.
- `enabled`: toggle without removing

Manage with `/claude-code-hermit:hermit-settings routines`. Changes take effect immediately — `hermit-settings` auto-runs `/claude-code-hermit:hermit-routines load` after writing config. If you edit `config.json` by hand, run `/claude-code-hermit:hermit-routines load` to apply.

### How it works

`hermit-start.ts` auto-sends `/claude-code-hermit:hermit-routines load` after launching the always-on session. The skill resolves `$CLAUDE_PLUGIN_ROOT`, then asks `scripts/routines.ts arm begin` what actually needs arming — a `HEALTHY` verdict (monitor registered for this boot, ticking, and matching config; anchor current) stops the skill right there with no `TaskStop`/`Monitor`/`Cron*` calls at all. On `ARM` it executes the plan the verb printed:

**Monitor mode (tried first).** Registers one persistent Monitor subprocess (`scripts/routine-monitor.sh`, 60s poll) running `scripts/routines.ts due`, which reads `config.routines` directly, evaluates each enabled non-anchor routine's schedule against `state/routine-schedule.json` cursors, applies the pause/waiting/idle gates itself, and prints a single `ROUTINE_DUE [hermit-routine:<id>] ...` line only for routines that should actually wake the session — a routine that's due-but-skipped costs zero model tokens. `hermit-routines run <ids>` handles the wake: it re-runs `scripts/routines.ts precheck` for the `started` stamp, invokes the skill on `PROCEED`, then calls `scripts/routines.ts finish`, which verifies any declared `expect_artifact` contract and writes the one terminal row to `state/routine-metrics.jsonl`. The anchor (`heartbeat-restart`) still registers via a single `CronCreate`, kept fresh by the same diff-planner (`scripts/routines.ts arm`) described below, scoped to that one routine.

**CronCreate fallback** (Monitor tool unavailable, or the subprocess fails to spawn): every enabled routine, anchor included, registers as its own per-session CronCreate. `scripts/routines.ts arm begin --fallback` diffs against `state/cron-registry.json` (a derived mirror, keyed to the current boot via `state/.boot-id`) — unchanged (`KEEP`), re-registered (`DELETE`+`CREATE`) on a schedule/metadata edit, or re-registered regardless of config changes once aging toward CC's 7-day auto-expiry cliff. The schedule shift (`config.timezone` → machine local time, via `lib/cron-shift.ts`) happens inside this step — monitor-mode routines skip it, evaluating directly in `config.timezone`. Each `CREATE` gets a prompt that runs `scripts/routines.ts precheck`, invokes the skill on `PROCEED`, then calls `scripts/routines.ts finish`, which verifies any declared `expect_artifact` contract and writes the one terminal row to `state/routine-metrics.jsonl`; each `DELETE` tears down the matching `[hermit-routine:*]` entry first. On an unchanged, fresh config this is a no-op with zero `CronList`/`CronCreate`/`CronDelete` calls. CronCreate fires only between REPL turns — never mid-task; a fire that comes due during `in_progress` is deferred (not dropped) until idle.

`/claude-code-hermit:hermit-routines load --reset` bypasses both diffs and does an unconditional sweep — the escape hatch for suspected drift.

`routines.ts precheck` gates every routine fire regardless of delivery mechanism (the `heartbeat-restart` anchor is the exception — its rendered prompt runs `arm anchor`, which applies the pause gate and the `started`/`fired` stamps itself): it suppresses `run_during_waiting: false` routines with a `skipped-waiting` event when `session_state == "waiting"`, and any routine with a `skipped-paused` event when the binding pause flag is set; otherwise it stamps `started` and returns `PROCEED`. When the routine declares `expect_artifact`, `precheck` also freezes that fire's contract into `state/routine-run.json` — the `{date}` token resolved in `config.timezone` at start, plus the target's filesystem identity — which `routines.ts finish` compares against afterwards. In monitor mode, `routines.ts due` applies the same two gates itself before ever waking the session, plus an operator-turn defer (Stop-cleared `state/operator-turn-open.json` marker, 60-min TTL backstop) approximating the idle gate CronCreate gets for free from the harness.

**`heartbeat-restart`** fires at 4am daily and re-invokes `load`, re-arming the routine monitor (or, in fallback mode, the routine CronCreates — which expire after 7 days without this daily re-arm); unless `heartbeat.enabled` is explicitly false, the same fire re-registers the heartbeat Monitor.

Inspect live state with `/claude-code-hermit:hermit-routines status` (monitor liveness + anchor, or the full CronCreate list in fallback mode). Inspect fire history with `tail .claude-code-hermit/state/routine-metrics.jsonl` — each row's `delivery` field is `monitor` or `cron-create`.

### Relationship to heartbeat and monitors

|                | Routines                         | Heartbeat                      | Monitors                          |
| -------------- | -------------------------------- | ------------------------------ | --------------------------------- |
| Timing         | Exact cron schedule              | Every N minutes                | Event-driven or interval          |
| Engine         | Monitor subprocess (60s poll, gates in-script); CronCreate anchor + fallback | CC Monitor (subprocess poll)   | Monitor tool (OS subprocess)      |
| Cost           | Zero tokens for a skipped fire (monitor mode) | Zero tokens when quiet         | Zero tokens when quiet            |
| Survives exit  | No (re-registered on launch; anchor re-arms daily) | No (re-armed daily by heartbeat-restart) | No (session-scoped)    |
| Mid-task fire  | Deferred while an operator turn is open (Stop-cleared marker, 60-min TTL) — coarser than CronCreate's turn-level idle gate, can interject | Yes (interrupts)               | Yes (interrupts)                  |
| Use for        | Scheduled tasks (briefs, audits) | Continuous monitoring          | Reactive watching / quiet polling |

**Hybrid model:** Monitors handle reactive event streams (interrupt-OK). Routines handle scheduled work, gated outside the session for near-zero cost. Heartbeat handles continuous health checks. Neither replaces the others.

Config-defined watches auto-register at session start. Runtime truth: `.claude-code-hermit/state/monitors.runtime.json`. See `/claude-code-hermit:watch` for ad-hoc watching.

---

## 3. Channels

Channels let you talk to your hermit from your phone via Telegram, Discord, or iMessage. Setup, pairing, and Docker-specific config are covered in [Always-On Setup](always-on.md#channels-in-docker) and the [Claude Code Channels docs](https://code.claude.com/docs/en/channels).

For bare-tmux setups, Hermit scopes channel config to `.claude.local/channels/<name>/` by default, including when `channels.<name>.state_dir` is omitted. `hermit-start` exports the derived `<NAME>_STATE_DIR` so the channel MCP server uses that project-local directory. Keep `.claude.local/` gitignored.

---

## 4. Cost Management

The `cost-tracker` hook tracks spend automatically. For detailed token optimization settings, budgets, and env config, see [Always-On Setup: Cost Management](always-on.md#cost-management).

Quick summary: set per-session budgets with `/hermit-settings budget` (warns at 80%, recommends closing at 100%) and project-level budgets in OPERATOR.md.

### Cheap always-on

Four levers, in rough order of impact:

**1. Whole-session model** (`config.model: "haiku"`). The single highest-leverage cut. Every idle turn — heartbeat, routines, interactive — inherits the session model. Tradeoff: your interactive work and idle task pickup also drop to Haiku. It is whole-session, not heartbeat-only. Set via `/hermit-settings` or directly in `config.json`.

**2. Per-routine model override** (since v1.0.20). Routines that are self-contained and stateless (URL checks, threshold comparisons, file audits) can run their skill in a subagent at a cheaper model:

```json
{"id": "cortex-refresh", "schedule": "0 6 * * *", "skill": "...", "model": "haiku"}
```

Not suitable for routines whose value is chat or transcript output (subagent output collapses to one line) or for `heartbeat-restart` (must run in-session). See the [Routines](#routines) section above and [config-reference](config-reference.md#idle-agency--routines).

**3. Interval and active hours.** Cost is wakes/day × cost/wake. Widen `heartbeat.every` (default `30m`) or tighten `active_hours` in `config.json`. Only `EVALUATE`/`AUTO_CLOSE` wakes cost tokens — the `--peek` poll between them is free.

**4. Checklist curation.** A shorter, sharper `HEARTBEAT.md` lets the free OK precheck path fire more often, skipping the full LLM eval. `/claude-code-hermit:heartbeat edit` warns when the list exceeds 10 items.

**Measure before and after:** run `/claude-code-hermit:cost-reflect` to see spend broken down by trigger source (`heartbeat`, `routine:<id>`, `routine:multi`, `channel:<name>`, `peer`, `other`) and by token type. The routine rows are the ones a per-routine model override shrinks; `heartbeat` responds to interval/checklist changes; `channel:<name>` identifies channel-triggered turns; `peer` appears as "other sessions on this machine"; `other` covers interactive and unattributed turns.

---

## 5. Reconnecting After Disconnects

Watchdog restarts resume the resident conversation when the compact tier is enabled, the last own cost entry is valid and below its context threshold, and the transcript contains a user turn; otherwise they start fresh and record the gate result in `state/watchdog-events.jsonl`.

For a manual start that keeps the conversation, use `hermit-start --resume` or `hermit-docker restart --resume` (`hermit-docker up --resume` also accepts the opt-in). Manual resume skips the size gate but still requires a transcript with a user turn. Starts without `--resume` create a fresh conversation. Resume applies only to always-on boots with a bootstrap prompt; the existing archive-or-resume recovery question still controls whether work continues.

Progress and blockers remain in `sessions/SHELL.md` on disk even when a restart starts a fresh conversation.

1. Run `hermit-status` to check current state (includes the tmux attach command for Docker)
2. Reattach to tmux, start Claude Code
3. SessionStart hook loads OPERATOR.md, SHELL.md, latest report
4. `session-start` presents current work, progress, blockers.
5. Confirm resume or start fresh

---

## 6. Login Renewal

A hermit on subscription auth can hold a **long-lived login token** minted with `claude setup-token` — offered right after login in `/docker-setup`, recommended. It lasts a year, and because the hermit mints it, the expiry date is known from day one — the CLI itself exposes no expiry surface for these tokens, so the hermit tracks it in `state/setup-token.json`.

This is not Docker-only. A **host** install (systemd unit, launchd job, cron entry) holds the token the same way and gets the same renewal relay. The difference is invisible from the outside: under Docker, compose hands the watchdog loop and the session one environment, so the watchdog can read the session's auth setup straight from its own. On a host the unit carries only `PATH`, so the watchdog learns where the token lives from the `config_dir` stamp the session writes into `state/runtime.json` at `SessionStart`. Before that stamp existed, a host token hermit with a custom `CLAUDE_CONFIG_DIR` was misread as a `/login` hermit and told to go sign in by hand instead of being offered the relay.

A hermit can equally run on the plain claude.ai sign-in itself — `auth_mode: login` — and that is the only credential Remote Control accepts. Both modes renew the same way, over your channel, with no server access; they differ in cadence and in one mechanical detail. A sign-in lasts about **30 days** (its `refreshTokenExpiresAt`, the one field a silent refresh does not move) against the token's year. And where a token is installed on the spot, a renewed sign-in is written to a staging config dir and left there: the resident session rewrites `.credentials.json` roughly every 8 hours, so a renewal written underneath it can be silently undone. The watchdog moves the staged file into place inside its own restart — after the old session is verifiably dead and before the new one starts — which is the only window in which nothing is holding the file. Until that restart the sign-in is staged, not live, and `setup-token-mint status` reports `pending: true`.

`auth_mode` is resolved from the credential volume when it is unset, so a hermit that predates the key behaves exactly as it did. macOS is the one platform where the volume can lie: Claude Code keeps a `/login` credential in the encrypted Keychain rather than in `.credentials.json`, and keys that Keychain entry to `CLAUDE_CONFIG_DIR`, so a sign-in staged under a staging config dir could never be moved into place anyway. An install with no credential file therefore resolves as `external` and sits every renewal path out. Two macOS cases are unaffected: a **token** hermit authenticates from `CLAUDE_CODE_OAUTH_TOKEN` with the Keychain out of the picture, and a **sign-in made over SSH**, where the locked Keychain makes Claude Code fall back to `.credentials.json`: the file is there, the install resolves as `login`, and it renews like any other. An API key or cloud-provider credential in the environment resolves as `external` too — no relay can renew what the operator's own shell owns.

**Three days before expiry** — either mode, matching the window Claude Code itself warns on — the hermit asks you over your channel. Reply and it sends a one-time sign-in link; open it, send back the code it gives you, and the hermit renews and restarts itself. Doctor's `credential-expiry` check reports the same thing if you'd rather see it there.

**If a credential lapses unnoticed**, the hermit recovers itself. It can't think without a working login, so this path runs deterministically in the watchdog: it messages you that it's down and waits. Reply `reauth` when you're at a browser, and the same link-and-code exchange follows. Nothing happens until you reply — a one-time link minted at 3am while you're asleep would just expire unused. The same recovery fires when a credential stops working *before* its recorded expiry (revoked, rotated, restored from an old backup): the record still reads healthy, so the watchdog goes by what the session is actually saying on screen.

**If the relay can't reach you at all** — no channel configured, or the send itself fails — it stamps `state/relay-unreachable.json` and the watchdog honours that for 24 hours: one push notification, then silence, instead of respawning a doomed relay every tick. After a day it tries again, since an unreachable channel is usually an outage rather than a permanent state.

You can also renew from a terminal at any time:

```bash
.claude-code-hermit/bin/hermit-docker setup-token
```

Notes:

- The sign-in link and the code travel over your channel. **The token itself never does** — it goes straight into a `0600` file on the container's config volume, and is never printed or logged.
- The token is deliberately not stored in `.env`: Docker applies `env_file` only when a container is created, so a token there could not be rotated without recreating the container from the host — the manual step this whole flow exists to remove.
- **Never run `/logout` inside the container.** It deletes the stored credentials *and* resets first-launch state, after which the interactive wizard demands a login and won't accept the token. Renewal never needs it.
- A fresh install still does one attended `/login` before minting the token, because the first-launch wizard requires it. Initial setup is attended anyway, so this costs nothing after day one.

---

## 7. Security

See [Security](security.md).

---

## 8. Operational Concerns

### Rate limits

Claude Max 20x ($200/month) recommended for overnight agents. Pro plan stalls during multi-hour sessions. Rate limit pauses are **silent** — add to OPERATOR.md:

```markdown
## Constraints

If you hit a rate limit, update SHELL.md: "Rate limited at [timestamp]. Waiting for reset."
```

### Data persistence

SHELL.md is gitignored. Protect in-progress state with periodic commits to a separate branch, or by removing SHELL.md from `.gitignore`. Docker users can also use named volumes — see [Always-On Setup](always-on.md).

### Channel resilience

If Telegram/Discord goes down, your hermit keeps running — just loses remote communication. Enable remote control as a backup. Check SHELL.md via SSH if channels are unavailable.

### Multi-operator warning

Hermit assumes one person giving it direction per project. For teams, use separate branches or git worktrees with isolated state directories.

### Auto-restart on reboot

**Linux (systemd):**

```bash
# /etc/systemd/system/hermit.service
[Unit]
Description=Claude Code Hermit
After=network.target

[Service]
Type=forking
User=your-username
WorkingDirectory=/home/your-username/my-project
ExecStart=/home/your-username/my-project/.claude-code-hermit/bin/hermit-start
ExecStop=/home/your-username/my-project/.claude-code-hermit/bin/hermit-stop
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
```

**macOS (launchd):** Create a plist in `~/Library/LaunchAgents/` that runs `hermit-start` at login. The SessionStart hook reloads session context automatically.

**Docker:** `restart: unless-stopped` handles it automatically — see [Always-On Setup](always-on.md). The entrypoint's SIGTERM trap ensures graceful session close on system shutdown.
