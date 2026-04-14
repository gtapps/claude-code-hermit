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
   - List them, then ask with `AskUserQuestion` (header: "Docker files"): **No — keep existing** (abort; remove or rename manually, then re-run) / **Yes — back up** (move to docker-backup/ and regenerate).
   - "Yes — back up" → move to `docker-backup/`, continue
   - "No — keep existing" → abort
   - Never overwrite `.env` — only append missing vars (step 5).

### 2. Ask operator and analyze project

Ask auth method and networking in a single `AskUserQuestion` call:

```
questions: [
  {
    header: "Auth",
    question: "Authentication method for the container?",
    options: [
      { label: "OAuth", description: "Run claude login inside the container — recommended" },
      { label: "API Key", description: "Set ANTHROPIC_API_KEY in .env" }
    ],
  },
  {
    header: "Networking",
    question: "Container network mode?",
    options: [
      { label: "Bridge", description: "Isolated from host-local services (default)" },
      { label: "Host", description: "Direct access to localhost services — use if hermit needs host-bound services" }
    ]
  }
]
```

Record networking choice as `docker.network_mode` (`"bridge"` or `"host"`).

3. **Project dependencies:** Scan for signals that suggest extra system packages:
   - `package.json` native addons (sqlite3, sharp, canvas, bcrypt, etc.)
   - Python files (`requirements.txt`, `pyproject.toml`, `Pipfile`)
   - Build files (`Makefile`, `CMakeLists.txt`), version managers (`.tool-versions`)
   - Database config (prisma, knex, sequelize)
   - OPERATOR.md mentions of tools/stack
   - `.claude/settings.json` and `.claude/settings.local.json` `permissions.allow` entries — allowed Bash commands reveal tools the project expects (e.g. `Bash(docker *)` → docker CLI, `Bash(python *)` → python3, `Bash(psql *)` → postgresql-client). Check for commands that need system packages not in the base image.

   Present findings conversationally with reasoning. If nothing found, say so. Record approved list as `docker.packages`.

### 3. Read config and prepare

Read `.claude-code-hermit/config.json` and extract:
- `tmux_session_name` — resolve `{project_name}` with actual directory name
- `agent_name`
- Detect project path from `pwd`

Do NOT set `AGENT_HOOK_PROFILE` in `config.json` `env` — it stays as `standard` (the host default). The strict profile is rendered into the docker-compose environment block in step 4 via `{{AGENT_HOOK_PROFILE}}`.

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
- `{{CHANNEL_ENV_LINES}}` — for each enabled channel, derive the `*_STATE_DIR` value from `channels.<name>.state_dir` in config.json and add an indented environment line:
  - `      - DISCORD_STATE_DIR=${PWD}/.claude.local/channels/discord`
  - `      - TELEGRAM_STATE_DIR=${PWD}/.claude.local/channels/telegram`
  Remove `{{CHANNEL_ENV_LINES}}` entirely if no channels configured.
- `{{CHANNEL_VOLUME_LINES}}` — for each configured channel, add an indented volume bind-mount that maps the project-local state dir into the container's `~/.claude/channels/` path. This ensures channel plugin writes stay inside the project tree (no permission prompts with `bypassPermissions`):
  - `      - ${PWD}/.claude.local/channels/discord:/home/claude/.claude/channels/discord`
  - `      - ${PWD}/.claude.local/channels/telegram:/home/claude/.claude/channels/telegram`
  Remove `{{CHANNEL_VOLUME_LINES}}` entirely if no channels configured.
