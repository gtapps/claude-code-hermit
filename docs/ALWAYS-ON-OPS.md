# Always-On Operations

Running Hermit as a persistent, always-on agent. Covers setup, lifecycle, channels, cost management, self-learning timing, security, and Docker.

For skill details, see [Skills Reference](SKILLS.md).

---

## Prerequisites

| Requirement              | For          | Notes                                       |
| ------------------------ | ------------ | ------------------------------------------- |
| **tmux**                 | Boot scripts | `brew install tmux` / `apt install tmux`    |
| **Node.js 24+**          | Hooks        | Cost tracking, session evaluation           |
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

|                        | Idle Transition (task boundary) | Full Shutdown (`/session-close`) |
| ---------------------- | ------------------------------- | -------------------------------- |
| **When**               | Task done — automatic           | Operator explicitly closes       |
| **Report archived**    | Yes                             | Yes                              |
| **Self-learning runs** | Yes                             | Yes                              |
| **Heartbeat**          | Keeps running (or starts)       | Stopped                          |
| **Channels**           | Keep running (always-on only)   | Stopped                          |
| **SHELL.md**           | Reset in-place → `idle`         | Replaced with fresh template     |
| **Applies to**         | Both interactive and always-on  | Both interactive and always-on   |

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

Docker provides containment, crash recovery via restarts, and a reproducible environment for always-on agents.

### Quick setup

For a quicker setup, just ask Claude to set it up with this prompt:

> Set up Docker for this project's claude-code-hermit always-on agent following the guide in `.claude/.claude-code-hermit/plugin/docs/ALWAYS-ON-OPS.md`, Section 7 (Docker). Create the `Dockerfile`, `docker-entrypoint.sh`, and `docker-compose.yml` at the project root using the examples from the docs. Adapt them to this project: read `config.json` to get the `tmux_session_name` and replace the `PROJECT_NAME` placeholder in the docker-compose healthcheck, create a `.env` file with placeholder values for auth (`CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`), ensure `.env` is in `.gitignore` and `.dockerignore`, and make `docker-entrypoint.sh` executable. On Windows, verify the project is inside WSL2 (not `/mnt/c/`) before proceeding. Do not start the container — just set up the files so I can review them before running `docker compose up -d`.

### Auth

**OAuth token (recommended for Pro/Max):** Run `claude setup-token` on a machine with a browser to generate a long-lived token (valid 1 year). Add it to your `.env`:

```
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...
```

The token is passed as an environment variable — no need to mount credential files. When it expires, re-run `claude setup-token` on the host and update `.env`.

**API Key:** For pay-per-token billing, set `ANTHROPIC_API_KEY` in `.env` instead. Ensure `.env` is in your `.gitignore`.

### Dockerfile

```dockerfile
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
      tmux python3 python3-venv python3-pip git curl unzip ca-certificates && \
    curl -fsSL https://deb.nodesource.com/setup_24.x | bash - && \
    apt-get install -y --no-install-recommends nodejs && \
    rm -rf /var/lib/apt/lists/*

# Bun (required for channels) and Claude Code — both via npm for global PATH
RUN npm install -g bun @anthropic-ai/claude-code

# Match host UID for volume permissions. Ubuntu 24.04 ships a default
# 'ubuntu' user at UID 1000 — remove it first.
ARG HOST_UID=1000
RUN userdel -r ubuntu 2>/dev/null; \
    useradd -m -s /bin/bash -u ${HOST_UID} claude

USER claude

COPY --chown=claude:claude docker-entrypoint.sh /home/claude/docker-entrypoint.sh
RUN chmod +x /home/claude/docker-entrypoint.sh

ENTRYPOINT ["/home/claude/docker-entrypoint.sh"]
```

**Why `ubuntu:24.04` instead of `node:24-slim`?** Node's slim images ship Python 3.11 (Debian bookworm) — projects requiring Python 3.12+ break at runtime. Ubuntu 24.04 has Python 3.12 natively and Node.js 24 via NodeSource.

