---
name: docker-setup
description: Generates Docker scaffolding and walks the operator through the full deployment — token setup, build, start, MCP plugin configuration, workspace trust, and verification. Offers to back up and overwrite existing Docker files. Run after /init.
---
# Docker Setup

Generate Docker scaffolding for running hermit as an always-on autonomous agent in a container. Docker provides isolation so you can safely use `bypassPermissions` — no interactive prompts, no babysitting, crash recovery for free.

**Tone:** Friendly guided wizard. Celebrate progress. When something fails, help fix it.

**Important:** Run all checks and commands sequentially — do not use parallel tool calls.

Templates live in `${CLAUDE_SKILL_DIR}/../../state-templates/docker/`.

## Plan

### 1. Prerequisites

1. Run `docker --version`. If missing: "Docker isn't installed — grab it from https://docs.docker.com/get-docker/ and come back!"
2. Verify `.claude-code-hermit/config.json` exists. If missing: "Run `/claude-code-hermit:init` first, then come back."
3. If working dir starts with `/mnt/c/` or `/mnt/d/`: abort — "Clone inside WSL2 (e.g. `/home/you/project`) and run from there."
4. Check for existing `Dockerfile.hermit`, `docker-entrypoint.hermit.sh`, `docker-compose.hermit.yml` at project root. If any found:
   - List them, ask: "Back up and regenerate? (yes/no) [no]"
   - Yes → move to `docker-backup/`, continue
   - No → abort: "Remove or rename them when ready, then re-run."
   - Never overwrite `.env` — only append missing vars (step 5).

### 2. Ask operator and analyze project

1. **Auth method:** Ask oauth (recommended, via `claude setup-token`) or apikey (`ANTHROPIC_API_KEY`). Default: oauth.

2. **Project dependencies:** Scan for signals that suggest extra system packages:
   - `package.json` native addons (sqlite3, sharp, canvas, bcrypt, etc.)
   - Python files (`requirements.txt`, `pyproject.toml`, `Pipfile`)
   - Build files (`Makefile`, `CMakeLists.txt`), version managers (`.tool-versions`)
   - Database config (prisma, knex, sequelize)
   - OPERATOR.md mentions of tools/stack

   Present findings conversationally with reasoning. If nothing found, say so. Write approved list to `config.json` `docker.packages`.

### 3. Read config and prepare

Read `.claude-code-hermit/config.json` and extract:
- `tmux_session_name` — resolve `{project_name}` with actual directory name
- `agent_name`
- Detect project path from `pwd`

Set `AGENT_HOOK_PROFILE` to `"strict"` in `config.json` `env`. Write back.

### 4. Render templates

Read the three templates from `${CLAUDE_SKILL_DIR}/../../state-templates/docker/` and write to project root, replacing placeholders:

**Dockerfile.hermit** (from `Dockerfile.hermit.template`):
- `{{PACKAGES_BLOCK}}` — if `docker.packages` is non-empty, replace with:
  ```
  # Project-specific packages (from config.json docker.packages)
  # To modify: /hermit-settings docker, then rebuild
  RUN apt-get update && apt-get install -y --no-install-recommends \
        <space-separated packages> && \
      rm -rf /var/lib/apt/lists/*
  ```
  If empty, remove the `{{PACKAGES_BLOCK}}` line entirely.

**docker-entrypoint.hermit.sh** (from `docker-entrypoint.hermit.sh.template`):
- `{{TMUX_SESSION_NAME}}` — resolved session name
- Make executable: `chmod +x docker-entrypoint.hermit.sh`

**docker-compose.hermit.yml** (from `docker-compose.hermit.yml.template`):
- `{{AUTH_ENV_LINE}}` — `CLAUDE_CODE_OAUTH_TOKEN=${CLAUDE_CODE_OAUTH_TOKEN}` or `ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}`
- `{{CHANNEL_ENV_LINES}}` — for each configured channel, add an indented environment line:
  - `      - DISCORD_STATE_DIR=${PWD}/.claude.local/channels/discord`
  - `      - TELEGRAM_STATE_DIR=${PWD}/.claude.local/channels/telegram`
  Remove `{{CHANNEL_ENV_LINES}}` entirely if no channels configured.
- `{{TMUX_SESSION_NAME}}` — resolved session name

### 5. Environment and protection

1. If `.env` doesn't exist, create it. If it does, read it first.
2. Check if the auth var (`CLAUDE_CODE_OAUTH_TOKEN=` or `ANTHROPIC_API_KEY=`) is present. If missing, append:
   ```
   # --- claude-code-hermit ---
   CLAUDE_CODE_OAUTH_TOKEN=your-token-here
   ```
   (or the apikey equivalent). If already present, leave it — note for step 7.
