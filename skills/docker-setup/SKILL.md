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
      { label: "OAuth", description: "Run claude /login inside the container — recommended" },
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
- `{{AUTH_ENV_LINE}}` — If apikey: `      - ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}\n`. If oauth: empty string (remove the line entirely — OAuth credentials live in `.credentials.json` inside the named volume, written by `claude /login`).
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

Mirror host-installed plugins into the container so the container starts with the same plugin set the operator already curated — including any domain hermit (e.g. `claude-code-homeassistant-hermit`) that may have triggered this setup flow.

> **SECURITY-CRITICAL STEP.** Every plugin written here is auto-installed on container boot with `bypassPermissions` (full unrestricted execution). Do not shortcut the safelist, validation, or deselection rules below. If you find yourself about to skip one, stop and re-read this section.

1. Run `claude plugin list --json` to enumerate plugins. Each entry has `id` (in the form `plugin@slug`), `scope`, `enabled`, and `projectPath`. **Keep only entries where:**
   - `scope == "project"` **and** `projectPath` equals the current project root (the same `id` can appear multiple times for different projects — do not mirror another project's plugins), **OR**
   - `scope == "local"`.

   Drop `user`-scope entries entirely — those are the host user's personal choices across every project and do not belong in a project-specific container. If the operator wants a user-scope plugin in the container, they can install it at `project` scope on the host first and re-run this skill.
2. Filter out additionally:
   - `claude-code-hermit@claude-code-hermit` — the entrypoint already handles it unconditionally.
   - Any channel plugins already picked up via `config.channels` (they flow through the entrypoint's channel branch).
3. Run `claude plugin marketplace list --json` and build a slug → `repo` map from each entry's `name` (slug) and `repo` (`org/repo`) fields. Split each plugin `id` as `plugin@slug` and look up the slug in the map to get the full `org/repo`. The `marketplace` field written to `docker.recommended_plugins` must be `org/repo` — the entrypoint calls `claude plugin marketplace add <marketplace>` on first boot and a bare slug will fail.
   - If a marketplace entry has `source != "github"` or no `repo` field (e.g. a locally-added marketplace), ask: "What's the GitHub source for the `<slug>` marketplace? (e.g. `org/repo`)" before presenting the plugin list.

4. **Validation gate — apply to every `org/repo` before it reaches the plugin list or `config.json`:**
   - Regex: `^[A-Za-z0-9][\w.-]*/[A-Za-z0-9][\w.-]*$`
   - Applies to: `repo` values read from the marketplace JSON AND values typed by the operator.
   - If a value does not match: reject, explain why, re-prompt. Never write a failing value to config.
   - Purpose: defense-in-depth against malformed JSON, typos, or injected strings landing in `config.json` and being passed to `claude plugin marketplace add` on boot.

5. **Partition the filtered list using the safelist:**

   ```
   def is_safelisted(marketplace):
       return (
           marketplace == "claude-plugins-official"
           or marketplace.startswith("gtapps/")
       )
   ```

   The `marketplace` value passed to `is_safelisted` is the resolved `org/repo` from step 3 (or the literal string `claude-plugins-official` for official plugins) — **never** the slug from the `plugin@slug` id. If you're about to pass `claude-code-homeassistant-hermit` to `is_safelisted`, you skipped the lookup — go back to step 3.

   Split into two groups:
   - **SAFE** — `is_safelisted(marketplace)` is `True`. Examples: marketplace `claude-plugins-official`, marketplace `gtapps/claude-code-homeassistant-hermit`.
   - **THIRD-PARTY** — everything else. Examples: `obra/superpowers-marketplace`, any non-`gtapps` `org/repo`, any locally-added marketplace without a GitHub source.

   The SAFE group can be accepted as a batch. The THIRD-PARTY group **must be confirmed one-by-one**. Do not bulk-accept third-party plugins for the operator's convenience — the host list is the **candidate** set, not the trusted set.

6. **Present the choices in plain text first**, so the operator sees the full list before any prompt (`AskUserQuestion` caps options at 4, so we cannot enumerate plugins in a single question):

   ```
   Host-installed plugins detected (project + local scope only):

   Safelisted (trusted sources):
     - claude-code-setup @ claude-plugins-official (project)
     - claude-code-homeassistant-hermit @ gtapps/claude-code-homeassistant-hermit (project)

   Third-party (require individual opt-in):
     - superpowers @ obra/superpowers-marketplace (local)
   ```

7. **If the SAFE group is non-empty**, ask once with `AskUserQuestion` (header: `"Plugins"`):
   - Options: `"Mirror all"` (Recommended) / `"Pick each"` / `"Skip all"`.
   - On `Mirror all`: add every SAFE plugin to `docker.recommended_plugins` with `enabled: true`.
   - On `Pick each`: loop through the SAFE plugins; for each, ask a 2-option yes/no (`"Include"` / `"Skip"`). Only include the ones the operator confirms.
   - On `Skip all`: add nothing from this group.

8. **For the THIRD-PARTY group**, loop through each plugin individually. For each, ask a 2-option `AskUserQuestion` (header: `"Third-party"`) — `"Include"` / `"Skip"`. Include only when the operator explicitly confirms. Never batch-accept this group.

8b. **Public-repo pre-flight (for every non-`claude-plugins-official` entry that the operator has tentatively confirmed in steps 7 or 8).** From the host, run an unauthenticated check against `https://github.com/<org>/<repo>` (e.g. `curl -fsI -o /dev/null -w '%{http_code}' https://github.com/<org>/<repo>`). If the response is not `200` (i.e. `404`, redirect-to-login, or network error), the repo is private or unreachable. Tell the operator:

   > `<org>/<repo>` appears private or unreachable. The container cannot clone private repos automatically.

   Then ask with `AskUserQuestion` (header: `"Private repo"`) — `"Include anyway"` / `"Skip"`. On `Skip`: drop the entry. On `Include anyway`: keep it. Do not suggest remediations.

9. After both groups are processed: any plugin not explicitly confirmed must **not** be written to `docker.recommended_plugins`. Write only confirmed entries with `enabled: true`.

10. **Write-time assertion — run this before handing entries to step 7c.** For each confirmed entry:
    - If `marketplace == "claude-plugins-official"` → accept.
    - Else assert `marketplace` matches `^[A-Za-z0-9][\w.-]*/[A-Za-z0-9][\w.-]*$` (has a slash; is `org/repo`).
    - If any entry fails: **stop, do not write config.** Re-derive the failed entry's marketplace from the `claude plugin marketplace list --json` output (look up the slug → `repo`). If the lookup cannot produce a valid `org/repo`, prompt the operator for it (same prompt as step 3). Re-run the assertion. Only proceed to step 7c once every entry passes.
    - This catches the common failure mode where the slug from `plugin@slug` in `claude plugin list` gets written as the marketplace field verbatim (e.g. `claude-code-homeassistant-hermit` instead of `gtapps/claude-code-homeassistant-hermit`). For `claude-plugins-official` entries both forms are identical, so the bug only surfaces on non-official plugins — don't let the official entries trick you into thinking the set is valid.

11. If the filtered list is **empty** (no extras installed on the host), skip silently — no prompt, no entries written.

Record the confirmed selection as `docker.recommended_plugins`. Each entry has:
```json
{"marketplace": "<marketplace-or-org/repo>", "plugin": "<plugin-name>", "scope": "<scope>", "enabled": true}
```
The entrypoint adds the marketplace (if needed) and installs every enabled entry on first boot. See [Recommended Plugins](../../docs/recommended-plugins.md) for the full policy.

**On container-side `claude plugin marketplace add` / `plugin install` failure (either in entrypoint logs or when re-running the command manually after boot):** if the error mentions SSH auth, HTTPS credentials, `gh` not found, or `.gitconfig` read-only, **stop immediately — do not attempt workarounds inside the container.** The container has no SSH client, no `gh` CLI, and `.gitconfig` is bind-mounted read-only by design. Iterating on `GIT_CONFIG_NOSYSTEM`, `git config --global url...insteadOf`, or similar is guaranteed to fail and wastes the operator's time. Surface the error to the operator verbatim and move on — no retry unless the operator changes something host-side (makes the repo public, mirrors it, etc.) and asks to retry.

If the operator selected plugins that have corresponding `plugin_checks` entries in hatch Phase 4 (claude-code-setup, claude-md-management, skill-creator), also record those `plugin_checks` entries if not already present.

### 7c. Write Docker settings to config.json

**Pre-write gate for `docker.recommended_plugins`:** Re-run the step 7b.10 assertion on every entry. If any fails, do **not** write — return to step 7b.3 to re-resolve. This gate is the final backstop; do not bypass it even "just this once."

Write all collected Docker settings to config.json in a single update:
- `docker.network_mode` (from Step 2)
- `docker.packages` (from Step 2.3)
- `docker.recommended_plugins` (from Step 7b, post-gate)
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

**If "No — manual":** Print the full manual deployment guide below, then skip directly to Step 9 (do not attempt Login, Workspace trust, or Channel pairing — the container is not running yet):

```
Manual deployment guide
──────────────────────
1. Start the container:
   .claude-code-hermit/bin/hermit-docker up

2. (OAuth only) From a second terminal, complete login:
   .claude-code-hermit/bin/hermit-docker login

3. Accept first-run prompts (press Ctrl+B D to detach when done):
   .claude-code-hermit/bin/hermit-docker attach

   Screen 1 — Workspace trust: press Enter to accept.
   Screen 2 — Bypass Permissions (bypassPermissions mode only): arrow keys → "Yes, I accept" → Enter.

4. (Channels only) Pair each bot — DM it to get a 6-char code, then run:
   docker exec <container> tmux send-keys -t <session> \
     '/<plugin>:access pair <code> — save access.json to <project_path>/.claude.local/channels/<plugin>/ not ~/.claude' Enter
   docker exec <container> tmux send-keys -t <session> \
     '/<plugin>:access policy allowlist' Enter
   Verify access.json landed at: .claude.local/channels/<plugin>/access.json

5. Verify everything is healthy:
   .claude-code-hermit/bin/hermit-status

Re-run /claude-code-hermit:docker-setup any time you want guided help.
```

**If "Yes — build now":**
1. Run `docker compose -f docker-compose.hermit.yml up -d --build` — builds and starts. Help fix errors (daemon not running, network, disk). Do **not** use `.claude-code-hermit/bin/hermit-docker up` here — its trailing echo prints attach/detach instructions that look like imperative commands and can mislead the LLM running this skill into executing them mid-setup. The final hand-off at step 9 provides the canonical attach guidance.
2. **Verify the container stayed running:** Poll `docker compose -f docker-compose.hermit.yml ps --status running --format '{{.Service}}'` every 2s for up to 10s. If the service appears — continue to the next sub-section. If it never appears after 10s, run `docker compose -f docker-compose.hermit.yml logs --tail=30 hermit` and show the output. Help diagnose (common: image build failure, missing `.env` var, port conflict, Docker daemon not fully ready). **Do not continue to Login / Workspace trust / Channel pairing while the container is down — stop here and ask the operator to fix and re-run the skill.**

**Login (oauth only):** If operator chose oauth, proceed only once the container is confirmed running. Guide them through login:
1. Tell them: "The container is waiting for you to log in. Run this from another terminal — do not attach and run `claude` yourself, it will trigger a second login prompt and race with this one:"
   ```
   .claude-code-hermit/bin/hermit-docker login
   ```
2. This opens a browser URL for OAuth. After completing the login, credentials are saved to the named volume and the container starts automatically.
3. Wait for the operator to confirm they've logged in. Then verify by checking `docker compose -f docker-compose.hermit.yml logs --tail=20 hermit` for "Credentials detected" or "hermit-start" output.

**First-run acceptance (workspace trust + bypass mode):** Before asking the operator to attach, verify the tmux session exists inside the container (the entrypoint may still be installing plugins):
```
docker compose -f docker-compose.hermit.yml exec -T hermit tmux has-session -t <TMUX_SESSION_NAME>
```
If the session is not ready, wait and retry every 5s for up to 30s. If still absent after 30s, show the last 30 lines of entrypoint logs (`docker compose logs --tail=30 hermit`) to help diagnose, then stop.

Note: a running tmux session does **not** mean claude has finished booting — it may still be sitting on an acceptance screen waiting for input.

Once the session exists, tell the operator:

> "Attach now and accept two prompts in order — claude will look frozen until you do, and later steps will misdiagnose it as a crash if you skip this:"
> ```
> .claude-code-hermit/bin/hermit-docker attach
> ```
> **Screen 1 — Workspace trust** (always): You'll see "Accessing workspace … Quick safety check: Is this a project you created or one you trust?" — press **Enter** to accept.
>
> **Screen 2 — Bypass Permissions mode** (only if `permission_mode: bypassPermissions`, the Docker default): You'll then see the `--dangerously-skip-permissions` acknowledgement. Use the **arrow keys** to select **"Yes, I accept"**, then press **Enter**.
>
> Then press **Ctrl+B, D** to detach.

Read `config.permission_mode` from `.claude-code-hermit/config.json`. If it is NOT `bypassPermissions`, omit the "Screen 2" paragraph entirely.

Wait for the operator to confirm they have detached before continuing.

**Channel pairing** (skip if no channels or no tokens configured):

Before pairing, confirm the operator has completed the first-run acceptance step above — if they haven't, `tmux send-keys` commands will be swallowed by the consent screen and appear to do nothing.

Confirm the tmux session still exists (reuse the `has-session` check from the acceptance step). If it's gone, surface container logs and stop.

**Reload plugins first (once, before any pair command):** The claude REPL may have started before the entrypoint finished enabling channel plugins. Send one reload to make sure the `/<plugin>:access` commands are registered, then wait ~2s:

```
docker compose -f docker-compose.hermit.yml exec -T hermit \
  tmux send-keys -t <session> '/reload-plugins' Enter
```

For each channel, ask if already paired. If not:
1. Operator DMs the bot → gets a 6-char code → pastes it
2. Send pair command into tmux — append the local state dir so the LLM writes there instead of the default user path:
   ```
   docker compose -f docker-compose.hermit.yml exec -T hermit \
     tmux send-keys -t <session> '/<plugin>:access pair <code> — save access.json to <project_path>/.claude.local/channels/<plugin>/ not ~/.claude' Enter
   ```
3. Set policy: `docker compose -f docker-compose.hermit.yml exec -T hermit tmux send-keys -t <session> '/<plugin>:access policy allowlist' Enter`
4. **Verify `access.json` landed in the right place:** Check `.claude.local/channels/<plugin>/access.json` after ~3s; retry once after another 5s. If still absent, run `docker compose exec -T hermit tmux capture-pane -t <session> -p` to see whether the pair command echoed (common cause: plugin not installed in container yet, or operator paired too early before entrypoint finished). If it landed in `~/.claude/channels/<plugin>/` instead, move it:
   ```
   docker compose exec -T hermit bash -c 'src="${CLAUDE_CONFIG_DIR:-/home/claude/.claude}/channels/<plugin>/access.json"; dst="<project_path>/.claude.local/channels/<plugin>/"; [ -f "$src" ] && mkdir -p "$dst" && mv "$src" "$dst" && echo moved'
   ```
5. Confirm: "Paired and locked down. If the bot doesn't respond to your first message, give it up to 2 minutes — the hermit may still be booting or running initial checks (plugin installs, workspace trust, auto-memory seeding)."

If "skip": tell them to DM the bot later and run the commands manually.

### 8b. Finalize — clean restart

**Skip this step entirely if the operator chose "No — manual" at step 8.** The container isn't running, so there's nothing to restart.

Tell the operator (set expectations — this step takes ~30-60s and otherwise looks like a hang):

> "Finalizing setup with a clean restart so the first real hermit session starts with everything configured and plugins fully loaded."

Then run, in sequence:

1. `.claude-code-hermit/bin/hermit-docker down` — sends `/session-close --shutdown` via tmux and polls for graceful close up to 60s before removing the container. If it prints "Timed out waiting for graceful close; forcing stop", flag it in the final summary (session that witnessed setup didn't close cleanly — not blocking but worth noting).

2. `docker compose -f docker-compose.hermit.yml up -d` — recreates the container. Do **not** use `hermit-docker up` here for the same LLM-misleading-echo reason as step 8. Docker's named volume preserves credentials, plugins, workspace trust. Bind-mounts preserve `.claude.local/channels/<plugin>/access.json` and `.claude-code-hermit/`.

3. Re-verify the container stayed running (same poll as step 8.2). If it failed to come back up, surface `docker compose logs --tail=30 hermit` and stop — don't proceed to step 9.

Why this step exists: mid-setup, claude REPL starts before plugins are fully enabled and channel pairing completes. The session it was running is a "bootstrap session" full of setup chatter. A clean restart gives the operator a first *real* session with correctly-loaded plugins, fresh tmux state, and no config-time noise.

Why not `hermit-docker restart`: Docker's default stop_grace_period is 10s, which is shorter than the entrypoint's 30-iteration session-close poll — SIGKILL can land mid-close. (We raised `stop_grace_period` to 60s in the compose template, so `restart` is now also safe in principle, but `down+up` gives a recreated container which is stronger: clears ephemeral container-layer state and re-runs the entrypoint from a clean slate.)

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