**Why `npm install -g bun`?** The official Bun installer (`curl bun.sh/install | bash`) puts the binary in `~/.bun/bin` — root's home during build, inaccessible to the `claude` user at runtime. `npm install -g` puts it in `/usr/local/bin/` where every user can reach it.

Run `/claude-code-hermit:init` on the host before building.

### docker-entrypoint.sh

The entrypoint handles what Claude Code can't do headlessly: onboarding bypass, permission mode patching, and keeping PID 1 alive after tmux spawns.

```bash
#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(pwd)"
AGENT_DIR="${PROJECT_DIR}/.claude/.claude-code-hermit"

echo "[docker-entrypoint] Starting hermit container..."
echo "[docker-entrypoint] Project: ${PROJECT_DIR}"

# --- 1. Bypass Claude Code first-run onboarding ---
# Claude Code shows an interactive theme/login wizard on first run.
# DEVCONTAINER=true does NOT skip it. Both fields are required —
# hasCompletedOnboarding alone still triggers the wizard if
# lastOnboardingVersion doesn't match the installed version.
CLAUDE_JSON="${CLAUDE_CONFIG_DIR:=${HOME}/.claude}/.claude.json"
CC_VERSION=$(claude --version 2>/dev/null | grep -oP '[\d.]+' | head -1 || echo "0.0.0")
python3 -c "
import json, sys, os
path, version = sys.argv[1], sys.argv[2]
d = json.load(open(path)) if os.path.exists(path) else {}
if not d.get('hasCompletedOnboarding') or d.get('lastOnboardingVersion') != version:
    d.update({'hasCompletedOnboarding': True, 'lastOnboardingVersion': version})
    json.dump(d, open(path, 'w'))
    print(f'[docker-entrypoint] Onboarding bypass set for Claude Code v{version}')
" "$CLAUDE_JSON" "$CC_VERSION"

# --- 2. Patch permission_mode to bypassPermissions ---
# Containers run unattended — interactive permission prompts hang the agent.
CONFIG_JSON="${AGENT_DIR}/config.json"
if [ -f "$CONFIG_JSON" ]; then
  python3 -c "
import json, sys
path = sys.argv[1]
with open(path) as f: c = json.load(f)
if c.get('permission_mode') != 'bypassPermissions':
    c['permission_mode'] = 'bypassPermissions'
    with open(path, 'w') as f: json.dump(c, f, indent=2)
    print('[docker-entrypoint] permission_mode → bypassPermissions')
else:
    print('[docker-entrypoint] permission_mode OK')
" "$CONFIG_JSON"
fi

# --- 3. Launch hermit-start ---
"${AGENT_DIR}/bin/hermit-start" "$@"

# --- 4. Keep PID 1 alive ---
# hermit-start exits after spawning the tmux session. Without a foreground
# process, Docker sees PID 1 exit and kills the container. Poll tmux instead.
SESSION_NAME=$(python3 -c "
import json
with open('${CONFIG_JSON}') as f: c = json.load(f)
name = c.get('tmux_session_name', 'hermit-{project_name}')
print(name.replace('{project_name}', '$(basename "$PROJECT_DIR")'))
")
echo "[docker-entrypoint] Watching tmux session: ${SESSION_NAME}"
while tmux has-session -t "$SESSION_NAME" 2>/dev/null; do
  sleep 30
done
echo "[docker-entrypoint] tmux session ended — container exiting"
```

> **Note:** Step 2 mutates `config.json` on the bind-mounted project directory. If you later run Hermit locally (outside Docker), `permission_mode` will still be `bypassPermissions`. Reset it via `/hermit-settings permissions` or edit `config.json` manually.

### docker-compose.yml

