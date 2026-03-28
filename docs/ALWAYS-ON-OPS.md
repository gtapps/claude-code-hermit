# Always-On Operations

Operational reference for always-on hermit sessions — lifecycle, channels, cost management, security, and recovery. For setup, see [Always-On Setup](ALWAYS-ON.md).

For skill details, see [Skills Reference](SKILLS.md).

---

## Prerequisites

| Requirement              | For          | Notes                                      |
| ------------------------ | ------------ | ------------------------------------------ |
| **tmux**                 | Boot scripts | `brew install tmux` / `apt install tmux`   |
| **Node.js 24+**          | Hooks        | Cost tracking, session evaluation          |
| **Claude Code v2.1.80+** | Channels     | Required for the channels research preview |

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
tmux new-session -d -s claude-agent
tmux attach -t claude-agent
cd /path/to/your/project
claude --permission-mode acceptEdits
```

> **Why `--permission-mode acceptEdits`?** Always-on agents need to act without prompts for file edits. Deny patterns and hooks provide safety instead. **Run `claude` interactively once first** to accept the workspace trust prompt — without this, the agent hangs in tmux.
>
> For fully isolated containers/VMs, set `permission_mode: "bypassPermissions"` in `config.json` — `hermit-start` maps this to `--dangerously-skip-permissions`. See [Always-On Setup](ALWAYS-ON.md) for the Docker workflow and [Permission Modes](https://code.claude.com/docs/en/permission-modes).

### Remote access

[Remote control](https://code.claude.com/docs/en/remote-control) connects from any browser or phone. Enable via config (`/hermit-settings remote`) or `--remote-control`. Connect at [claude.ai/code](https://claude.ai/code).

---

## 2. Always-On Lifecycle

> The lifecycle below applies to both interactive and always-on sessions. This section covers the always-on infrastructure specifically.

In always-on mode, the session stays open between tasks. Heartbeat, monitors, and channels keep running the whole time. Your hermit works, finishes, waits for the next thing — and stays productive in between.

### State flow

```
hermit-start -> [in_progress] -> task done -> [idle] -> new task -> [in_progress] -> ...
                                                                                      |
                                                              hermit-stop -> [archived]
