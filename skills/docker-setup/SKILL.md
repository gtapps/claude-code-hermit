---
name: docker-setup
description: Generates Docker scaffolding and walks the operator through the full deployment — token setup, build, start, MCP plugin configuration, workspace trust, and verification. Offers to back up and overwrite existing Docker files. Run after /hatch.
---
# Docker Setup

Generate Docker scaffolding for running hermit as an always-on autonomous agent in a container. Docker provides isolation so you can safely use `bypassPermissions` — no interactive prompts, no babysitting, crash recovery for free.

**Tone:** Friendly guided wizard. Celebrate progress. When something fails, help fix it.

**Important:** Run all checks and commands sequentially — do not use parallel tool calls.

Templates live in `${CLAUDE_SKILL_DIR}/../../state-templates/docker/`.

## Plan

### 1. Prerequisites

1. Run `docker --version`. If missing: "Docker isn't installed — grab it from https://docs.docker.com/get-docker/ and come back!"
2. Verify `.claude-code-hermit/config.json` exists. If missing: "Run `/claude-code-hermit:hatch` first, then come back."
3. If working dir starts with `/mnt/c/` or `/mnt/d/`: abort — "Clone inside WSL2 (e.g. `/home/you/project`) and run from there."
4. Check for existing `Dockerfile.hermit`, `docker-entrypoint.hermit.sh`, `docker-compose.hermit.yml` at project root. If any found:
   - List them, ask: "Back up and regenerate? (yes/no) [no]"
   - Yes → move to `docker-backup/`, continue
   - No → abort: "Remove or rename them when ready, then re-run."
   - Never overwrite `.env` — only append missing vars (step 5).

### 2. Ask operator and analyze project

1. **Auth method:** Ask oauth (recommended — runs `claude login` inside the container) or apikey (`ANTHROPIC_API_KEY` in `.env`). Default: oauth.

2. **Project dependencies:** Scan for signals that suggest extra system packages:
   - `package.json` native addons (sqlite3, sharp, canvas, bcrypt, etc.)
   - Python files (`requirements.txt`, `pyproject.toml`, `Pipfile`)
   - Build files (`Makefile`, `CMakeLists.txt`), version managers (`.tool-versions`)
   - Database config (prisma, knex, sequelize)
   - OPERATOR.md mentions of tools/stack
   - `.claude/settings.json` and `.claude/settings.local.json` `permissions.allow` entries — allowed Bash commands reveal tools the project expects (e.g. `Bash(docker *)` → docker CLI, `Bash(python *)` → python3, `Bash(psql *)` → postgresql-client). Check for commands that need system packages not in the base image.

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
  If empty, remove the `{{PACKAGES_BLOCK}}` line entirely. The block is placed after the npm install layer so changing project packages doesn't bust the npm cache.

**docker-entrypoint.hermit.sh** (from `docker-entrypoint.hermit.sh.template`):
- `{{TMUX_SESSION_NAME}}` — resolved session name

**docker-compose.hermit.yml** (from `docker-compose.hermit.yml.template`):
- `{{AUTH_ENV_LINE}}` — If apikey: `      - ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}\n`. If oauth: empty string (remove the line entirely — OAuth credentials live in `.credentials.json` inside the named volume, written by `claude login`).
- `{{CHANNEL_ENV_LINES}}` — for each configured channel, add an indented environment line:
  - `      - DISCORD_STATE_DIR=${PWD}/.claude.local/channels/discord`
  - `      - TELEGRAM_STATE_DIR=${PWD}/.claude.local/channels/telegram`
  Remove `{{CHANNEL_ENV_LINES}}` entirely if no channels configured.
- `{{TMUX_SESSION_NAME}}` — resolved session name
- **Git identity:** Check if `~/.gitconfig` exists on the host. If it does not exist, remove the `.gitconfig` bind-mount line from the rendered file and add a note in the summary: "No ~/.gitconfig found — git commits inside the container will have no author identity. Create one on the host and re-run docker-setup, or set git config manually inside the container."

### 5. Auto-memory seed

