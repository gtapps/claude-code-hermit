# Always-On Operations (Non-Docker)

tmux-based setup for running your hermit without Docker, plus the lifecycle reference that applies to all always-on modes. For Docker setup, see [Always-On Setup](always-on.md).

For skill details, see [Skills Reference](skills.md).

---

## Prerequisites

| Requirement              | For          | Notes                                      |
| ------------------------ | ------------ | ------------------------------------------ |
| **tmux**                 | Boot scripts | `brew install tmux` / `apt install tmux`   |
| **Node.js 22+**          | Hooks        | Cost tracking, session evaluation          |
| **Claude Code v2.1.150+** | Channels, sandbox | Minimum supported version |

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

**Config options:** If `remote: true`, adds `--remote-control` and names the session after `agent_name`. If `model` is set, passes it to Claude Code.

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

Default: idle transition when work finishes. Waiting when blocked on operator input (configurable `waiting_timeout` auto-transitions to idle). Auto-close on either 12h operator inactivity OR the daily midnight routine once the operator is idle ≥10 min (both heartbeat-driven, no configuration). Full shutdown only via explicit `/session-close` or `hermit-stop`.

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

**Hooks fire throughout the session:** `cost-tracker.js` (costs), `suggest-compact.js` (context warnings), `session-diff.js` (changed files), and `evaluate-session.js` (quality nudges) run on every assistant turn (Stop). At the strict profile, `enforce-deny-patterns.js` blocks banned commands before execution (PreToolUse), and `channel-hook.js` + `heartbeat-touch.js` run on tool use (PostToolUse).

### When learning fires

Your hermit reflects on its own memory — not archived reports. Reflection triggers at these moments:

| Trigger              | When                                          |
| -------------------- | --------------------------------------------- |
| Task boundary        | After completing work, during idle transition |
| Heartbeat idle check | Every 4+ hours during idle                    |
| Evening routine      | Last heartbeat tick of the day                |
| Session close        | Before archiving the final report             |

**Feedback loop:** When an accepted proposal's pattern stops recurring (based on memory), it auto-resolves. The heartbeat self-evaluates every 20 ticks — suggesting stale checks to remove and relevant ones to add.

### Daily rhythm

If routines are configured (default after init or upgrade):

- **Morning routine** — `brief --morning` at configured time (default: active hours start + 30m): generates a brief, reviews pending proposals, checks priorities. Framing adapts to `always_on` setting.
- **Evening routine** — `brief --evening` at configured time (default: active hours end - 30m): summarizes the day's work, archives via session-close, flags tomorrow's priorities.

Both fire via per-session CronCreate jobs registered by `/claude-code-hermit:hermit-routines`. Configure with `/claude-code-hermit:hermit-settings routines`.

### Idle agency

When idle and `idle_behavior` is `"discover"` (set via `/hermit-settings idle`), the heartbeat looks for autonomous work:

1. **NEXT-TASK.md** — picks up accepted proposals (gated by escalation level). Active for both `wait` and `discover` modes.
2. **Reflection** — runs reflect if 4+ hours since last
3. **Priority alignment** — reads OPERATOR.md, checks alignment with the operator's stated priorities and constraints

### Edge cases

- **Crash during work:** SHELL.md persists. On restart, offers to resume.
- **Crash during idle:** SHELL.md persists as `idle`. Asks what to work on next.
- **Crash during waiting:** SHELL.md persists as `waiting`. On restart, re-enters waiting state and checks for operator response.
- **hermit-start when already running:** Prints guidance, exits.
- **Docker SIGTERM:** The entrypoint traps SIGTERM and attempts a graceful session close (30s timeout) before the container exits. Sessions are archived even on raw `docker compose down`.

---

## Routines

Routines are time-triggered skills registered as per-session `CronCreate` jobs by the `/claude-code-hermit:hermit-routines` skill. Unlike heartbeat checks (which run every tick), routines fire at exact cron times — no LLM needed to check the clock, and CronCreate is idle-gated so routines never interrupt mid-task.

### Config

Routines live in `config.json` as a `routines` array:

```json
"routines": [
  {"id": "morning", "schedule": "30 8 * * *", "skill": "claude-code-hermit:brief --morning", "run_during_waiting": true, "enabled": true},
  {"id": "evening", "schedule": "30 22 * * *", "skill": "claude-code-hermit:brief --evening", "run_during_waiting": true, "enabled": true},
  {"id": "heartbeat-restart", "schedule": "0 4 * * *", "skill": "claude-code-hermit:heartbeat start", "run_during_waiting": true, "enabled": true},
  {"id": "weekly-deps", "schedule": "0 9 * * 1", "skill": "claude-code-hermit:session-start --task 'dependency audit'", "enabled": false}
]
```

