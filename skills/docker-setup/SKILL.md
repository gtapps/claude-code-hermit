---
name: docker-setup
description: Generates Docker scaffolding and walks the operator through the full deployment — token setup, build, start, MCP plugin configuration, workspace trust, and verification. Offers to back up and overwrite existing Docker files. Run after /init.
---
# Docker Setup

Generate Docker scaffolding for running hermit as an always-on autonomous agent in a container. Docker provides isolation so you can safely use `bypassPermissions` — no interactive prompts, no babysitting, crash recovery for free.

## Plan

### 1. Check prerequisites

1. Verify Docker is installed: run `docker --version`. If not found, abort with: "Docker is required. Install it from https://docs.docker.com/get-docker/"
2. Verify `/init` has been run: check that `.claude/.claude-code-hermit/config.json` exists. If not, abort with: "Run `/claude-code-hermit:init` first to set up the project."
3. Check for existing hermit Docker files at the project root (`Dockerfile.hermit`, `docker-entrypoint.hermit.sh`, `docker-compose.hermit.yml`). If ANY exist:

   List which files were found, then ask:
   "Found existing hermit Docker files: [list]. Overwrite them? (yes / no) [no]"

   - If **yes**: back up the existing files to `docker-backup/` (create the directory, move files there), then continue with generation. Mention: "Backed up to docker-backup/"
   - If **no**: abort with: "Remove or rename them first, then re-run this skill."

   `.env` is shared — never overwrite it. If it already exists, the skill appends only the missing hermit env vars (see step 7). If it doesn't exist, create it.

   > **Why `.hermit` suffix?** The project may already use `Dockerfile`, `docker-compose.yml`, etc. for its own services. Hermit-namespaced files avoid conflicts. All `docker compose` commands use `-f docker-compose.hermit.yml`.
4. **Windows/WSL2 check:** If the current working directory starts with `/mnt/c/` or `/mnt/d/`, abort with: "You're running from a Windows mount path. Clone your project inside WSL2 (e.g., /home/you/project) and run from there. Windows paths break Claude Code's path-keyed config."

### 2. Ask the operator

1. **Auth method:** "How will you authenticate?
   - **OAuth token** (recommended for Pro/Max) — run `claude setup-token` on a machine with a browser to get a 1-year token
   - **API key** — for pay-per-token billing via `ANTHROPIC_API_KEY`

   Choose: (oauth / apikey) [oauth]"

### 3. Read project config

Read `.claude/.claude-code-hermit/config.json` and extract:
- `tmux_session_name` — resolve `{project_name}` placeholder with the actual project directory name
- `agent_name` — for display in comments

Detect the project path from `pwd`.

### 4. Generate Dockerfile.hermit

Write `Dockerfile.hermit` at the project root:

```dockerfile
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
      tmux python3 python3-venv python3-pip git curl unzip ca-certificates && \
    curl -fsSL https://deb.nodesource.com/setup_24.x | bash - && \
    apt-get install -y --no-install-recommends nodejs && \
    rm -rf /var/lib/apt/lists/*

# Bun (needed by many Claude Code plugins) and Claude Code
RUN npm install -g bun @anthropic-ai/claude-code

# Match host UID for volume permissions. Ubuntu 24.04 ships a default
# 'ubuntu' user at UID 1000 — remove it first.
ARG HOST_UID=1000
RUN userdel -r ubuntu 2>/dev/null; \
    useradd -m -s /bin/bash -u ${HOST_UID} claude

USER claude

COPY --chown=claude:claude docker-entrypoint.hermit.sh /home/claude/docker-entrypoint.sh
RUN chmod +x /home/claude/docker-entrypoint.sh

ENTRYPOINT ["/home/claude/docker-entrypoint.sh"]
```

### 5. Generate docker-entrypoint.hermit.sh

Write `docker-entrypoint.hermit.sh` at the project root. Use the resolved `tmux_session_name` from step 3:

