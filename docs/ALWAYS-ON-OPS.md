# Always-On Operations

Running Hermit as a persistent, always-on agent. Covers setup, lifecycle, channels, cost management, self-learning timing, security, and Docker.

For skill details, see [Skills Reference](SKILLS.md).

---

## Prerequisites

| Requirement              | For          | Notes                                       |
| ------------------------ | ------------ | ------------------------------------------- |
| **tmux**                 | Boot scripts | `brew install tmux` / `apt install tmux`    |
| **Node.js 22+**          | Hooks        | Cost tracking, session evaluation           |
| **Bun**                  | Channels     | `curl -fsSL https://bun.sh/install \| bash` |
| **Claude Code v2.1.80+** | Channels     | Required for the channels research preview  |

tmux is required. Bun and Channels are optional.

---

## 1. Starting a Persistent Session

```bash
cd /path/to/your/project
.claude/.claude-code-hermit/bin/hermit-start
```

Reads `config.json`, starts a tmux session with configured channels and permissions, auto-runs `/claude-code-hermit:session`. To stop:

```bash
.claude/.claude-code-hermit/bin/hermit-stop        # graceful (sends /session-close first)
.claude/.claude-code-hermit/bin/hermit-stop --force # immediate kill
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
> For fully isolated containers/VMs, set `permission_mode: "bypassPermissions"` in `config.json` — `hermit-start` maps this to `--dangerously-skip-permissions`. See [Permission Modes](https://code.claude.com/docs/en/permission-modes).

### Remote access

[Remote control](https://code.claude.com/docs/en/remote-control) connects from any browser or phone. Enable via config (`/hermit-settings remote`) or `--remote-control`. Connect at [claude.ai/code](https://claude.ai/code).

---

## 2. Always-On Lifecycle

> The state machine below applies to both interactive and always-on sessions. This section covers always-on infrastructure specifically.

In always-on mode, the session persists across task boundaries. Heartbeat, monitors, and channels survive between tasks.

### State flow

```
hermit-start → [in_progress] → task done → [idle] → new task → [in_progress] → ...
                                                                                  │
                                                              hermit-stop → [archived]