```

1. `hermit-start` sets `always_on: true`, launches Claude Code in tmux
2. Work finishes — **idle transition**: report archived, SHELL.md reset, heartbeat keeps running
3. New request comes in (channel, NEXT-TASK.md, terminal) — back to `in_progress`
4. `hermit-stop` — **full shutdown**: close task, stop heartbeat, archive, kill tmux

### Close modes

|                     | Idle Transition (task boundary) | Full Shutdown (`/session-close`) |
| ------------------- | ------------------------------- | -------------------------------- |
| **When**            | Work done — automatic           | You explicitly close             |
| **Report archived** | Yes                             | Yes                              |
| **Reflection runs** | Yes                             | Yes                              |
| **Heartbeat**       | Keeps running (or starts)       | Stopped                          |
| **Channels**        | Keep running (always-on only)   | Stopped                          |
| **SHELL.md**        | Reset in-place to `idle`        | Replaced with fresh template     |
| **Applies to**      | Both interactive and always-on  | Both interactive and always-on   |

Default: idle transition when work finishes. Full shutdown only via explicit `/session-close` or `hermit-stop`.

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

**Hooks fire after every assistant turn:** `cost-tracker.js` (costs), `suggest-compact.js` (context warnings), `session-diff.js` (changed files), `evaluate-session.js` (quality).

### When learning fires

Your hermit reflects on its own memory — not archived reports. Reflection triggers at these moments:

| Trigger              | When                                                     |
| -------------------- | -------------------------------------------------------- |
| Task boundary        | After completing work, during idle transition            |
| Heartbeat idle check | Every 4+ hours during idle (if `idle_agency` is enabled) |
| Evening routine      | Last heartbeat tick of the day                           |
| Session close        | Before archiving the final report                        |

**Feedback loop:** When an accepted proposal's pattern stops recurring (based on memory), it auto-resolves. The heartbeat self-evaluates every 20 ticks — suggesting stale checks to remove and relevant ones to add.

### Daily rhythm

If daily routines are enabled in config:

- **Morning routine** — first heartbeat tick after active hours start: generates a brief, reviews pending proposals, checks priorities. If memory is sparse (new instance), reads the latest report for context recovery.
- **Evening routine** — last heartbeat tick before active hours end: archives the day's work as an S-NNN report (if there are progress log entries), runs reflection, flags tomorrow's priorities.

Both fire once per day. Configure with `/claude-code-hermit:hermit-settings routines`.

### Idle agency

When idle and `idle_agency` is enabled, the heartbeat looks for autonomous work:

1. **NEXT-TASK.md** — picks up accepted proposals (gated by escalation level)
2. **Reflection** — runs reflect if 4+ hours since last
3. **Priority check** — reads OPERATOR.md, checks alignment with stated priorities and constraints
4. **Maintenance** — HEARTBEAT.md checklist items

### Edge cases

- **Crash during work:** SHELL.md persists. On restart, offers to resume.
- **Crash during idle:** SHELL.md persists as `idle`. Asks what to work on next.
- **hermit-start when already running:** Prints guidance, exits.
- **Operator takeover:** If SHELL.md status is `operator_takeover`, the hermit asks what happened during takeover and checks for NEXT-TASK.md instructions.

---

## 3. Channels

[Claude Code Channels](https://code.claude.com/docs/en/channels) (v2.1.80+) lets you talk to your hermit from your phone.

### Pairing

1. Start Claude Code in tmux
2. Message the bot on Telegram/Discord/iMessage
3. Bot replies with a pairing code
4. Approve in Claude Code
5. Done — account allowlisted

### Message handling

| You send                | Hermit does                       |
| ----------------------- | --------------------------------- |
| "status"                | Concise SHELL.md summary          |
| "work on X"             | Confirms and starts working on it |
| "why did you change X?" | Answers with session context      |
| "stop" / "abort"        | Halts work, marks blocked         |

### Local-scope config (multi-agent)

For multiple agents per project, scope channel config locally instead of user-level:

```bash
mkdir -p .claude.local/channels/discord
```

Add `access.json` with your policy and optionally a `.env` for a per-project bot token. Verify `.claude.local/` is gitignored. Same pattern for Telegram and iMessage.

---

## 4. Cost Management

The `cost-tracker` hook runs on every `Stop` event: logs to `.claude/cost-log.jsonl`, updates SHELL.md, writes `.status.json` for the `hermit-status` script, and outputs a summary. Check with `/cost`.

### Token optimization

Managed in `config.json` `env` (written to `.claude/settings.local.json` at boot by `hermit-start`):

```json
{
  "env": {
    "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE": "50",
    "MAX_THINKING_TOKENS": "10000"
  }
}
```

| Setting              | Effect                           |
| -------------------- | -------------------------------- |
| Autocompact at 50%   | Keeps working set smaller        |
| Max thinking 10K     | Prevents runaway reasoning costs |

To also use the cheapest model for subagent exploration, add `"CLAUDE_CODE_SUBAGENT_MODEL": "haiku"` to your `config.json` `env`. Adjust with `/hermit-settings env`.

### Budgets

**Per-session:** `/hermit-settings budget`. Warns at 80%, recommends closing at 100%.
**Project-level:** Set in OPERATOR.md (`Monthly Claude budget: $200. Alert at $150.`).

---

## 5. Reconnecting After Disconnects

All state is in `sessions/SHELL.md` on disk. A disconnect loses conversation context but preserves progress and blockers.

1. Reattach to tmux, start Claude Code
2. SessionStart hook loads OPERATOR.md, SHELL.md, latest report
3. `session-start` presents current work, progress, blockers
4. Confirm resume or start fresh

---

## 6. Security

### Deny patterns

Block tool invocations regardless of permission mode:

```json
{
  "permissions": {
    "deny": [
      "Bash(rm -rf *)",
      "Bash(chmod 777*)",
      "Bash(*sudo *)",
      "Bash(*> /etc/*)",
      "Bash(curl * | bash)",
      "Bash(wget * | bash)",
      "Bash(ssh *)",
      "Bash(docker *)",
      "Bash(kubectl *)",
      "Bash(npm publish*)",
      "Bash(git push --force*)",
      "Bash(git push origin main*)",
      "Bash(*--no-verify*)",
      "Bash(env)",
      "Bash(printenv)",
      "Bash(cat ~/.ssh/*)",
      "Bash(cat ~/.aws/*)",
      "Bash(*API_KEY*)",
      "Bash(*SECRET*)",
      "Bash(*TOKEN*)"
    ]
  }
}
```

### Defense in depth

| Layer               | Where           | Enforcement           |
| ------------------- | --------------- | --------------------- |
| Deny patterns       | `settings.json` | Mechanical            |
| Agent-level rules   | `agents/*.md`   | Instruction-following |
| Hook enforcement    | `hooks.json`    | Mechanical            |
| Container isolation | Docker/VM       | Mechanical            |
| OPERATOR.md         | OPERATOR.md     | Instruction-following |

### Quick recommendations

- **Strict hook profile** for always-on agents (no performance penalty)
- **Session budget** of $5-10 for overnight sessions
- **Heartbeat** for 24/7 monitoring — detects stalled agents, changed conditions, rate limits
- **Network:** allow only `api.anthropic.com`, your channel API, and `github.com` when possible
- **Secrets:** don't mount `~/.aws/`, `~/.ssh/` into containers. Use scoped API keys.
- **Review session reports** before pushing — check for leaked paths, credentials, or connection strings

### Security checklist

- [ ] Docker/VM if using `permission_mode: "bypassPermissions"` — see [Always-On Setup](ALWAYS-ON.md)
- [ ] Non-root user inside container
- [ ] Deny patterns configured
- [ ] No host mounts beyond project directory
- [ ] No production credentials accessible
- [ ] Strict hook profile
- [ ] Session budget set
- [ ] Heartbeat enabled
- [ ] OPERATOR.md includes approval constraints
- [ ] Session reports reviewed before pushing

---

## 7. Operational Concerns

### Rate limits

Claude Max 20x ($200/month) recommended for overnight agents. Pro plan stalls during multi-hour sessions. Rate limit pauses are **silent** — add to OPERATOR.md:

```markdown
## Constraints

If you hit a rate limit, update SHELL.md: "Rate limited at [timestamp]. Waiting for reset."
```

### Data persistence

SHELL.md is gitignored. Protect in-progress state with Docker named volumes, periodic commits to a separate branch, or by removing SHELL.md from `.gitignore`.

### Channel resilience

If Telegram/Discord goes down, your hermit keeps running — just loses remote communication. Enable remote control as a backup. Check SHELL.md via SSH if channels are unavailable.

### Multi-operator warning

Hermit assumes one person giving it direction per project. For teams, use separate branches or git worktrees with isolated state directories.

### Docker teardown

Choose the level of cleanup you need (each is self-contained — pick one):

```bash
# Stop and remove containers + networks
docker compose -f docker-compose.hermit.yml down

# Same, but also remove the built image
docker compose -f docker-compose.hermit.yml down --rmi local
```

To also remove the generated scaffolding files:

```bash
rm -f Dockerfile.hermit docker-entrypoint.hermit.sh docker-compose.hermit.yml
```

`.env` is not removed — it may contain other project vars. To clean up hermit's entries, delete from `# --- claude-code-hermit ---` through the token line (`CLAUDE_CODE_OAUTH_TOKEN=...` or `ANTHROPIC_API_KEY=...`).

This does not touch your hermit state (`.claude-code-hermit/`) — only the Docker scaffolding. You can re-run `/claude-code-hermit:docker-setup` to regenerate it.

### Auto-restart on reboot

For Docker-based setups, `restart: unless-stopped` in `docker-compose.hermit.yml` handles this automatically. See [Always-On Setup](ALWAYS-ON.md).

For bare-tmux setups:

**Linux (systemd):**

```bash
# /etc/systemd/system/claude-agent.service
[Unit]
Description=Claude Code Agent
After=network.target

[Service]
Type=forking
User=your-username
ExecStart=/usr/bin/tmux new-session -d -s claude-agent -c /home/your-username/my-project \; send-keys "claude --permission-mode acceptEdits" Enter
ExecStop=/usr/bin/tmux kill-session -t claude-agent
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
```

**macOS (launchd):** Create a plist in `~/Library/LaunchAgents/` that starts the tmux session at login. The SessionStart hook reloads session context automatically.