```bash
#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(pwd)"
AGENT_DIR="${PROJECT_DIR}/.claude/.claude-code-hermit"

echo "[docker-entrypoint] Starting hermit container..."
echo "[docker-entrypoint] Project: ${PROJECT_DIR}"

# --- 1. Bypass onboarding + pre-approve channel MCP servers ---
# Single load/save pass for .claude.json to avoid double I/O and race window.
# - Onboarding: Claude Code shows an interactive wizard on first run.
# - MCP approval: plugin MCP servers need per-project approval or an
#   interactive /mcp dialog blocks the server in unattended containers.
CLAUDE_JSON="${CLAUDE_CONFIG_DIR:=${HOME}/.claude}/.claude.json"
CC_VERSION=$(claude --version 2>/dev/null | grep -oP '[\d.]+' | head -1 || echo "0.0.0")
python3 -c "
import json, sys, os
path, version, project = sys.argv[1], sys.argv[2], sys.argv[3]
if os.path.exists(path):
    with open(path) as f: d = json.load(f)
else:
    d = {}
changed = False

# Onboarding bypass
if not d.get('hasCompletedOnboarding') or d.get('lastOnboardingVersion') != version:
    d.update({'hasCompletedOnboarding': True, 'lastOnboardingVersion': version})
    changed = True
    print(f'[docker-entrypoint] Onboarding bypass set for Claude Code v{version}')

# Pre-approve channel MCP servers for this project
config_path = os.path.join(project, '.claude', '.claude-code-hermit', 'config.json')
channels = []
if os.path.exists(config_path):
    with open(config_path) as f: channels = json.load(f).get('channels', [])
if channels:
    plugin_ids = {
        'discord': 'plugin:discord:discord',
        'telegram': 'plugin:telegram:telegram',
    }
    proj = d.setdefault('projects', {}).setdefault(project, {})
    enabled = proj.get('enabledMcpjsonServers', [])
    disabled_json = proj.get('disabledMcpjsonServers', [])
    disabled_mcp = proj.get('disabledMcpServers', [])
    for ch in channels:
        pid = plugin_ids.get(ch)
        if not pid:
            continue
        if pid not in enabled:
            enabled.append(pid)
            changed = True
            print(f'[docker-entrypoint] MCP server {pid}: added to enabledMcpjsonServers')
        if pid in disabled_json:
            disabled_json.remove(pid)
            changed = True
        if pid in disabled_mcp:
            disabled_mcp.remove(pid)
            changed = True
    proj['enabledMcpjsonServers'] = enabled
    proj['disabledMcpjsonServers'] = disabled_json
    proj['disabledMcpServers'] = disabled_mcp

if changed:
    with open(path, 'w') as f: json.dump(d, f)
" "$CLAUDE_JSON" "$CC_VERSION" "$PROJECT_DIR"

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
    print('[docker-entrypoint] permission_mode -> bypassPermissions')
else:
    print('[docker-entrypoint] permission_mode OK')
" "$CONFIG_JSON"
fi

# --- 3. Launch hermit-start ---
"${AGENT_DIR}/bin/hermit-start" "$@"

# --- 4. Keep PID 1 alive ---
# hermit-start exits after spawning the tmux session. Without a foreground
# process, Docker sees PID 1 exit and kills the container.
SESSION_NAME="<TMUX_SESSION_NAME>"
echo "[docker-entrypoint] Watching tmux session: ${SESSION_NAME}"
while tmux has-session -t "$SESSION_NAME" 2>/dev/null; do
  sleep 30
done
echo "[docker-entrypoint] tmux session ended — container exiting"
```

Replace `<TMUX_SESSION_NAME>` with the resolved session name from step 3.

Make the file executable: `chmod +x docker-entrypoint.hermit.sh`

### 6. Generate docker-compose.hermit.yml

Write `docker-compose.hermit.yml` at the project root. Use the resolved `tmux_session_name` from step 3 in the healthcheck:

