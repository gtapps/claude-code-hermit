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
3. Check for existing Docker files at the project root (`Dockerfile`, `docker-entrypoint.sh`, `docker-compose.yml`). If ANY exist:

   List which files were found, then ask:
   "Found existing Docker files: [list]. Overwrite them? (yes / no) [no]"

   - If **yes**: back up the existing files to `docker-backup/` (create the directory, move files there), then continue with generation. Mention: "Backed up to docker-backup/"
   - If **no**: abort with: "Remove or rename them first, then re-run this skill."

   Also check for `.env` — if it exists, don't overwrite it. Instead, note which env vars need to be added and print them in the guided deployment (step 10) so the operator can add them manually.
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

### 4. Generate Dockerfile

Write `Dockerfile` at the project root:

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

COPY --chown=claude:claude docker-entrypoint.sh /home/claude/docker-entrypoint.sh
RUN chmod +x /home/claude/docker-entrypoint.sh

ENTRYPOINT ["/home/claude/docker-entrypoint.sh"]
```

### 5. Generate docker-entrypoint.sh

Write `docker-entrypoint.sh` at the project root. Use the resolved `tmux_session_name` from step 3:

```bash
#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(pwd)"
AGENT_DIR="${PROJECT_DIR}/.claude/.claude-code-hermit"

echo "[docker-entrypoint] Starting hermit container..."
echo "[docker-entrypoint] Project: ${PROJECT_DIR}"

# --- 1. Bypass Claude Code first-run onboarding ---
# Claude Code shows an interactive theme/login wizard on first run.
# Both fields are required — hasCompletedOnboarding alone still triggers
# the wizard if lastOnboardingVersion doesn't match.
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

Make the file executable: `chmod +x docker-entrypoint.sh`

### 6. Generate docker-compose.yml

Write `docker-compose.yml` at the project root. Use the resolved `tmux_session_name` from step 3 in the healthcheck:

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

### 7. Generate .env

Write `.env` at the project root:

For OAuth:
```
# Claude Code auth — run 'claude setup-token' to generate a 1-year OAuth token
CLAUDE_CODE_OAUTH_TOKEN=your-token-here
```

For API key:
```
# Claude Code auth — your Anthropic API key for pay-per-token billing
ANTHROPIC_API_KEY=your-key-here
```

### 8. Protect .env

1. Check if `.gitignore` exists at the project root
   - If it exists: check if `.env` is already listed. If not, append `.env` to the file.
   - If it doesn't exist: create `.gitignore` with `.env` as the first entry.

2. Check if `.dockerignore` exists at the project root
   - If it exists: check if `.env` is already listed. If not, append `.env` to the file.
   - If it doesn't exist: create `.dockerignore` with `.env` as the first entry.

### 9. Detect MCP plugins

Scan for installed plugins that define MCP servers:
1. Run: `find ~/.claude/plugins -name ".mcp.json" 2>/dev/null`
2. For each found `.mcp.json`, extract the plugin name from the path and read the file
3. Cross-reference with `enabledPlugins` in `~/.claude/settings.json` to filter to active plugins
4. For each active MCP plugin, check if it has a `skills/` directory with a configure skill (e.g., `skills/configure/`)

Store the list of MCP plugins (with their configure skill names, if any) for the guided deployment. If plugins are found, mention:
"Detected MCP plugins: [list]. These may need configuration inside the container after first start."

### 10. Guided deployment — auth token

Print the files that were created (adjust the list if `.env` was pre-existing and not written — in that case, note "`.env` already existed — see below for required vars"):
```
Files created:
  Dockerfile
  docker-entrypoint.sh (executable)
  docker-compose.yml
  .env
```

Then prompt for the auth token:

For OAuth: "Paste your OAuth token below (run `claude setup-token` on a machine with a browser to get one):"
For API key: "Paste your Anthropic API key below:"

Wait for the operator to paste the token. Write it into `.env`, replacing the placeholder value. Confirm: "Token saved to .env"

If the operator wants to skip this step (says "skip", "later", etc.), that's fine — remind them to add it before starting the container.

### 11. Build and start

Ask: "Ready to build and start the container? (yes / no) [yes]"

If yes:
1. Run `docker compose build` — show the output, wait for completion. If build fails, show the error and help diagnose (common issues: Docker daemon not running, network problems, disk space). Do not proceed to `up` until the build succeeds.
2. If build succeeds, run `docker compose up -d` — show the output
3. Run `docker compose ps` to confirm the container is running. Save the container name for later steps.

If no, print the manual commands and skip to the workspace trust step.

### 12. MCP plugin configuration

Skip this step if no MCP plugins were detected in step 9, or if the container is not running (operator skipped step 11).

For each detected MCP plugin that has a configure skill:

1. Tell the operator which plugins need configuration and provide the exact commands to run:
   ```
   The following MCP plugins need configuration inside the container:

     [plugin-name]:  docker exec -it <container> claude /[plugin-name]:configure
   ```
2. These commands are interactive (require TTY for token input), so the operator must run them manually. Do NOT attempt to run `docker exec -it` commands yourself — they require a terminal the skill cannot provide.
3. Wait for the operator to confirm they've run the commands (or say "skip" to handle later).

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
  docker compose logs -f         — follow logs
  docker compose restart         — restart the container
  docker compose down            — stop and remove container
  hermit-status                  — check agent status

See docs/ALWAYS-ON.md for the full guide.
```

If something looks wrong, help the operator diagnose the issue.