3. Ensure `.env` is listed in both `.gitignore` and `.dockerignore` (create the files if needed, append if missing).

### 6. Channel setup

Skip if no channels in `config.json`.

**Token locations in Docker:** Always use `.claude.local/channels/<plugin>/.env` (project-local scope). Never read or copy from global `~/.claude/channels/`.

| Plugin   | Token var            | Docker compatible |
|----------|----------------------|-------------------|
| discord  | `DISCORD_BOT_TOKEN`  | Yes               |
| telegram | `TELEGRAM_BOT_TOKEN` | Yes               |
| imessage | —                    | No (macOS only)   |

If iMessage detected, note it won't work in Docker and skip.

For each configured channel:

1. **Install plugin locally** (if not already): `claude plugin install <plugin>@claude-plugins-official --scope local`
2. **Ensure state dir in config.json `env`:** Add `DISCORD_STATE_DIR` / `TELEGRAM_STATE_DIR` using the absolute project path (e.g. `/home/user/project/.claude.local/channels/discord`). Write back if changed.
3. **Check local token file** (`.claude.local/channels/<plugin>/.env`):
   - Already configured → "Discord is ready — connects automatically on start."
   - Not configured → prompt: "Paste your bot token (or 'skip'):"
     - On token: `mkdir -p`, write `.env`, `chmod 600`, ensure `.claude.local/` in `.gitignore`, clean stale token from `.claude/settings.local.json` `env` if present. Confirm saved.
     - On skip: "Write it to `.claude.local/channels/<plugin>/.env` later and restart."

### 7. Guided deployment

Print generated files summary:
```
Dockerfile.hermit              — container image definition
docker-entrypoint.hermit.sh    — startup script
docker-compose.hermit.yml      — orchestration config
.env                           — auth credentials
```

**Auth token:** If `.env` already has a real token (not placeholder), skip. Otherwise prompt for the token (oauth or apikey), update `.env`. Allow "skip" — remind to add before starting.

**Build and start:** Ask "Ready to build and start? (yes/no) [yes]"

If yes:
1. `docker compose -f docker-compose.hermit.yml build` — wait for success. Help fix errors (daemon not running, network, disk).
2. `docker compose -f docker-compose.hermit.yml up -d`
3. `docker compose -f docker-compose.hermit.yml ps` — save container name.

If no: print the manual commands and skip to verify.

**Workspace trust:** Tell the operator to attach and accept the trust prompt:
```
docker exec -it <container> tmux attach -t <session>
```
Press Enter to accept, then Ctrl+B, D to detach. Wait for confirmation.

**Channel pairing** (skip if no channels or no tokens configured):

For each channel, ask if already paired. If not:
1. Operator DMs the bot → gets a 6-char code → pastes it
2. Send pair command into tmux: `docker exec <container> tmux send-keys -t <session> '/<plugin>:access pair <code>' Enter`
3. Wait a few seconds, then set policy: `docker exec <container> tmux send-keys -t <session> '/<plugin>:access policy allowlist' Enter`
4. Confirm: "Paired and locked down."

If "skip": tell them to DM the bot later and run the commands manually.

### 8. Verify

Run `.claude-code-hermit/bin/hermit-status` and show output.

If healthy:
```
You're all set! Your hermit is live and running autonomously.

  docker compose -f docker-compose.hermit.yml logs -f      — follow logs
  docker compose -f docker-compose.hermit.yml restart      — restart
  docker compose -f docker-compose.hermit.yml down         — stop
  hermit-status                                            — quick check

To attach:
  docker exec -it <container> tmux attach -t <session>
  (Ctrl+B, D to detach)
```

If something looks wrong, help diagnose — suggest concrete next steps.

---

## Notes

**Why `.hermit` suffix?** The project may already have its own `Dockerfile` / `docker-compose.yml`. Hermit-namespaced files avoid conflicts.

**Why `*_STATE_DIR` in compose `environment:`?** MCP servers (channel plugins) are separate processes that inherit OS env — they don't read `settings.local.json`. Without these env vars, the MCP server defaults to `~/.claude/channels/<plugin>/` which resolves to the container user's home, not the bind-mounted project path.

**Channel plugin workaround (v0.0.4):** The channel plugin skills (`/discord:access`, `/discord:configure`, etc.) hardcode `~/.claude/channels/<plugin>/` paths, ignoring `*_STATE_DIR`. After the container starts, patch the skill files inside the container to resolve `$*_STATE_DIR` first and fall back to the default if unset. Files are at `~/.claude/plugins/marketplaces/claude-plugins-official/external_plugins/<plugin>/skills/*/SKILL.md`. This workaround will be unnecessary once Anthropic fixes the plugins.