```yaml
services:
  claude-agent:
    build:
      context: .
      dockerfile: Dockerfile.hermit
      args:
        HOST_UID: ${UID:-1000}
    volumes:
      - ${PWD}:${PWD}
      - ${HOME}/.claude:${HOME}/.claude
    working_dir: ${PWD}
    env_file: .env
    environment:
      - CLAUDE_CONFIG_DIR=${HOME}/.claude
      - <AUTH_ENV_VAR>=<AUTH_PLACEHOLDER>
      - AGENT_HOOK_PROFILE=strict
      - CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=50
      - MAX_THINKING_TOKENS=10000
    network_mode: host
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "tmux", "has-session", "-t", "<TMUX_SESSION_NAME>"]
      interval: 60s
      timeout: 5s
      retries: 3
      start_period: 30s
```

Replace:
- `<AUTH_ENV_VAR>` with `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` based on step 2
- `<AUTH_PLACEHOLDER>` with `${CLAUDE_CODE_OAUTH_TOKEN}` or `${ANTHROPIC_API_KEY}`
- `<TMUX_SESSION_NAME>` with the resolved session name

### 7. Ensure .env has hermit auth vars

If `.env` does not exist, create it. If it already exists, read it first.

Check whether the required auth var is already present in the file:

For OAuth — look for a line starting with `CLAUDE_CODE_OAUTH_TOKEN=`
For API key — look for a line starting with `ANTHROPIC_API_KEY=`

If the var is **missing**, append a hermit section to the end of the file:

For OAuth:
```
# --- claude-code-hermit ---
# Run 'claude setup-token' to generate a 1-year OAuth token
CLAUDE_CODE_OAUTH_TOKEN=your-token-here
```

For API key:
```
# --- claude-code-hermit ---
# Anthropic API key for pay-per-token billing
ANTHROPIC_API_KEY=your-key-here
```

If the var is **already present**, leave it alone — note this for step 10 (no need to prompt for the token).

### 8. Protect .env

1. Check if `.gitignore` exists at the project root
   - If it exists: check if `.env` is already listed (exact match or wildcard like `.env*`). If not, append `.env` to the file.
   - If it doesn't exist: create `.gitignore` with `.env` as the first entry.

2. Check if `.dockerignore` exists at the project root
   - If it exists: check if `.env` is already listed. If not, append `.env` to the file.
   - If it doesn't exist: create `.dockerignore` with `.env` as the first entry.

### 9. Detect channel plugins

Channel plugins resolve their config from two locations (local wins over global):

| Scope   | Path                                      | When to use                          |
| ------- | ----------------------------------------- | ------------------------------------ |
| Global  | `~/.claude/channels/<plugin>/.env`        | Single hermit instance               |
| Local   | `.claude.local/channels/<plugin>/.env`    | Multiple hermits, each with own bot  |

The plugins support `DISCORD_STATE_DIR` and `TELEGRAM_STATE_DIR` env vars to override the config directory.

Check each known channel plugin:

| Plugin   | Token var            | Docker compatible |
| -------- | -------------------- | ----------------- |
| discord  | `DISCORD_BOT_TOKEN`  | Yes               |
| telegram | `TELEGRAM_BOT_TOKEN` | Yes               |
| imessage | —                    | **No** (macOS only) |

For discord and telegram, check both local (`.claude.local/channels/<plugin>/.env`) and global (`~/.claude/channels/<plugin>/.env`) for an existing token. Build a list with each plugin's state: (a) configured locally, (b) configured globally only, (c) not configured. Store for step 12.

If imessage is detected, warn: "iMessage requires macOS with Full Disk Access and AppleScript — it does not work inside Docker containers. It will be skipped."

### 10. Guided deployment — auth token

Print the files that were created:
```
Files created:
  Dockerfile.hermit
  docker-entrypoint.hermit.sh (executable)
  docker-compose.hermit.yml
  .env (appended hermit auth vars)
```

If the auth var already had a real value in `.env` (not a placeholder), skip the token prompt — just note "Auth token already configured in .env".

Otherwise, prompt for the auth token:

For OAuth: "Paste your OAuth token below (run `claude setup-token` on a machine with a browser to get one):"
For API key: "Paste your Anthropic API key below:"

Wait for the operator to paste the token. Update the placeholder value in `.env`. Confirm: "Token saved to .env"

If the operator wants to skip this step (says "skip", "later", etc.), that's fine — remind them to add it before starting the container.

