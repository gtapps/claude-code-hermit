---
name: docker-setup
description: Generates Docker scaffolding and walks the operator through the full deployment — token setup, build, start, MCP plugin configuration, workspace trust, and verification. Offers to back up and overwrite existing Docker files. Run after /init.
---
# Docker Setup

Generate Docker scaffolding for running hermit as an always-on autonomous agent in a container. Docker provides isolation so you can safely use `bypassPermissions` — no interactive prompts, no babysitting, crash recovery for free.

**Tone:** This is a guided wizard. Be friendly, clear, and encouraging. Celebrate progress at each milestone. When something fails, help the operator fix it — don't just report the error.

## Plan

**Important:** Run all checks and commands sequentially — do not use parallel tool calls. Parallel bash calls in Claude Code can cancel each other.

### 1. Check prerequisites

1. Verify Docker is installed: run `docker --version`. If not found, abort with: "Looks like Docker isn't installed yet. You'll need it for this setup — grab it from https://docs.docker.com/get-docker/ and come back!"
2. Verify `/init` has been run: check that `.claude/.claude-code-hermit/config.json` exists. If not, abort with: "Let's get the basics set up first — run `/claude-code-hermit:init` and then come back to Docker setup."
3. Check for existing hermit Docker files at the project root (`Dockerfile.hermit`, `docker-entrypoint.hermit.sh`, `docker-compose.hermit.yml`). If ANY exist:

   List which files were found, then ask:
   "I found some existing hermit Docker files: [list]. Want me to back them up and generate fresh ones? (yes / no) [no]"

   - If **yes**: back up the existing files to `docker-backup/` (create the directory, move files there), then continue. Mention: "Done — originals saved to docker-backup/"
   - If **no**: abort with: "No worries! Remove or rename them when you're ready, then re-run this skill."

   `.env` is shared — never overwrite it. If it already exists, the skill appends only the missing hermit env vars (see step 7). If it doesn't exist, create it.

   > **Why `.hermit` suffix?** The project may already use `Dockerfile`, `docker-compose.yml`, etc. for its own services. Hermit-namespaced files avoid conflicts. All `docker compose` commands use `-f docker-compose.hermit.yml`.
4. **Windows/WSL2 check:** If the current working directory starts with `/mnt/c/` or `/mnt/d/`, abort with: "Heads up — you're running from a Windows mount path. Claude Code needs native Linux paths to work properly. Clone your project inside WSL2 (e.g., `/home/you/project`) and run from there."

### 2. Ask the operator

1. **Auth method:** "First things first — how would you like to authenticate with Claude?

   - **OAuth token** (recommended for Pro/Max) — run `claude setup-token` on a machine with a browser to get a long-lived token
   - **API key** — for pay-per-token billing via `ANTHROPIC_API_KEY`

   Which one? (oauth / apikey) [oauth]"

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
      - DISCORD_STATE_DIR=<DISCORD_STATE_DIR>
      - TELEGRAM_STATE_DIR=<TELEGRAM_STATE_DIR>
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
- `<DISCORD_STATE_DIR>` — use `${PWD}/.claude.local/channels/discord`.
- `<TELEGRAM_STATE_DIR>` — use `${PWD}/.claude.local/channels/telegram`.

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

In Docker, channel tokens always go in `.claude.local/channels/<plugin>/.env` (project-local scope). The container user's `homedir()` differs from the host, so global `~/.claude/channels/` doesn't work without `*_STATE_DIR` overrides — local scope avoids this entirely and ensures each hermit has its own bot.

Check each known channel plugin:

| Plugin   | Token file                                    | Token var            | Docker compatible |
| -------- | --------------------------------------------- | -------------------- | ----------------- |
| discord  | `.claude.local/channels/discord/.env`         | `DISCORD_BOT_TOKEN`  | Yes               |
| telegram | `.claude.local/channels/telegram/.env`        | `TELEGRAM_BOT_TOKEN` | Yes               |
| imessage | —                                             | —                    | **No** (macOS only) |

For discord and telegram, check if the local token file exists and has a real value. Build a list of: (a) already configured, (b) needs configuration. Store for step 12.

If imessage is detected, note: "Heads up — iMessage needs macOS with Full Disk Access and AppleScript, so it won't work inside a Docker container. Skipping that one."

For each configured channel in `config.json`, ensure the plugin is installed at project scope so the container has it without depending on the host's global plugins:

```bash
claude plugin install discord@claude-plugins-official --scope project
claude plugin install telegram@claude-plugins-official --scope project
```

Only install plugins for channels that are actually configured. Skip if already installed.

### 10. Guided deployment — auth token

Print the files that were created:
```
All set! Here's what I generated:

  Dockerfile.hermit              — container image definition
  docker-entrypoint.hermit.sh    — startup script (onboarding bypass, permissions, launch)
  docker-compose.hermit.yml      — orchestration config
  .env                           — auth credentials (appended)
```

If the auth var already had a real value in `.env` (not a placeholder), skip the token prompt — just note "Your auth token is already configured in .env — nice, one less thing to do!"

Otherwise, prompt for the auth token:

For OAuth: "Now let's get you authenticated. Paste your OAuth token below (run `claude setup-token` on a machine with a browser to generate one):"
For API key: "Now let's get you authenticated. Paste your Anthropic API key below:"

Wait for the operator to paste the token. Update the placeholder value in `.env`. Confirm: "Token saved — you're all set for auth."