- `id`: unique name for dedup and display
- `schedule`: 5-field cron expression (`minute hour dom month dow`), written in `config.timezone` — converted to machine local time at load before CronCreate registration (see [Config reference — routines.schedule](../docs/config-reference.md#cron-schedule-rules))
- `skill`: full slash-command name (e.g. `claude-code-hermit:brief --morning` for plugin skills, `ha-refresh-context` for local project skills)
- `run_during_waiting`: optional — if `true`, fires even when session status is `waiting` (default: `false`)
- `model`: optional — one of `opus`, `sonnet`, `haiku`. Runs the skill in a subagent at that model to save cost on lightweight routines (e.g. URL checks, threshold comparisons). Subagents run in isolated context and return only a one-line status, so only use it on stateless routines — not ones whose value is chat/transcript output, and not `heartbeat-restart` (ignored there). See [config-reference](config-reference.md#idle-agency--routines) for details.
- `enabled`: toggle without removing

Manage with `/claude-code-hermit:hermit-settings routines`. Changes take effect immediately — `hermit-settings` auto-runs `/claude-code-hermit:hermit-routines load` after writing config. If you edit `config.json` by hand, run `/claude-code-hermit:hermit-routines load` to apply.

### How it works

`hermit-start.py` auto-sends `/claude-code-hermit:hermit-routines load` after launching the always-on session. The skill:

1. Resolves `$CLAUDE_PLUGIN_ROOT` and reads `config.timezone`
2. Calls `CronList`, `CronDelete`s every `[hermit-routine:*]` entry — clears stale registrations and resets the 7-day expiry clock
3. For each enabled routine, shifts the `schedule` from `config.timezone` to machine local time via `scripts/cron-tz-shift.js`, then registers a fresh `CronCreate` with that shifted schedule and a prompt that invokes the skill plus logs to `state/routine-metrics.jsonl`

CronCreate fires only between REPL turns — never mid-task. There is no queue: if Claude is mid-task when the cron time hits, the fire is deferred (not dropped) until idle. `run_during_waiting: false` routines additionally check `runtime.json` and self-suppress with a `skipped-waiting` event when `session_state == "waiting"`.

**`heartbeat-restart`** fires at 4am daily and re-registers the heartbeat Monitor and routine CronCreates (both expire after 7 days; daily re-arm keeps everything fresh).

Inspect live registrations with `/claude-code-hermit:hermit-routines status` (calls `CronList` under the hood). Inspect fire history with `tail .claude-code-hermit/state/routine-metrics.jsonl`.

### Relationship to heartbeat and monitors

|                | Routines                         | Heartbeat                      | Monitors                          |
| -------------- | -------------------------------- | ------------------------------ | --------------------------------- |
| Timing         | Exact cron schedule              | Every N minutes                | Event-driven or interval          |
| Engine         | CronCreate (idle-gated)          | CC Monitor (subprocess poll)   | Monitor tool (OS subprocess)      |
| Cost           | Zero tokens until fire           | Zero tokens when quiet         | Zero tokens when quiet            |
| Survives exit  | No (re-registered on launch)     | No (re-armed daily by heartbeat-restart) | No (session-scoped)    |
| Mid-task fire  | Deferred until idle              | Yes (interrupts)               | Yes (interrupts)                  |
| Use for        | Scheduled tasks (briefs, audits) | Continuous monitoring          | Reactive watching / quiet polling |

**Hybrid model:** Monitors handle reactive event streams (interrupt-OK). Routines handle scheduled work (idle-gated, never interrupt). Heartbeat handles continuous health checks. Neither replaces the others.

Config-defined watches auto-register at session start. Runtime truth: `.claude-code-hermit/state/monitors.runtime.json`. See `/claude-code-hermit:watch` for ad-hoc watching.

---

## 3. Channels

Channels let you talk to your hermit from your phone via Telegram, Discord, or iMessage. Setup, pairing, and Docker-specific config are covered in [Always-On Setup](always-on.md#channels-in-docker) and the [Claude Code Channels docs](https://code.claude.com/docs/en/channels).

For bare-tmux setups, channel config lives at the user level by default (`~/.claude/channels/<plugin>/`). To scope config per-project (useful for multi-agent setups), create `.claude.local/channels/<plugin>/` with an `access.json` and optional `.env`. Make sure `.claude.local/` is gitignored.

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

**3. Interval and active hours.** Cost is wakes/day × cost/wake. Widen `heartbeat.every` (default 5 min) or tighten `active_hours` in `config.json`. Only `EVALUATE`/`AUTO_CLOSE` wakes cost tokens — the `--peek` poll between them is free.

**4. Checklist curation.** A shorter, sharper `HEARTBEAT.md` lets the free OK precheck path fire more often, skipping the full LLM eval. `/claude-code-hermit:heartbeat edit` warns when the list exceeds 10 items.

**Measure before and after:** run `/claude-code-hermit:cost-reflect` to see spend broken down by trigger source (`heartbeat`, `routine:<id>`, `other`) and by token type. The `routine:<id>` rows are the ones a per-routine model override shrinks; `heartbeat` is the one that responds to interval/checklist changes; `other` covers interactive and unattributed turns.

---

## 5. Reconnecting After Disconnects

All state is in `sessions/SHELL.md` on disk. A disconnect loses conversation context but preserves progress and blockers.

1. Run `hermit-status` to check current state (includes the tmux attach command for Docker)
2. Reattach to tmux, start Claude Code
3. SessionStart hook loads OPERATOR.md, SHELL.md, latest report
4. `session-start` presents current work, progress, blockers. On the very first session after hatch, it may offer a one-time baseline audit — the prompt and audit summary are routed via channel in always-on mode.
5. Confirm resume or start fresh

---

## 6. Security

See [Security](security.md).

---

## 7. Operational Concerns

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