Resolve the path key: `pwd | sed 's|/|-|g'` (keeps leading dash — matches Claude Code's format, e.g. `-home-user-myproject`).

Check if `~/.claude/projects/<path-key>/memory/MEMORY.md` exists on the host:

- **If it exists:** Copy to `.claude-code-hermit/MEMORY-SEED.md`. Tell the operator: "Found existing Claude Code memory for this project — seeding it into the container so your hermit starts with full context." Then ensure `.claude-code-hermit/MEMORY-SEED.md` is in `.gitignore` (append if missing).
- **If it doesn't exist:** Do nothing. No message, no prompt.

Only the top-level project memory is seeded — not agent-scoped memories at `<path-key>/<agent-name>/`.

### 6. Environment and protection

1. If `.env` doesn't exist, create it. If it does, read it first.
2. **If apikey:** Check if `ANTHROPIC_API_KEY=` is present in `.env`. If missing, append:
   ```
   # --- claude-code-hermit ---
   ANTHROPIC_API_KEY=your-api-key-here
   ```
   If already present, leave it — note for step 8.
   **If oauth:** No auth var needed in `.env`. Check whether `ANTHROPIC_API_KEY` is set (non-empty) in `.env`. If so, warn: "Found `ANTHROPIC_API_KEY` in `.env` — Claude Code gives API keys precedence over OAuth credentials, so the container would run in API mode (no Max/Pro, no remote control). Comment it out or remove it." Offer to comment it out automatically. Also check for and offer to remove any `CLAUDE_CODE_OAUTH_TOKEN` — this env var is not used in the new flow.
3. Ensure `.env` is listed in both `.gitignore` and `.dockerignore` (create the files if needed, append if missing).
4. **Deny patterns:** Docker means always-on — include the full hardened deny set in `.claude/settings.json` `permissions.deny` by default (no wizard needed):
   ```json
   "deny": [
     "Bash(rm -rf *)",
     "Bash(git push --force*)",
     "Bash(git reset --hard*)",
     "Bash(chmod 777*)",
     "Bash(curl * | bash*)",
     "Bash(wget * | bash*)",
     "Edit(**/.claude-code-hermit/OPERATOR.md)",
     "Write(**/.claude-code-hermit/OPERATOR.md)"
   ]
   ```
   If `.claude/settings.json` already has `permissions.deny`, merge (never remove existing entries). Tell the operator: "Added safety deny rules for always-on operation — protects against destructive commands and OPERATOR.md modification."

### 7. Channel setup

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

### 8. Guided deployment

Print generated files summary:
```
Dockerfile.hermit              — container image definition
docker-entrypoint.hermit.sh    — startup script
docker-compose.hermit.yml      — orchestration config
.env                           — auth credentials
```

**Auth token (apikey only):** If operator chose apikey and `.env` already has a real key (not placeholder), skip. Otherwise prompt for the key, update `.env`. Allow "skip" — remind to add before starting.

**Build and start:** Ask "Ready to build and start? (yes/no) [yes]"

If yes:
1. `.claude-code-hermit/bin/hermit-run docker-up` — builds and starts. Help fix errors (daemon not running, network, disk).

If no: print the manual commands and skip to verify.

**Login (oauth only):** If operator chose oauth, guide them through the container login:
1. Tell them: "The container is waiting for you to log in. Run this from another terminal:"
   ```
   docker exec -it $(docker compose -f docker-compose.hermit.yml ps -q hermit) claude login
   ```
2. This opens a browser URL for OAuth. After completing the login, credentials are saved to the named volume and the container starts automatically.
3. Wait for the operator to confirm they've logged in. Then verify by checking container logs for "Credentials detected" or "hermit-start" output.

**Workspace trust:** Tell the operator to attach and accept the trust prompt:
```
docker compose -f docker-compose.hermit.yml exec hermit tmux attach -t <session>
```
Press Enter to accept, then Ctrl+B, D to detach. Wait for confirmation.

**Channel pairing** (skip if no channels or no tokens configured):

For each channel, ask if already paired. If not:
1. Operator DMs the bot → gets a 6-char code → pastes it
2. Send pair command into tmux — append the local state dir so the LLM writes there instead of the default user path:
   ```
   docker exec <container> tmux send-keys -t <session> '/<plugin>:access pair <code> — save access.json to <project_path>/.claude.local/channels/<plugin>/ not ~/.claude' Enter
   ```
3. Wait a few seconds, then set policy: `docker exec <container> tmux send-keys -t <session> '/<plugin>:access policy allowlist' Enter`
4. **Verify `access.json` landed in the right place:** Check that `access.json` exists at `.claude.local/channels/<plugin>/access.json`. If it still landed in `~/.claude/channels/<plugin>/`, move it:
   ```
   docker exec <container> bash -c 'src="${CLAUDE_CONFIG_DIR:-/home/claude/.claude}/channels/<plugin>/access.json"; dst="<project_path>/.claude.local/channels/<plugin>/"; [ -f "$src" ] && mkdir -p "$dst" && mv "$src" "$dst" && echo moved'
   ```
5. Confirm: "Paired and locked down. If the bot doesn't respond to your first message, give it up to 2 minutes — the hermit may still be booting or running initial checks (plugin installs, workspace trust, auto-memory seeding)."

If "skip": tell them to DM the bot later and run the commands manually.

### 9. Verify

Run `.claude-code-hermit/bin/hermit-status` and show output.

If healthy:
```
You're all set! Your hermit is live and running autonomously.

  .claude-code-hermit/bin/hermit-run docker-up     — start container + show attach command
  .claude-code-hermit/bin/hermit-run docker-down   — graceful stop (--force to skip)
  .claude-code-hermit/bin/hermit-status        — quick check
  docker compose -f docker-compose.hermit.yml logs -f  — follow logs
```

If something looks wrong, help diagnose — suggest concrete next steps.

---

## Notes

**Why `.hermit` suffix?** The project may already have its own `Dockerfile` / `docker-compose.yml`. Hermit-namespaced files avoid conflicts.

**Why `*_STATE_DIR` as OS env vars?** MCP servers (channel plugins) are separate processes that inherit OS env — they don't read `settings.local.json`. Without these env vars, the MCP server defaults to `~/.claude/channels/<plugin>/` which inside the container resolves to `/home/claude/.claude/channels/` — not bind-mounted and lost on restart.

**Why a named volume for config?** The container gets its own Claude Code config (`/home/claude/.claude`) via a Docker named volume instead of sharing the host's `~/.claude`. This prevents container state (onboarding, auto-memory, plugin cache) from leaking into host interactive sessions. The volume persists across restarts — onboarding bypass and channel plugins survive `docker compose restart`. First run is slower while the volume is populated.

**Want shared config instead?** Replace the `claude-config` named volume with a bind-mount in `docker-compose.hermit.yml`: `- ${HOME}/.claude:${HOME}/.claude` and set `CLAUDE_CONFIG_DIR=${HOME}/.claude`. Not recommended — changes in either direction leak.