If the operator wants to skip this step (says "skip", "later", etc.), that's fine — just remind them: "No problem — just remember to add it to `.env` before starting the container."

### 11. Build and start

Ask: "Ready to build and fire up the container? (yes / no) [yes]"

If yes (all `docker compose` commands use `-f docker-compose.hermit.yml`):
1. "Building the image — this may take a minute on first run..."
   Run `docker compose -f docker-compose.hermit.yml build` — show the output, wait for completion. If build fails, show the error and help the operator fix it (common causes: Docker daemon not running, network problems, disk space). Do not proceed to `up` until the build succeeds. On success: "Image built successfully!"
2. "Starting the container..."
   Run `docker compose -f docker-compose.hermit.yml up -d` — show the output
3. Run `docker compose -f docker-compose.hermit.yml ps` to confirm the container is running. Save the container name for later steps. On success: "Container is up and running!"

If no: "No problem! When you're ready, here are the commands:" — print the manual commands and skip to the channel configuration step.

### 12. Channel plugin configuration

Skip this step if no channel plugins were detected in step 9.

"Let's set up your communication channels so you can talk to your hermit from your phone."

For each detected plugin (discord, telegram):

**Already configured** (`.claude.local/channels/<plugin>/.env` has a token):
"[Plugin] is already configured — it'll connect automatically when the container starts."

**Not configured:**
"To set up [plugin], you'll need a bot token. If you haven't created one yet, the [plugin] tab at https://code.claude.com/docs/en/channels has a step-by-step guide."
Then: "Got your [plugin] bot token? Paste it below (or 'skip' to set it up later):"

When the operator provides a token:
1. `mkdir -p .claude.local/channels/<plugin>`
2. Write the token var to `.claude.local/channels/<plugin>/.env`
3. `chmod 600 .claude.local/channels/<plugin>/.env`
4. Ensure `.claude.local/` is in `.gitignore` (check and append if missing)
5. Confirm: "[Plugin] token saved!"

**Pairing (after container is running):**

If any channel tokens were configured and the container is running, ask:

"Have you already paired your account with this bot? (yes / no) [no]"

If **yes**: "Great, you're all set — the bot will recognise you automatically."

If **no**, walk through it step by step:

1. "Let's pair your account so the bot knows who you are. Open Discord/Telegram and DM your bot — just send any message."
2. Wait for the operator to confirm they've sent the message.
3. "The bot should have replied with a 6-character pairing code. What's the code?"
4. Wait for the operator to paste the code.
5. Send the pairing command into the hermit's tmux session:
   `docker exec <container> tmux send-keys -t <session-name> '/discord:access pair <code>' Enter`
   (or `/telegram:access pair <code>` for telegram)
6. Wait a few seconds for the command to process, then lock down access:
   `docker exec <container> tmux send-keys -t <session-name> '/discord:access policy allowlist' Enter`
   (or `/telegram:access policy allowlist` for telegram)
7. Confirm: "Paired and locked down — only your account can reach the bot now."

If the operator says "skip" at any point: "No worries — you can pair later by DMing the bot. It'll reply with a code, then attach to the hermit session and run `/discord:access pair <code>` followed by `/discord:access policy allowlist`. Details at https://code.claude.com/docs/en/channels"

The `docker-compose.hermit.yml` already has `DISCORD_STATE_DIR` / `TELEGRAM_STATE_DIR` pointing to `.claude.local/channels/<plugin>` (replaced from placeholders in step 6), so the container will find both the token and access config.

If the container is already running, note: "Restart for channels to connect: `docker compose -f docker-compose.hermit.yml restart`"

### 13. Workspace trust

Tell the operator:
```
Almost there! Claude Code needs you to accept the workspace trust prompt once.

  docker exec -it <container> tmux attach -t <session-name>

  The session may already be waiting for the trust prompt — just press Enter to accept.
  Then Ctrl+B, D to detach and let it run.
```

Replace `<container>` and `<session-name>` with actual values.

Wait for the operator to confirm they've done this (or say "done", "ok", etc.).

### 14. Verify

Run `.claude/.claude-code-hermit/bin/hermit-status` and show the output.

If the status looks healthy:
```
You're all set! Your hermit is live and running autonomously.

Here are some handy commands for day-to-day:

  docker compose -f docker-compose.hermit.yml logs -f      — follow logs
  docker compose -f docker-compose.hermit.yml restart      — restart
  docker compose -f docker-compose.hermit.yml down         — stop and remove
  hermit-status                                            — quick status check

For the full operations guide, see docs/ALWAYS-ON.md.
```

If something looks wrong, help the operator diagnose — don't just report the error, suggest concrete next steps.

---

## References

Use these when the operator needs more detail or when troubleshooting:

| Topic | URL |
| ----- | --- |
| Channels setup (Discord, Telegram, iMessage) | https://code.claude.com/docs/en/channels |
| Building custom channels | https://code.claude.com/docs/en/channels-reference |
| Permission modes | https://code.claude.com/docs/en/permission-modes |
| MCP servers | https://code.claude.com/docs/en/mcp |
| Remote control | https://code.claude.com/docs/en/remote-control |
| Docker install | https://docs.docker.com/get-docker/ |
| Hermit always-on guide | docs/ALWAYS-ON.md |
| Hermit operations reference | docs/ALWAYS-ON-OPS.md |