- `{{AGENT_HOOK_PROFILE}}` — always `strict` for Docker (enforces `always_on` deny patterns inside the container)
- `{{TMUX_SESSION_NAME}}` — resolved session name
- `{{NETWORK_MODE_LINE}}` — If `docker.network_mode` is `"host"`: replace with `    # WARNING: host networking exposes all host-local services to the container.\n    network_mode: host`. If `"bridge"` (default): remove the line entirely (bridge is Docker's default — no directive needed).
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
   **If oauth:** No auth var needed in `.env`. Check whether `ANTHROPIC_API_KEY` is set (non-empty) in `.env`. If so, warn and ask with `AskUserQuestion` (header: "API key"): **Yes — comment out** (prefix with # to disable it) / **No — keep** (container will run in API key mode).
   Also check for and offer to remove any `CLAUDE_CODE_OAUTH_TOKEN` — this env var is not used in the new flow.
3. Ensure `.env` is listed in both `.gitignore` and `.dockerignore` (create the files if needed, append if missing).
4. **Deny patterns:** Write the `default` set from `state-templates/deny-patterns.json` into `.claude/settings.json` `permissions.deny`. Do NOT include the `always_on` set — those patterns (docker, ssh, kubectl, git push --force, etc.) are enforced by the `enforce-deny-patterns.js` hook when `AGENT_HOOK_PROFILE=strict`, which the container runs with. Writing them to settings.json would block docker commands needed by later steps in this skill.
   If `.claude/settings.json` already has `permissions.deny`, merge (never remove existing entries). Tell the operator: "Added safety deny rules for always-on operation — protects against destructive commands and credential exposure. Container-specific rules (docker, ssh, kubectl) are enforced by the hook at runtime."

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
2. **Ensure state dir:** Record `channels.<channel>.state_dir` as a relative path (e.g. `.claude.local/channels/discord`). `hermit-start` resolves it against the project root at boot and derives the `*_STATE_DIR` env var — no need to add it to `env`. Absolute paths also work.
3. **Check local token file** (`.claude.local/channels/<plugin>/.env`):
   - Already configured → "Discord is ready — connects automatically on start."
   - Not configured → ask with `AskUserQuestion` (header: "Bot token"): **Skip** (write the token to `.claude.local/channels/{channel}/.env` later and restart) / **Enter now** (paste token via Other).
     - If "Enter now" and a token was typed via Other: `mkdir -p`, write `.env`, `chmod 600`, ensure `.claude.local/` in `.gitignore`, clean stale token from `.claude/settings.local.json` `env` if present. Confirm saved.
     - If "Skip": "Write it to `.claude.local/channels/<plugin>/.env` later and restart."

### 7b. Recommended plugins

Read `plugin_checks` from config.json and extract unique plugin names where `enabled: true`. These are the plugins the operator already chose during hatch.

- **If plugins found:** present them — "These plugins are already configured. Install them in the container?" with `AskUserQuestion` (header: "Plugins"): **Yes — use current** (install all configured plugins in container) / **Adjust** (change selection via Other). If "Adjust": let the operator type which plugins to include or exclude, then record the final list.
- **If none found:** fall back to the full selection (same as hatch Phase 4):

```
questions: [
  {
    header: "Plugins",
    question: "Which recommended plugins should be installed in the container? All are from claude-plugins-official.",
    options: [
      { label: "claude-code-setup", description: "Analyzes codebase, recommends automations (skills, hooks, MCP servers, subagents)" },
      { label: "claude-md-management", description: "Audits and improves CLAUDE.md files — grades quality, proposes fixes" },
      { label: "skill-creator", description: "Builds and refines new skills from proposals" },
      { label: "None", description: "Skip all — add later via hermit-settings docker" }
    ],
    multiSelect: true
  }
]
```

Record the final list as `docker.recommended_plugins`. Each entry has:
```json
{"marketplace": "claude-plugins-official", "plugin": "<plugin-name>", "scope": "project", "enabled": true}
```
The entrypoint installs enabled plugins on first boot. Only plugins from `claude-plugins-official` are auto-installed — third-party plugins must be installed manually. See [Recommended Plugins](docs/recommended-plugins.md) for the full policy.

If the operator chose plugins not already in `plugin_checks`, also record the corresponding `plugin_checks` entries (same as hatch Phase 4).

### 7c. Write Docker settings to config.json

Write all collected Docker settings to config.json in a single update:
- `docker.network_mode` (from Step 2)
- `docker.packages` (from Step 2.3)
- `docker.recommended_plugins` (from Step 7b)
- `channels.<channel>.state_dir` (from Step 7, if applicable)

Merge into existing config — never remove existing keys.

### 8. Guided deployment

Print generated files summary:
```
Dockerfile.hermit              — container image definition
docker-entrypoint.hermit.sh    — startup script
docker-compose.hermit.yml      — orchestration config
.env                           — auth credentials
```

**Auth token (apikey only):** If operator chose apikey and `.env` already has a real key (not placeholder), skip. Otherwise ask with `AskUserQuestion` (header: "API key"): **Skip** (add `ANTHROPIC_API_KEY` to `.env` manually before starting) / **Enter now** (paste key via Other). If "Enter now" and a key was typed via Other: update `.env`.

**Build and start:** Ask with `AskUserQuestion` (header: "Deploy"): **Yes — build now** (run hermit-docker up immediately) / **No — manual** (print commands to run later).

If "Yes — build now":
1. `.claude-code-hermit/bin/hermit-docker up` — builds and starts. Help fix errors (daemon not running, network, disk).

If "No — manual": print the manual commands and skip to verify.

**Login (oauth only):** If operator chose oauth, guide them through the container login:
1. Tell them: "The container is waiting for you to log in. Run this from another terminal:"
   ```
   .claude-code-hermit/bin/hermit-docker login
   ```
2. This opens a browser URL for OAuth. After completing the login, credentials are saved to the named volume and the container starts automatically.
3. Wait for the operator to confirm they've logged in. Then verify by checking container logs for "Credentials detected" or "hermit-start" output.

**Workspace trust:** Tell the operator to attach and accept the trust prompt:
```
.claude-code-hermit/bin/hermit-docker attach
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

  .claude-code-hermit/bin/hermit-docker up        — start container
  .claude-code-hermit/bin/hermit-docker down      — graceful stop (--force to skip)
  .claude-code-hermit/bin/hermit-docker attach    — connect to tmux session
  .claude-code-hermit/bin/hermit-docker bash      — shell into container
  .claude-code-hermit/bin/hermit-docker login     — OAuth login
  .claude-code-hermit/bin/hermit-docker logs -f   — follow logs
  .claude-code-hermit/bin/hermit-docker restart   — restart container
  .claude-code-hermit/bin/hermit-status           — quick check
```

If something looks wrong, help diagnose — suggest concrete next steps.

---

## Notes

**Why `.hermit` suffix?** The project may already have its own `Dockerfile` / `docker-compose.yml`. Hermit-namespaced files avoid conflicts.

**Why `*_STATE_DIR` as OS env vars?** MCP servers (channel plugins) are separate processes that inherit OS env — they don't read `settings.local.json`. Without these env vars, the MCP server defaults to `~/.claude/channels/<plugin>/` which inside the container resolves to `/home/claude/.claude/channels/` — not bind-mounted and lost on restart.

**Why bind-mounts for channel state?** Channel plugins hardcode writes to `~/.claude/channels/<plugin>/`. In Docker, that path is on the named config volume — outside the project tree. Even with `bypassPermissions`, Claude Code's path boundary check triggers a permission prompt for writes outside the project dir. Bind-mounting the project-local state dir into `~/.claude/channels/<plugin>/` makes the kernel present both paths as the same filesystem, avoiding symlink resolution issues and keeping writes inside the project boundary.

**Why a named volume for config?** The container gets its own Claude Code config (`/home/claude/.claude`) via a Docker named volume instead of sharing the host's `~/.claude`. This prevents container state (onboarding, auto-memory, plugin cache) from leaking into host interactive sessions. The volume persists across restarts — onboarding bypass and channel plugins survive `docker compose restart`. First run is slower while the volume is populated.

**Want shared config instead?** Replace the `claude-config` named volume with a bind-mount in `docker-compose.hermit.yml`: `- ${HOME}/.claude:${HOME}/.claude` and set `CLAUDE_CONFIG_DIR=${HOME}/.claude`. Not recommended — changes in either direction leak.