```yaml
services:
  claude-agent:
    build:
      context: .
      args:
        HOST_UID: ${UID:-1000}
    volumes:
      - ${PWD}:${PWD}
      - ${HOME}/.claude:${HOME}/.claude
    working_dir: ${PWD}
    env_file: .env
    environment:
      - CLAUDE_CONFIG_DIR=${HOME}/.claude
      - CLAUDE_CODE_OAUTH_TOKEN=${CLAUDE_CODE_OAUTH_TOKEN}
      - AGENT_HOOK_PROFILE=strict
      - CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=50
      - MAX_THINKING_TOKENS=10000
    network_mode: host
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "tmux", "has-session", "-t", "hermit-PROJECT_NAME"]
      interval: 60s
      timeout: 5s
      retries: 3
      start_period: 30s
```

**Why host-path mounts?** Claude Code stores per-project config keyed by absolute path (base64-encoded under `~/.claude/projects/`). If the project lives at `/home/you/myproject` on the host, it must be at that exact path inside the container — otherwise Claude Code won't find installed plugins, trust settings, or session state. Replace `PROJECT_NAME` in the healthcheck with your actual tmux session name from `config.json`.

**Do not set `HOME` in the environment block.** `CLAUDE_CONFIG_DIR` tells Claude Code where to find config regardless of `HOME`. Overriding `HOME` to the host path causes permission errors because the container's `claude` user can't write to directories owned by the host user.

**Do not `source .env` in the entrypoint.** Docker Compose injects `env_file` vars into the container's environment automatically. Bash-sourcing the same file breaks on unquoted values containing special characters (like OAuth tokens).

**`network_mode: host` gives the container full host network access.** For tighter isolation, replace with a custom bridge network and explicit port mappings. See Section 6 for recommended network restrictions.

### First run

After `docker compose up -d`, Claude Code shows a one-time **workspace trust prompt** that can't be automated. The entrypoint bypasses the **onboarding wizard** (theme/login), but workspace trust ("Do you trust the files in this folder?") is a separate, per-project prompt:

```bash
docker exec -it claude-agent tmux attach -t <session-name>
# Press Enter to accept workspace trust
# Detach: Ctrl+B, D
```

This is persisted in the mounted `~/.claude/` volume and won't appear on container restarts.

### Crash recovery

Container restarts trigger Hermit's recovery automatically: the entrypoint re-seeds onboarding, hermit-start launches tmux, the SessionStart hook detects the orphaned SHELL.md, and offers to resume the interrupted task.

### Gotchas

| Issue | Fix |
| --- | --- |
| `node:22-slim` has Python 3.11 | Use `ubuntu:24.04` |
| Bun not in PATH at runtime | `npm install -g bun` instead of `curl \| bash` |
| Ubuntu 24.04 default user conflicts at UID 1000 | `userdel -r ubuntu` before `useradd` |
| Volume paths must match host | `${PWD}:${PWD}`, not `/app` or `/project` |
| `DEVCONTAINER=true` doesn't skip onboarding | Pre-seed `hasCompletedOnboarding` + `lastOnboardingVersion` |
| OAuth tokens from `/login` expire in 8–12 hours | Use `claude setup-token` (1-year token) via `CLAUDE_CODE_OAUTH_TOKEN` |
| Entrypoint exits immediately after tmux spawns | Poll `tmux has-session` to keep PID 1 alive |
| `.local` mDNS hostnames don't resolve in containers | Use IP addresses in service URLs, even with `network_mode: host` |
| Workspace trust prompt on first run | Attach once via `tmux attach`, press Enter, detach |

### Windows (WSL2 required)

The Docker setup requires Linux-native paths. Claude Code keys config by absolute path — a Windows path (`C:\Users\you\project`) can never match the Linux path inside the container, so plugins, trust settings, and session state won't be found.

Run everything from WSL2:

1. Install [WSL2](https://learn.microsoft.com/en-us/windows/wsl/install) with Ubuntu
2. Clone the project inside WSL2 (`/home/you/project`, **not** `/mnt/c/...`)
3. Install Claude Code and run `/claude-code-hermit:init` from WSL2
4. Run `docker compose up -d` from WSL2

After step 1, the workflow is identical to Linux. Do not use `/mnt/c/` paths — they go through the 9P filesystem bridge, which is slow and breaks file watchers.

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
