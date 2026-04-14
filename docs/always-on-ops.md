# Always-On Operations (Non-Docker)

tmux-based setup for running your hermit without Docker, plus the lifecycle reference that applies to all always-on modes. For Docker setup, see [Always-On Setup](always-on.md).

For skill details, see [Skills Reference](skills.md).

---

## Prerequisites

| Requirement              | For          | Notes                                      |
| ------------------------ | ------------ | ------------------------------------------ |
| **tmux**                 | Boot scripts | `brew install tmux` / `apt install tmux`   |
| **Node.js 22+**          | Hooks        | Cost tracking, session evaluation          |
| **Claude Code v2.1.98+** | Channels     | Required for the channels research preview |

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
claude --permission-mode acceptEdits
```

> **Why `--permission-mode acceptEdits`?** Always-on agents need to act without prompts for file edits. Deny patterns and hooks provide safety instead. **Run `claude` interactively once first** to accept the workspace trust prompt — without this, the agent hangs in tmux.
>
> For fully isolated containers/VMs, set `permission_mode: "bypassPermissions"` in `config.json` — `hermit-start` maps this to `--dangerously-skip-permissions`. See [Always-On Setup](always-on.md) for the Docker workflow and [Permission Modes](https://code.claude.com/docs/en/permission-modes).

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

|                     | Idle Transition (task boundary)                                            | Waiting (blocked on input)     | Full Shutdown (`/session-close`) |
| ------------------- | -------------------------------------------------------------------------- | ------------------------------ | -------------------------------- |
| **When**            | Work done — automatic                                                      | Blocked on operator input      | You explicitly close             |
| **Report archived** | Yes                                                                        | No (session stays open)        | Yes                              |
| **Reflection runs** | Yes                                                                        | No                             | Yes                              |
| **Heartbeat**       | Keeps running (or starts)                                                  | Runs (skips stale checks)      | Stopped                          |
| **Monitors**        | Keep running                                                               | Keep running                   | Stopped (TaskStop + registry cleared) |
| **Channels**        | Keep running (always-on only)                                              | Keep running                   | Stopped                          |
| **SHELL.md**        | Reset in-place to `idle`, Monitoring & Summary compacted if over threshold | Status set to `waiting`        | Replaced with fresh template     |
| **Applies to**      | Both interactive and always-on                                             | Both interactive and always-on | Both interactive and always-on   |

Default: idle transition when work finishes. Waiting when blocked on operator input (configurable `waiting_timeout` auto-transitions to idle). Full shutdown only via explicit `/session-close` or `hermit-stop`.

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

Both are managed by the routine watcher, not the heartbeat. Configure with `/claude-code-hermit:hermit-settings routines`.

### Idle agency

When idle and `idle_behavior` is `"discover"` (set via `/hermit-settings idle`), the heartbeat looks for autonomous work:

1. **NEXT-TASK.md** — picks up accepted proposals (gated by escalation level). Active for both `wait` and `discover` modes.
2. **Reflection** — runs reflect if 4+ hours since last
3. **Idle tasks** — picks first unchecked item from `IDLE-TASKS.md`, runs in a capped session (`idle_budget`)
4. **Priority alignment** — reads OPERATOR.md, checks alignment with the operator's stated priorities and constraints

### Edge cases

- **Crash during work:** SHELL.md persists. On restart, offers to resume.
- **Crash during idle:** SHELL.md persists as `idle`. Asks what to work on next.
- **Crash during waiting:** SHELL.md persists as `waiting`. On restart, re-enters waiting state and checks for operator response.
- **hermit-start when already running:** Prints guidance, exits.
- **Operator takeover:** If SHELL.md status is `operator_takeover`, the hermit asks what happened during takeover and checks for NEXT-TASK.md instructions.
- **Docker SIGTERM:** The entrypoint traps SIGTERM and attempts a graceful session close (30s timeout) before the container exits. Sessions are archived even on raw `docker compose down`.

---

## Routines

Routines are time-triggered skills managed by a shell-level watcher (`scripts/routine-watcher.sh`). Unlike heartbeat checks (which run every tick), routines fire at exact times — no LLM needed to check the clock.

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
- `schedule`: 5-field cron expression (`minute hour dom month dow`), evaluated in configured timezone
- `skill`: full slash-command name (e.g. `claude-code-hermit:brief --morning` for plugin skills, `ha-refresh-context` for local project skills)
- `run_during_waiting`: optional — if `true`, fires even when session status is `waiting` (default: `false`)
- `enabled`: toggle without removing

Manage with `/claude-code-hermit:hermit-settings routines`. Changes take effect within 60 seconds.

### How it works

The routine watcher runs as a background tmux window (started by `hermit-start.py`). Every 60 seconds it:

1. Re-reads `config.json` for the latest routines
2. Matches current time and day against enabled routines
3. Checks `state/runtime.json` (session state) — queues to `state/routine-queue.json` if `in_progress`, checks `run_during_waiting` if `waiting`
4. Fires matching routines via `tmux send-keys` to the Claude Code pane
5. Deduplicates: each routine fires at most once per matching time slot

Queued routines are dequeued one at a time after the session returns to idle. The heartbeat detects stale queued routines.

The watcher dies automatically when the tmux session is killed — no cleanup needed.

**`heartbeat-restart`** fires at 4am daily and restarts the heartbeat loop. Required for always-on deployments — `/loop` tasks expire after 3 days. Do not disable unless you are manually managing heartbeat restarts.

### Relationship to heartbeat and monitors

|                | Routines                         | Heartbeat                      | Monitors                          |
| -------------- | -------------------------------- | ------------------------------ | --------------------------------- |
| Timing         | Exact HH:MM                      | Every N minutes                | Event-driven or interval          |
| Engine         | Shell script (`date` + `jq`)     | LLM evaluation                 | Monitor tool (OS subprocess)      |
| Cost           | Zero tokens                      | Checklist evaluation per tick  | Zero tokens when quiet            |
| Survives exit  | Yes (tmux)                       | No (3-day `/loop` expiry)      | No (session-scoped)               |
| Use for        | Scheduled tasks (briefs, audits) | Continuous monitoring          | Reactive watching / quiet polling |

**Hybrid model:** Monitors handle reactive concerns (event streams, zero idle cost). `routine-watcher.sh` handles durability (survives session death, crash recovery, cron-like scheduling). Neither replaces the other.

Config-defined watches auto-register at session start. Runtime truth: `.claude-code-hermit/state/monitors.runtime.json`. See `/claude-code-hermit:watch` for ad-hoc watching.

---

## 3. Channels

Channels let you talk to your hermit from your phone via Telegram, Discord, or iMessage. Setup, pairing, and Docker-specific config are covered in [Always-On Setup](always-on.md#channels-in-docker) and the [Claude Code Channels docs](https://code.claude.com/docs/en/channels).

For bare-tmux setups, channel config lives at the user level by default (`~/.claude/channels/<plugin>/`). To scope config per-project (useful for multi-agent setups), create `.claude.local/channels/<plugin>/` with an `access.json` and optional `.env`. Make sure `.claude.local/` is gitignored.

---

## 4. Cost Management

The `cost-tracker` hook tracks spend automatically. For detailed token optimization settings, budgets, and env config, see [Always-On Setup: Cost Management](always-on.md#cost-management).

Quick summary: set per-session budgets with `/hermit-settings budget` (warns at 80%, recommends closing at 100%) and project-level budgets in OPERATOR.md.

---

## 5. Reconnecting After Disconnects

All state is in `sessions/SHELL.md` on disk. A disconnect loses conversation context but preserves progress and blockers.

1. Run `hermit-status` to check current state (includes the tmux attach command for Docker)
2. Reattach to tmux, start Claude Code
3. SessionStart hook loads OPERATOR.md, SHELL.md, latest report
4. `session-start` presents current work, progress, blockers
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