```

1. `hermit-start` sets `always_on: true`, launches Claude Code in tmux
2. Task completes → **idle transition**: report archived, SHELL.md reset, heartbeat keeps running
3. New task arrives (channel, NEXT-TASK.md, terminal) → back to `in_progress`
4. `hermit-stop` → **full shutdown**: close task → stop heartbeat → archive → kill tmux

### Close modes

|                        | Idle Transition (task boundary)  | Full Shutdown (`/session-close`) |
| ---------------------- | -------------------------------- | -------------------------------- |
| **When**               | Task done — automatic            | Operator explicitly closes       |
| **Report archived**    | Yes                              | Yes                              |
| **Self-learning runs** | Yes                              | Yes                              |
| **Heartbeat**          | Keeps running (or starts)        | Stopped                          |
| **Channels**           | Keep running (always-on only)    | Stopped                          |
| **SHELL.md**           | Reset in-place → `idle`          | Replaced with fresh template     |
| **Applies to**         | Both interactive and always-on   | Both interactive and always-on   |

Default: idle transition at every task boundary. Full shutdown only via explicit `/session-close` or `hermit-stop`. `--idle` flag removed (transitions are automatic).

### The task loop over time

```
╔══════════════════════════════════════════════════════════════╗
║  Task 1 → work → complete → archive S-001                  ║
║    └── Pattern detection: skipped (< 3 reports)             ║
║                                                              ║
║  Task 2 → work → complete → archive S-002                  ║
║    └── Pattern detection: skipped (only 2 reports)          ║
║                                                              ║
║  Task 3 → work → complete → archive S-003                  ║
║    └── Pattern detection: ACTIVE                            ║
║    └── Auto-proposals created if patterns found             ║
║                                                              ║
║  Task 4+ → learning loop at every boundary                  ║
║  Throughout: heartbeat ticks on schedule                     ║
╚══════════════════════════════════════════════════════════════╝
```

**Hooks fire after every assistant turn:** `cost-tracker.js` (costs), `suggest-compact.js` (context warnings), `session-diff.js` (changed files), `evaluate-session.js` (quality).

### When self-learning fires

Pattern detection runs during session close, after SHELL.md is finalized but before archiving. Requires 3+ archived reports.

**Four detection categories:**

| Category                                               | Threshold          |
| ------------------------------------------------------ | ------------------ |
| Blocker recurrence (semantic match)                    | 3+ sessions        |
| Workaround repetition                                  | 2+ sessions        |
| Cost trend (last-3 avg >50% above prior-3, AND >$1.00) | 6 sessions of data |
| Tag correlation (same tag, non-successful close)       | 3+ sessions        |

**Feedback loop:** Accepted auto-proposals that haven't recurred in 3 sessions are auto-resolved. Heartbeat self-evaluates every 20 ticks — suggests removing stale checks, adding relevant ones.

### Edge cases

- **Crash during task:** SHELL.md persists. On restart, offers to resume.
- **Crash during idle:** SHELL.md persists as `idle`. Asks for next task.
- **hermit-start when running:** Prints guidance, exits.

---

## 3. Channels

[Claude Code Channels](https://code.claude.com/docs/en/channels) (v2.1.80+) lets you talk to your agent from your phone.

### Pairing

1. Start Claude Code in tmux
2. Message the bot on Telegram/Discord/iMessage
3. Bot replies with a pairing code
4. Approve in Claude Code
5. Done — account allowlisted

### Message handling

| You send                | Hermit does                      |
| ----------------------- | -------------------------------- |
| "status"                | Concise SHELL.md summary         |
| "work on X"             | Confirms and starts/updates task |
| "why did you change X?" | Answers with session context     |
| "stop" / "abort"        | Halts work, marks blocked        |

### Local-scope config (multi-agent)

For multiple agents per project, scope channel config locally instead of user-level:

```bash
mkdir -p .claude.local/channels/discord
```

Add `access.json` with your policy and optionally a `.env` for a per-project bot token. Verify `.claude.local/` is gitignored. Same pattern for Telegram and iMessage.

---

## 4. Cost Management

The `cost-tracker` hook runs on every `Stop` event: logs to `.claude/cost-log.jsonl`, updates SHELL.md, outputs a summary. Check with `/cost`.

### Token optimization

```json
{
  "env": {
    "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE": "50",
    "MAX_THINKING_TOKENS": "10000",
    "CLAUDE_CODE_SUBAGENT_MODEL": "haiku"
  }
}
```

| Setting              | Effect                           |
| -------------------- | -------------------------------- |
| Autocompact at 50%   | Keeps working set smaller        |
| Max thinking 10K     | Prevents runaway reasoning costs |
| Subagent model haiku | Cheapest model for exploration   |

### Budgets

**Per-session:** `/hermit-settings budget`. Warns at 80%, recommends closing at 100%.
**Project-level:** Set in OPERATOR.md (`Monthly Claude budget: $200. Alert at $150.`).

---

## 5. Reconnecting After Disconnects

All state is in `sessions/SHELL.md` on disk. A disconnect loses conversation context but preserves task, progress, and blockers.

1. Reattach to tmux, start Claude Code
2. SessionStart hook loads OPERATOR.md, SHELL.md, latest report
3. `session-start` presents task, progress, blockers
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
- **Task budget** of $5–10 for overnight sessions
- **Heartbeat** for 24/7 monitoring — detects stalled agents, changed conditions, rate limits
- **Network:** allow only `api.anthropic.com`, your channel API, and `github.com` when possible
- **Secrets:** don't mount `~/.aws/`, `~/.ssh/` into containers. Use scoped API keys.
- **Review session reports** before pushing — check for leaked paths, credentials, or connection strings

### Security checklist

- [ ] Docker/VM if using `permission_mode: "bypassPermissions"`
- [ ] Non-root user inside container
- [ ] Deny patterns configured
- [ ] No host mounts beyond project directory
- [ ] No production credentials accessible
- [ ] Strict hook profile
- [ ] Task budget set
- [ ] Heartbeat enabled
- [ ] OPERATOR.md includes approval constraints
- [ ] Session reports reviewed before pushing

---

## 7. Docker

Docker provides containment and crash recovery via restarts.

### Auth

**OAuth (Pro/Max):** `claude login` on host, mount `~/.claude/` into container.
**API Key:** Use `--env-file` to avoid exposing the key in process listings:
```bash
echo "ANTHROPIC_API_KEY=sk-ant-..." > .env
docker run --env-file .env your-image
```
Ensure `.env` is in your `.gitignore`.

### Dockerfile

```dockerfile
FROM node:22-slim
RUN apt-get update && apt-get install -y tmux python3 git curl && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:$PATH"
RUN npm install -g @anthropic-ai/claude-code
RUN useradd -m -s /bin/bash claude
USER claude
WORKDIR /home/claude/project
CMD ["python3", ".claude/.claude-code-hermit/bin/hermit-start"]
```

Run `/claude-code-hermit:init` on the host before building.

### docker-compose.yml

```yaml
services:
  claude-agent:
    build: .
    volumes:
      - /path/to/your/project:/home/claude/project
      - ~/.claude:/home/claude/.claude
    environment:
      - AGENT_HOOK_PROFILE=strict
    restart: unless-stopped
```

### Crash recovery

Container restarts trigger Hermit's recovery automatically: boot script → SessionStart hook → detects orphaned SHELL.md → offers to resume.

---

## 8. Operational Concerns

### Rate limits

Claude Max 20x ($200/month) recommended for overnight agents. Pro plan stalls during multi-hour sessions. Rate limit pauses are **silent** — add to OPERATOR.md:

```markdown
## Constraints

If you hit a rate limit, update SHELL.md: "Rate limited at [timestamp]. Waiting for reset."
```

### Data persistence

SHELL.md is gitignored. Protect in-progress state with Docker named volumes, periodic commits to a separate branch, or by removing SHELL.md from `.gitignore`.

### Channel resilience

If Telegram/Discord goes down, the agent keeps running — just loses remote communication. Enable remote control as a backup. Check SHELL.md via SSH if channels are unavailable.

### Multi-operator warning

Hermit assumes one operator per project. For teams, use separate branches or git worktrees with isolated state directories.

### Auto-restart on reboot

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