### 11. Build and start

Ask: "Ready to build and start the container? (yes / no) [yes]"

If yes (all `docker compose` commands use `-f docker-compose.hermit.yml`):
1. Run `docker compose -f docker-compose.hermit.yml build` — show the output, wait for completion. If build fails, show the error and help diagnose (common issues: Docker daemon not running, network problems, disk space). Do not proceed to `up` until the build succeeds.
2. If build succeeds, run `docker compose -f docker-compose.hermit.yml up -d` — show the output
3. Run `docker compose -f docker-compose.hermit.yml ps` to confirm the container is running. Save the container name for later steps.

If no, print the manual commands and skip to the workspace trust step.

### 12. Channel plugin configuration

Skip this step if no channel plugins were detected in step 9.

For each detected plugin (discord, telegram), handle based on its state from step 9:

**Already configured locally** (`.claude.local/channels/<plugin>/.env` has a token):
Note: "[plugin] configured with project-local bot — will connect automatically."

**Configured globally only** (`~/.claude/channels/<plugin>/.env` has a token, but no local config):
Ask: "A global [plugin] bot token exists, but if you run multiple hermits, each needs its own bot. Use a project-specific bot for this hermit? (yes / no) [no]"

- If **no**: the global token will be used. Note: "[plugin] will use the global bot token."
- If **yes**: prompt for a dedicated token (see "saving a token" below). This creates a local config so this hermit has its own bot.

**Not configured at all:**
"If you haven't set up a [plugin] bot yet, see the [plugin] tab at https://code.claude.com/docs/en/channels"
Then: "Paste your [plugin] bot token below (or 'skip'):"

**Saving a token (local scope):**

When the operator provides a token for a project-specific bot:
1. `mkdir -p .claude.local/channels/<plugin>`
2. Write the token var to `.claude.local/channels/<plugin>/.env`
3. `chmod 600 .claude.local/channels/<plugin>/.env`
4. Ensure `.claude.local/` is in `.gitignore` (check and append if missing)
5. Add the state dir env var to `docker-compose.hermit.yml`'s environment section:
   - Discord: `DISCORD_STATE_DIR=${PWD}/.claude.local/channels/discord`
   - Telegram: `TELEGRAM_STATE_DIR=${PWD}/.claude.local/channels/telegram`
6. Confirm: "[plugin] bot token saved (project-local)."

**Saving a token (global scope):**

When the operator provides a token and chose not to use local scope (or there's only one hermit):
1. `mkdir -p ~/.claude/channels/<plugin>`
2. Write the token var to `~/.claude/channels/<plugin>/.env`
3. `chmod 600 ~/.claude/channels/<plugin>/.env`
4. Confirm: "[plugin] bot token saved (global)."

**After all channels are handled:**

Token files are available to the container via volume mounts (`~/.claude` for global, `${PWD}` for local). If the container is already running, note: "Restart the container for channels to connect: `docker compose -f docker-compose.hermit.yml restart`"

Remind the operator: "After the hermit starts, you'll need to pair your account — see the pairing steps at https://code.claude.com/docs/en/channels"

### 13. Workspace trust

Tell the operator:
```
Almost done! Claude Code needs you to accept the workspace trust prompt once.

  docker exec -it <container> tmux attach -t <session-name>

  The session may already be waiting for the trust prompt — press Enter to accept.
  Then Ctrl+B, D to detach.
```

Replace `<container>` and `<session-name>` with actual values.

Wait for the operator to confirm they've done this (or say "done", "ok", etc.).

### 14. Verify

Run `.claude/.claude-code-hermit/bin/hermit-status` and show the output.

If the status looks healthy:
```
Docker setup complete! Your hermit is running.

Useful commands:
  docker compose -f docker-compose.hermit.yml logs -f      — follow logs
  docker compose -f docker-compose.hermit.yml restart      — restart the container
  docker compose -f docker-compose.hermit.yml down         — stop and remove container
  hermit-status                                            — check agent status

See docs/ALWAYS-ON.md for the full guide.
```

If something looks wrong, help the operator diagnose the issue.
