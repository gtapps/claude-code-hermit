---
name: docker-setup
description: Generates Docker scaffolding and walks the operator through the full deployment — token setup, build, start, MCP plugin configuration, workspace trust, and verification. Offers to back up and overwrite existing Docker files. Run after /hatch.
---
# Docker Setup

Generate Docker scaffolding for running hermit as an always-on autonomous agent in a container. Docker provides isolation, crash recovery, and a reproducible environment. The default `auto` mode (classifier-reviewed autonomy) works well for most Docker hermits. Operators who need zero prompts for fully unattended operation can opt into `bypassPermissions` via `/hermit-settings permissions`.

**Tone:** Friendly guided wizard. Celebrate progress. When something fails, help fix it.

**Important:** Step 0's container check is a hard short-circuit — run it first and abort on `container` before anything else. After confirming host execution, run `docker-preflight.ts` once (Step 1) — it gathers all the read-only signals (docker presence, config existence, WSL path, existing docker files, host `~/.gitconfig`, auto-memory seed) as a single JSON blob, so don't fan those probes out into separate Bash calls. Reuse its result for the git-identity (Step 4) and auto-memory (Step 5) decisions rather than re-probing. Step 2's project-dependency scan stays normal file reads (Read tool) plus analysis. Everything that mutates state or drives the container (file backups, `docker compose`, `tmux`, `mkdir`/`touch` setup-mode, status polls, channel `send-keys`) must run strictly sequentially in its documented order — never batch those.

Templates live in `${CLAUDE_SKILL_DIR}/../../state-templates/docker/`.

## Plan

### 0. Refuse to run inside the hermit container

This skill is host-only — it generates Docker scaffolding on the host filesystem and drives `docker compose up`.

Run: `[ -f /.dockerenv ] || [ -f /run/.containerenv ] && echo container || echo host`

If the output is `container`, **stop immediately** — do not proceed to step 1. Print:

> This skill generates host-side Docker scaffolding and then drives `docker compose up`. Run it from your host shell in the project root. To check what's already configured *inside* the running container, run `/claude-code-hermit:hermit-doctor`.

### 1. Prerequisites

Run the pre-flight probe once and parse its JSON: `bun ${CLAUDE_PLUGIN_ROOT}/scripts/docker-preflight.ts "$(pwd)"` — pass `"$(pwd)"` so the auto-memory path key is keyed off the shell's logical path, matching Claude Code even through a symlinked project root. It returns `{ dockerVersion, configExists, isWSL, existing: {dockerfile, entrypoint, compose}, gitconfigExists, memory: {pathKey, seedExists} }`. Hold the result — Steps 4 and 5 reuse `gitconfigExists` and `memory` instead of re-probing. Apply these gates:

1. If `dockerVersion` is null: "Docker isn't installed — grab it from https://docs.docker.com/get-docker/ and come back!"
2. If `configExists` is false: "Run `/claude-code-hermit:hatch` first, then come back."
3. If `isWSL` is true: abort — "Clone inside WSL2 (e.g. `/home/you/project`) and run from there."
4. If any of `existing.dockerfile` / `existing.entrypoint` / `existing.compose` is true:
   - List them, then ask with `AskUserQuestion` (header: "Docker files"): **No — keep existing** (abort; remove or rename manually, then re-run) / **Yes — back up** (move to docker-backup/ and regenerate).
   - "Yes — back up" → move to `docker-backup/`, continue
   - "No — keep existing" → abort
   - Never overwrite `.env` — only append missing vars (step 5).

### 1.5. Setup mode gate

Determine whether to run in **Quick** or **Advanced** mode.

**Argument-driven**: if invoked with the positional argument `quick` (e.g. `/claude-code-hermit:docker-setup quick`), skip the question below and run Quick directly. This is what `hatch` chains to at the end of a Quick hatch run. The operator can always re-invoke `/claude-code-hermit:docker-setup` without the arg later to drop into Advanced.

**Otherwise, ask:**

```
questions: [
  {
    header: "Setup mode",
    question: "How would you like to configure Docker?",
    options: [
      { label: "Quick", description: "OAuth + bridge networking, auto-mirror trusted plugins, build immediately" },
      { label: "Advanced", description: "Full wizard — pick auth, networking, every plugin, every package" }
    ]
  }
]
```

**Quick-mode contract — security non-negotiables.** Quick mode never bulk-accepts third-party plugins, never weakens the safelist, never skips the public-repo pre-flight, and never bypasses the write-time assertion. Those gates exist because that's the line where defaults stop being safe. Quick only auto-defaults the choices that have one obviously-correct answer (auth, networking, build-now) and the SAFE plugin batch (claude-plugins-official + gtapps/* — already vetted by the safelist).

Branch on the choice for the rest of the skill:
- **Advanced** → run today's flow unchanged from Step 2.
- **Quick** → apply Quick defaults silently throughout (Step 2 auth+network, Step 7b SAFE mirror, Step 7b.packages safelisted-source auto-accept, Step 8 build-now). The Quick-specific behavior is called out inline at each downstream step.

### 2. Ask operator and analyze project

**Quick:** silently apply `auth = oauth`, `docker.network_mode = "bridge"`. Skip the `AskUserQuestion` below. Continue at the project-dependencies scan below.

**Advanced:** ask auth method and networking in a single `AskUserQuestion` call:

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

**Project dependencies scan:** Scan for signals that suggest extra system packages:
   - `package.json` native addons (sqlite3, sharp, canvas, bcrypt, etc.)
   - Python files (`requirements.txt`, `pyproject.toml`, `Pipfile`)
   - Build files (`Makefile`, `CMakeLists.txt`), version managers (`.tool-versions`)
   - Database config (prisma, knex, sequelize)
   - OPERATOR.md mentions of tools/stack
   - `.claude/settings.json` and `.claude/settings.local.json` `permissions.allow` entries — allowed Bash commands reveal tools the project expects (e.g. `Bash(docker *)` → docker CLI, `Bash(python *)` → python3, `Bash(psql *)` → postgresql-client). Check for commands that need system packages not in the base image.

   Present findings conversationally with reasoning. If nothing found, say so. Collect as provisional candidates — confirmation is deferred to step 7b.packages after plugin selection, where plugin-declared deps are unioned in.

### 3. Read config and prepare

Read `.claude-code-hermit/config.json` and extract:
- `tmux_session_name` — resolve `{project_name}` with actual directory name
- `agent_name`
- Detect project path from `pwd`

Do NOT set `AGENT_HOOK_PROFILE` in `config.json` `env` — it stays as `standard` (the host default). The strict profile is rendered into the docker-compose environment block in step 4 via `{{AGENT_HOOK_PROFILE}}`.

### 4. Template placeholder reference (rendering deferred to Step 7b.6)

> **Execution moved.** Template rendering is now performed at Step 7b.6 — AFTER plugin resolution (Step 7b) and apt-package union (Step 7b.packages) have finalized `docker.packages`. The placeholder definitions are documented here for reference; the actual `Read` + `Write` calls happen later, with all values resolved.
>
> Why: `{{PACKAGES_BLOCK}}` substitution depends on `docker.packages`, which isn't finalized until Step 7b.packages. Rendering at Step 4 (the original position) consumed an empty/pre-resolution package list. Channel placeholders (`{{CHANNEL_ENV_LINES}}`, `{{CHANNEL_VOLUME_LINES}}`) similarly depend on Step 7 channel-token configuration.

The three templates live in `${CLAUDE_SKILL_DIR}/../../state-templates/docker/`. Placeholder substitution rules per file (do NOT read or write here — all file I/O happens at Step 7b.6):

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
- No placeholder substitution needed — the entrypoint resolves the tmux session name from
  `config.json` at runtime. Copy verbatim; the resulting file is correct without any edits.

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
- **Git identity:** Use `gitconfigExists` from the Step 1 preflight. If false, remove the `.gitconfig` bind-mount line from the rendered file and add a note in the summary: "No ~/.gitconfig found — git commits inside the container will have no author identity. Create one on the host and re-run docker-setup, or set git config manually inside the container."

### 5. Auto-memory seed

The Step 1 preflight already resolved `memory.pathKey` (`pwd | sed 's|/|-|g'` — keeps leading dash, matches Claude Code's format, e.g. `-home-user-myproject`) and `memory.seedExists` (whether `~/.claude/projects/<pathKey>/memory/MEMORY.md` exists). Reuse those:

- **If `memory.seedExists` is true:** Copy `~/.claude/projects/<memory.pathKey>/memory/MEMORY.md` to `.claude-code-hermit/MEMORY-SEED.md`. Tell the operator: "Found existing Claude Code memory for this project — seeding it into the container so your hermit starts with full context." Then ensure `.claude-code-hermit/MEMORY-SEED.md` is in `.gitignore` (append if missing).
- **If false:** Do nothing. No message, no prompt.

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
4. **Deny patterns:** Merge the `default` deny set into the target settings file.

   **Resolve `hatch_target`** using the same fallback chain as `hermit-evolve` SKILL.md §2a (`.claude-code-hermit/state/hatch-options.json` `"target"` field → marker scan of `CLAUDE.local.md` / `CLAUDE.md` → `claude plugin list --json` scope detection). Do not silently default to committed when the state file is absent — that can leak operator-personal hardening into the repo. Map: `hatch_target == "local"` → `.claude/settings.local.json`; `hatch_target == "committed"` → `.claude/settings.json`.

   Run: `bun ${CLAUDE_PLUGIN_ROOT}/scripts/apply-settings.ts <resolved-settings-file> deny minimal`
   (Reads canonical default set from `state-templates/deny-patterns.json`; never removes existing entries. Does NOT include `always_on` patterns — docker/ssh/kubectl are valid for later steps and are enforced at runtime by the hook under strict profile.)

   Tell the operator: "Added safety deny rules for always-on operation — protects against destructive commands and credential exposure. Container-specific rules (docker, ssh, kubectl) are enforced by the hook at runtime. Written to {.claude/settings.local.json | .claude/settings.json}."

5. **Sandbox note:** The hermit Docker base image ships `bubblewrap` and `socat` (added in v1.1.2), so the Claude Code sandbox can run inside the container. `hermit-start.ts` automatically writes `sandbox.enableWeakerNestedSandbox: true` to `.claude/settings.local.json` on every Docker boot — this is required for bwrap to start inside an unprivileged container. The sandbox profile itself (enabled/disabled, filesystem denies) is set at `/hatch` time and lives in the operator's settings file; docker-setup does not modify it.

### 7. Channel setup

Skip if no enabled channels in `config.json`. Read `.claude-code-hermit/config.json` from the project root (same root verified in Step 1 — do not rely on cwd). A channel counts as present when `config.channels[<name>].enabled !== false` (missing `enabled` is treated as enabled). Empty `channels: {}` skips.

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

> **SECURITY-CRITICAL STEP.** Every plugin written here is auto-installed on container boot with whatever `permission_mode` the operator chose — for `bypassPermissions` hermits, this means full unrestricted execution. Do not shortcut the safelist, validation, or deselection rules below. If you find yourself about to skip one, stop and re-read this section.

1. Run `claude plugin list --json` to enumerate plugins. Each entry includes `id` (form `<plugin>@<marketplace_name>`), `scope`, `enabled`, `projectPath`, and `installPath`. Apply the **project-or-local + enabled filter**:
   - Keep `enabled == true` AND (`scope == "project"` OR `scope == "local"`) AND `projectPath` equals the current project root.
   - Drop user-scope, managed-scope, disabled, and cross-project entries entirely.

   `claude plugin list --json` lists across the operator's full config — local-scope plugins from sibling repos carry their own `projectPath` and must be excluded.

   **Dedupe rule.** After filtering, dedupe surviving entries by `(plugin, marketplace_name)`. If both a `project` and a `local` scope entry survive for the same `(plugin, marketplace_name)`, keep the `local` entry only — local is the override scope in Claude Code's overlay model. Different marketplaces remain distinct entries.

   If the operator wants a user-scope plugin in the container, they install it at `project` scope on the host first and re-run this skill.
2. Filter out additionally:
   - `claude-code-hermit@claude-code-hermit` — the entrypoint already handles it unconditionally.
   - Any channel plugins already picked up via `config.channels` (they flow through the entrypoint's channel branch).
3. Run `claude plugin marketplace list --json` and build a `marketplace_name → repo` map from each entry's `name` and `repo` fields. Split each plugin `id` as `<plugin>@<marketplace_name>` and look up `marketplace_name` in the map to get the `org/repo`. Only the `org/repo` is recorded on each `docker.recommended_plugins` entry — the entrypoint resolves the canonical marketplace name at boot via the same `marketplace list --json` lookup, so storing it twice would just duplicate the source of truth.
   - If a marketplace entry has `source != "github"` or no `repo` field (e.g. a locally-added marketplace), ask: "What's the GitHub source for the `<marketplace_name>` marketplace? (e.g. `org/repo`)" before presenting the plugin list.

4. **Validation gate — apply to every `org/repo` before it reaches the plugin list or `config.json`:**
   - Regex: `^[A-Za-z0-9][\w.-]*/[A-Za-z0-9][\w.-]*$`
   - Applies to: `repo` values read from the marketplace JSON AND values typed by the operator.
   - If a value does not match: reject, explain why, re-prompt. Never write a failing value to config.
   - Purpose: defense-in-depth against malformed JSON, typos, or injected strings landing in `config.json` and being passed to `claude plugin marketplace add` on boot.

5. **Partition the filtered list using the safelist:**

   ```
   def is_safelisted(marketplace):
       # marketplace is always org/repo after the step 7b.3 lookup — no literal-name shortcut.
       return (
           marketplace == "anthropics/claude-plugins-official"
           or marketplace.startswith("gtapps/")
       )
   ```

   The `marketplace` value passed to `is_safelisted` is always the `org/repo` resolved in step 7b.3 — never the marketplace name and never the slug from the `<plugin>@<name>` id. If you're about to pass `claude-code-homeassistant-hermit` (a slug) to `is_safelisted`, you skipped the lookup — go back to step 3.

   Split into two groups:
   - **SAFE** — `is_safelisted(marketplace)` is `True`. Examples: `anthropics/claude-plugins-official`, `gtapps/claude-code-homeassistant-hermit`.
   - **THIRD-PARTY** — everything else. Examples: `obra/superpowers-marketplace`, any non-`gtapps` `org/repo`, any locally-added marketplace without a GitHub source.

   The SAFE group can be accepted as a batch. The THIRD-PARTY group **must be confirmed one-by-one**. Do not bulk-accept third-party plugins for the operator's convenience — the host list is the **candidate** set, not the trusted set.

6. **Present the choices in plain text first**, so the operator sees the full list before any prompt (`AskUserQuestion` caps options at 4, so we cannot enumerate plugins in a single question):

   ```
   Host-installed plugins detected (project + local scope only):

   Safelisted (trusted sources):
     - claude-code-setup @ anthropics/claude-plugins-official (project)
     - claude-code-homeassistant-hermit @ gtapps/claude-code-homeassistant-hermit (project)

   Third-party (require individual opt-in):
     - superpowers @ obra/superpowers-marketplace (local)
   ```

7. **If the SAFE group is non-empty**:

   **Quick:** silently treat as if `"Mirror all"` was chosen — add every SAFE plugin to `docker.recommended_plugins` with `enabled: true`. No prompt.

   **Advanced:** ask once with `AskUserQuestion` (header: `"Plugins"`):
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
    - Assert `marketplace` matches `^[A-Za-z0-9][\w.-]*/[A-Za-z0-9][\w.-]*$` (has a slash; is `org/repo`). Uniform across official and third-party entries — official stores `anthropics/claude-plugins-official`, no more literal-name shortcut.
    - If any entry fails: **stop, do not write config.** Re-derive the failing entry's `org/repo` from the `claude plugin marketplace list --json` output (look up the marketplace name from the plugin's `id` to get the `repo`). If the lookup cannot produce a valid `org/repo`, prompt the operator (same prompt as step 3). Re-run the assertion. Only proceed to step 7c once every entry passes.

11. If the filtered list is **empty** (no extras installed on the host), skip silently — no prompt, no entries written.

Record the confirmed selection as `docker.recommended_plugins`. Each entry has:
```json
{"plugin": "<plugin-name>", "marketplace": "<org/repo>", "scope": "<scope>", "enabled": true}
```
The entrypoint resolves the canonical marketplace name at boot via `claude plugin marketplace list --json` (no need to store it on the entry), adds the marketplace if missing, and installs every enabled entry on first boot. See [Recommended Plugins](../../docs/recommended-plugins.md) for the full policy.

**Legacy config note.** Re-running this skill against a pre-v1.0.34 config rebuilds `docker.recommended_plugins` from scratch from the current host plugin list — legacy entries (e.g. `marketplace == "claude-plugins-official"` literal) are replaced cleanly. The entrypoint warns and skips any legacy entry whose `marketplace` is not an `org/repo` until the operator re-runs this skill once.

**On container-side `claude plugin marketplace add` / `plugin install` failure (either in entrypoint logs or when re-running the command manually after boot):** if the error mentions SSH auth, HTTPS credentials, `gh` not found, or `.gitconfig` read-only, **stop immediately — do not attempt workarounds inside the container.** The container has no SSH client, no `gh` CLI, and `.gitconfig` is bind-mounted read-only by design. Iterating on `GIT_CONFIG_NOSYSTEM`, `git config --global url...insteadOf`, or similar is guaranteed to fail and wastes the operator's time. Surface the error to the operator verbatim and move on — no retry unless the operator changes something host-side (makes the repo public, mirrors it, etc.) and asks to retry.

If the operator selected plugins that have corresponding `scheduled_checks` entries in hatch Phase 4 (claude-code-setup, claude-md-management, skill-creator, feature-dev), also record those `scheduled_checks` entries if not already present.

### 7b.packages: Plugin-declared apt dependencies

After plugin selection is finalized, union the two sources of apt package candidates before writing to config:

1. **Project candidates** (from step 2.3 scan) — project-owned signals (native addons, Python stack, build tools, etc.). Live-scanned from project files each run.

2. **Plugin declarations** — for each confirmed entry in `docker.recommended_plugins`, locate the plugin's installed root via `claude plugin list --json` (inspect path fields). In the plugin root:
   - Check for a `## Docker apt dependencies` section in `skills/hatch/SKILL.md`.
   - Also check for a `DOCKER.md` file at the plugin root with the same section.
   - Extract the bullet-list entries under that heading (stop at the next `##` heading). Ignore lines starting with `#`.
   - **Validate every extracted package name** against `^[a-z0-9][a-z0-9+\-.]+$`. Entries that fail are dropped with a clear warning to the operator — never passed to Dockerfile rendering.
   - Track provenance: `<package-name> — declared by <plugin-name>`.
   - If no section is found for a plugin, skip silently (backward-compatible with plugins that predate this convention).

3. **Unified confirmation prompt** — present the combined deduped list with origin labels:
   ```
   Proposed image packages:
     libsqlite3-dev       — project signal (package.json sqlite3)
     <package-a>          — declared by <plugin-name>
     <package-b>          — declared by <plugin-name>
   ```
   Operator approves, removes, or adds entries. Write the approved set as the final `docker.packages` (passed to step 7c for config.json write).

   **Quick mode auto-accept**: if every entry in the combined list (a) passed the validator regex and (b) came from a safelisted source — meaning project-signal entries OR entries declared by plugins where `is_safelisted(marketplace)` is true (claude-plugins-official + gtapps/*) — skip the prompt and accept the list silently. Print a one-line summary so the operator sees what landed: `Quick auto-accepted N image packages (all from safelisted sources). Configure later via /hermit-settings docker.` If ANY entry came from a third-party plugin (operator-confirmed in Step 7b), fall through to the prompt — defaults stop applying once a third-party source contributed apt deps.

### 7b.6. Render templates (deferred from Step 4)

Now that `docker.packages` (Step 7b.packages), `docker.recommended_plugins` (Step 7b), channel state dirs (Step 7), and the auth/network choices (Step 2) are all finalized, perform the template rendering described in Step 4 above. Write the three rendered files to project root:

- `Dockerfile.hermit` — substitute `{{PACKAGES_BLOCK}}` with the finalized `docker.packages`.
- `docker-entrypoint.hermit.sh` — **copy with `cp`, do not regenerate it by hand** (it is a large static file with no placeholders; the session name is resolved from `config.json` at container startup). Run: `cp "${CLAUDE_SKILL_DIR}/../../state-templates/docker/docker-entrypoint.hermit.sh.template" <PROJECT_ROOT>/docker-entrypoint.hermit.sh`. The copied bytes are correct without any edits.
- `docker-compose.hermit.yml` — substitute `{{AUTH_ENV_LINE}}`, `{{CHANNEL_ENV_LINES}}`, `{{CHANNEL_VOLUME_LINES}}`, `{{AGENT_HOOK_PROFILE}}`, `{{TMUX_SESSION_NAME}}`, `{{NETWORK_MODE_LINE}}`, plus the git-identity bind-mount handling.

Use the placeholder rules from Step 4 verbatim.

**Record docker template baselines in the manifest** (arms the `hermit-evolve` drift signals) via `manifest-seed.ts` — **do not hand-compute the hashes**. Read the current plugin version from `${CLAUDE_SKILL_DIR}/../../.claude-plugin/plugin.json`. Anchor the state-dir argv and the entrypoint file path to the **absolute project root** (verified in Step 1), not a cwd-relative path — cwd can drift after the `docker compose` / `tmux` calls earlier in this skill. Using `<PROJECT_ROOT>` for that absolute path, run `bun ${CLAUDE_PLUGIN_ROOT}/scripts/manifest-seed.ts <PROJECT_ROOT>/.claude-code-hermit` with this JSON on stdin:

```json
{
  "pluginVersion": "<version>",
  "entries": [
    { "key": "docker/docker-entrypoint.hermit.sh", "file": "<PROJECT_ROOT>/docker-entrypoint.hermit.sh" },
    { "key": "docker/docker-compose.hermit.yml.template", "file": "${CLAUDE_PLUGIN_ROOT}/state-templates/docker/docker-compose.hermit.yml.template" },
    { "key": "docker/Dockerfile.hermit.template", "file": "${CLAUDE_PLUGIN_ROOT}/state-templates/docker/Dockerfile.hermit.template" }
  ]
}
```

The **file each key hashes is deliberate**:
- `docker/docker-entrypoint.hermit.sh` hashes the **on-disk rendered** entrypoint at the project root — it is copied verbatim, so its hash equals the upstream template's. It is anchored to `<PROJECT_ROOT>` (absolute) so it resolves correctly regardless of the current working directory. This baseline lets `hermit-evolve` Step 5c manage the entrypoint as a boot-critical file (keep operator edits, refresh when upstream moves).
- The two `.template` keys hash the **upstream templates**, never the rendered output — they render with placeholder substitution, so rendered ≠ upstream forever. This lets `hermit-evolve` Step 10 report upstream drift (`status: changed`) without false positives from substitution.

The script preserves every other manifest key (the `templates/`/`bin/` baselines `hatch` seeded, sibling-hermit keys) and refuses to overwrite a present-but-corrupt manifest.

### 7c. Write Docker settings to config.json

**Pre-write gate for `docker.recommended_plugins`:** Re-run the step 7b.10 assertion on every entry. If any fails, do **not** write — return to step 7b.3 to re-resolve. This gate is the final backstop; do not bypass it even "just this once."

Write all collected Docker settings to config.json in a single update:
- `docker.network_mode` (from Step 2)
- `docker.packages` (from Step 7b.packages)
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

**Build and start:**

**Quick:** silently treat as `Yes — build now` and proceed directly to the build sub-section below. No prompt.

**Advanced:** ask with `AskUserQuestion` (header: "Deploy"): **Yes — build now** (run hermit-docker up immediately) / **No — manual** (print commands to run later).

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
   Screen 2 — Permission mode acknowledgement (appears for bypassPermissions AND auto; skip for acceptEdits/default/dontAsk):
     - bypassPermissions: arrow keys → "Yes, I accept" → Enter.
     - auto: "Enable auto mode?" → press 1 then Enter (persists in the named volume).

4. (Channels only) Pair each bot — DM it to get a 6-char code, then run
   (send text and Enter as two separate calls with a 0.5s pause — one-shot
   text+Enter is swallowed as bracketed paste):
   docker exec <container> tmux send-keys -t <session> \
     '/<plugin>:access pair <code> — save access.json to <project_path>/.claude.local/channels/<plugin>/ not ~/.claude'
   sleep 0.5
   docker exec <container> tmux send-keys -t <session> Enter
   docker exec <container> tmux send-keys -t <session> \
     '/<plugin>:access policy allowlist'
   sleep 0.5
   docker exec <container> tmux send-keys -t <session> Enter
   Verify access.json landed at: .claude.local/channels/<plugin>/access.json

5. Verify everything is healthy:
   .claude-code-hermit/bin/hermit-status

Re-run /claude-code-hermit:docker-setup any time you want guided help.
```

**If "Yes — build now":**
1. Pre-create all channel state directories on the host so Docker doesn't create them as root on first mount — if a bind-mount source doesn't exist, `docker compose up` creates it owned by root, making it unwritable by the `claude` user inside the container. For each configured channel run `mkdir -p .claude.local/channels/<plugin>`. Then run `mkdir -p .claude-code-hermit/state && touch .claude-code-hermit/state/.setup-mode` to put the container in setup mode (suppresses the bootstrap prompt so channel pairing commands land on an idle REPL, not a busy session turn). Then run `docker compose -f docker-compose.hermit.yml up -d --build` — builds and starts. Help fix errors (daemon not running, network, disk). Do **not** use `.claude-code-hermit/bin/hermit-docker up` here — its trailing echo prints attach/detach instructions that look like imperative commands and can mislead the LLM running this skill into executing them mid-setup. The final hand-off at step 9 provides the canonical attach guidance.
2. **Verify the container stayed running:** Poll `docker compose -f docker-compose.hermit.yml ps --status running --format '{{.Service}}'` every 2s for up to 10s. If the service appears — continue to the next sub-section. If it never appears after 10s, run `docker compose -f docker-compose.hermit.yml logs --tail=30 hermit` and show the output. Suggest a targeted fix based on the log:
   - **Daemon not running** → `docker info` errors → start Docker Desktop or `sudo systemctl start docker`, then re-run this skill
   - **Build failure** → read the build error line in the log above; fix the Dockerfile or missing dependency
   - **Missing `.env` var** → `docker compose -f docker-compose.hermit.yml config 2>&1 | grep -i error` names it
   - **Port conflict** → `ss -tlnp | grep <port>` finds what's using the published port
   **Do not continue to Login / Workspace trust / Channel pairing while the container is down — stop here and ask the operator to fix and re-run the skill.**

**Login (oauth only):** If operator chose oauth, proceed only once the container is confirmed running. Guide them through login:
1. Tell them: "The container is waiting for you to log in. Run this from another terminal:"
   ```
   .claude-code-hermit/bin/hermit-docker login
   ```
   This opens a claude REPL inside the container. Type `/login`, follow the URL in a browser, then paste the code back when prompted. Type `/exit` when done — the hermit starts automatically.
2. Ask with `AskUserQuestion` (header: `"Login"`) — `"Done — login succeeded"` / `"Failed — couldn't complete login"`. Do **not** poll logs in a loop. Do **not** rebuild or restart the container. `hermit-docker login` already verifies `.credentials.json` and exits non-zero if absent, so a "Done" answer means creds are present.
3. On `"Failed"`: run `docker compose -f docker-compose.hermit.yml logs --tail=30 hermit` and show output. Suggest the targeted fix:
   - **OAuth URL unreachable** → copy the URL from the log and open it manually in a browser
   - **Code expired / rejected** → re-run `hermit-docker login` (codes expire in ~10 min)
   - **Credentials not written** → `docker compose exec -T hermit ls /home/claude/.claude/.credentials.json` (should exist after login); missing = named volume not mounted — check `docker-compose.hermit.yml` volume entry
   Then **stop** — operator re-runs `/claude-code-hermit:docker-setup` after resolving the issue.

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
> **Screen 2 — Permission mode acknowledgement** (only if `permission_mode` is `bypassPermissions` OR `auto`):
> - If `bypassPermissions`: you'll see the `--dangerously-skip-permissions` acknowledgement. Use the **arrow keys** to select **"Yes, I accept"**, then press **Enter**.
> - If `auto`: you'll see "Enable auto mode?" with three options. Press **1** then **Enter** ("Yes, and make it my default mode") so the acknowledgement persists in the named volume and won't re-prompt on future restarts.
>
> After accepting, you'll see a **blank claude prompt** — that's expected during setup. The skill will send pair commands from here; don't type `/session` yourself.
>
> Then press **Ctrl+B, D** to detach.

Read `config.permission_mode` from `.claude-code-hermit/config.json`. If it is NOT `bypassPermissions` AND NOT `auto`, omit the "Screen 2" paragraph entirely. Otherwise emit it, and inside the paragraph keep only the branch matching the resolved mode (drop the other bullet).

Wait for the operator to confirm they have detached before continuing.

**Channel pairing** (skip if no channels or no tokens configured):

Before pairing, confirm the operator has completed the first-run acceptance step above — if they haven't, `tmux send-keys` commands will be swallowed by the consent screen and appear to do nothing.

Confirm the tmux session still exists (reuse the `has-session` check from the acceptance step). If it's gone, surface container logs and stop.

For each channel, **first verify the token is configured** — check that `.claude.local/channels/<plugin>/.env` exists and contains the expected `*_BOT_TOKEN` var. If missing, skip pairing for this channel and tell the operator: "No token configured for `<channel>` — write it to `.claude.local/channels/<plugin>/.env`, restart the container, then re-run `/claude-code-hermit:docker-setup` to pair." Move to the next channel.

If the token is present, ask if already paired. If not:
1. Ask with `AskUserQuestion` (header: `"<channel> pairing"`) — `"I have the code"` / `"Skip this channel"`. On `"I have the code"`: ask for the 6-char code via `Other` (header: `"Bot code"`).
2. Send pair command into tmux — append the local state dir so the LLM writes there instead of the default user path. Send text and `Enter` as **two separate `send-keys` calls** with a `sleep 0.5` between them — Claude Code's TUI treats text+Enter in one burst as bracketed paste and turns `Enter` into a literal newline instead of submit (same fix as `scripts/hermit-start.ts:611-617`):
   ```
   docker compose -f docker-compose.hermit.yml exec -T hermit \
     tmux send-keys -t <session> '/<plugin>:access pair <code> — save access.json to <project_path>/.claude.local/channels/<plugin>/ not ~/.claude'
   sleep 0.5
   docker compose -f docker-compose.hermit.yml exec -T hermit \
     tmux send-keys -t <session> Enter
   ```
3. Set policy (same two-call pattern):
   ```
   docker compose -f docker-compose.hermit.yml exec -T hermit tmux send-keys -t <session> '/<plugin>:access policy allowlist'
   sleep 0.5
   docker compose -f docker-compose.hermit.yml exec -T hermit tmux send-keys -t <session> Enter
   ```
4. Ask with `AskUserQuestion` (header: `"Pair result"`) — `"Bot confirmed paired"` / `"No response"`. On `"No response"`: run `docker compose exec -T hermit tmux capture-pane -t <session> -p`, show output, and skip `access.json` verification for this channel — don't fail the whole setup.
5. **Verify `access.json` landed in the right place** (only on `"Bot confirmed paired"`): Check `.claude.local/channels/<plugin>/access.json`. If absent, run `docker compose exec -T hermit tmux capture-pane -t <session> -p` and show output. If it landed in `~/.claude/channels/<plugin>/` instead, move it:
   ```
   docker compose exec -T hermit bash -c 'src="${CLAUDE_CONFIG_DIR:-/home/claude/.claude}/channels/<plugin>/access.json"; dst="<project_path>/.claude.local/channels/<plugin>/"; [ -f "$src" ] && mkdir -p "$dst" && mv "$src" "$dst" && echo moved'
   ```
6. **Default delivery settings** (skip if `"Already paired"` was chosen or pairing was skipped this run):
   1. Use the `Read` tool on `<project_path>/.claude.local/channels/<plugin>/access.json` (host file). If `ackReaction` is already non-empty, skip — preserve operator customization.
   2. Otherwise use the `Edit` tool to set the `ackReaction` value to `"👀"` while preserving every other key in the file unchanged (read-modify-write a single field — do NOT overwrite the file with a fresh object). The bind-mount makes the change visible inside the container immediately — no tmux round-trip, no LLM turn, no race with the Step 8b shutdown.
   3. Idempotent: re-running docker-setup leaves customized values alone (sub-step 1 short-circuits when `ackReaction` is non-empty).
7. **Server channel / group chat (optional)** (run even if `"Already paired"` was chosen; skip only if `imessage`, if `"Skip this channel"` was chosen, or if pairing returned `"No response"`):
   1. Ask with `AskUserQuestion` — label and prompt vary by channel:
      - `discord`: header `"Server channel"` — "Want the hermit to also listen in a Discord server channel? Channel ID: enable Developer Mode in Discord settings → right-click the channel → Copy Channel ID."
      - `telegram`: header `"Group chat"` — "Want the hermit to also listen in a Telegram group? Group ID: forward a message from the group to `@userinfobot` or use `@RawDataBot`. Group IDs are negative integers (e.g. `-1001234567890`)."
      - Options: `"Yes — add a channel"` (discord) / `"Yes — add a group"` (telegram) with ID captured via `Other`; `"Skip — DMs only"`.
   2. If **Skip**: continue to sub-step 8.
   3. **For each ID provided** (the first ID comes from step 1's `Other`; each subsequent ID from step 3d's `Other` — loop until "Done"):
      a. Ask with `AskUserQuestion` (header: `"Mention required"`) for this ID:
         - `"Yes — require @mention"` (default — safer for noisy channels)
         - `"No — respond to all messages"`
      b. Send `group add` into tmux using the **same two-call send-keys pattern** as sub-step 2 (text, `sleep 0.5`, `Enter`):
         - With `"Yes — require @mention"`:
           ```
           docker compose -f docker-compose.hermit.yml exec -T hermit \
             tmux send-keys -t <session> '/<plugin>:access group add <channelId> — save access.json to <project_path>/.claude.local/channels/<plugin>/ not ~/.claude'
           sleep 0.5
           docker compose -f docker-compose.hermit.yml exec -T hermit \
             tmux send-keys -t <session> Enter
           ```
         - With `"No — respond to all messages"`: same but with `--no-mention` appended before the ` —` hint.
      c. Confirm (text only): "Sent `group add` for `<channelId>`. Will verify after all channels are added."
      d. Ask with `AskUserQuestion` (header: `"Add another?"`) — `"Yes — add another"` with the next ID via `Other`; `"Done — continue"`. On `"Done — continue"`: exit the loop.
   4. **Verify all added channels** (one `Read` after the loop): open `<project_path>/.claude.local/channels/<plugin>/access.json`. For each ID added in step 3, confirm `groups.<channelId>` is present with the expected `requireMention` value. For any missing: run `docker compose exec -T hermit tmux capture-pane -t <session> -p`, surface the output, and warn — do not fail the whole setup. Then proceed to sub-step 8.
8. Confirm: "Paired and locked down. If the bot doesn't respond to your first message, give it up to 2 minutes — the hermit may still be booting or running initial checks (plugin installs, workspace trust, auto-memory seeding)."

If "skip": tell them to DM the bot later and run the commands manually.

### 8b. Finalize — clean restart

**Skip this step entirely if the operator chose "No — manual" at step 8.** The container isn't running, so there's nothing to restart.

Tell the operator (set expectations — this step takes ~30-60s and otherwise looks like a hang):

> "Finalizing setup with a clean restart so the first real hermit session starts with everything configured and plugins fully loaded."

Then run, in sequence:

1. `.claude-code-hermit/bin/hermit-docker down` — sends `/session-close --shutdown` via tmux and polls for graceful close up to 60s before removing the container. If it prints "Timed out waiting for graceful close; forcing stop", flag it in the final summary (session that witnessed setup didn't close cleanly — not blocking but worth noting).

2. `docker compose -f docker-compose.hermit.yml up -d` — recreates the container. Do **not** use `hermit-docker up` here for the same LLM-misleading-echo reason as step 8. Docker's named volume preserves credentials, plugins, workspace trust. Bind-mounts preserve `.claude.local/channels/<plugin>/access.json` and `.claude-code-hermit/`.

3. Re-verify the container stayed running (same poll as step 8.2). If it failed to come back up, run `docker compose -f docker-compose.hermit.yml logs --tail=30 hermit`, show the output, and apply the same targeted hints as step 8.2 (daemon down, build failure, port conflict). Stop — don't proceed to step 9.

Why this step exists: mid-setup, claude REPL starts before plugins are fully enabled and channel pairing completes. The session it was running is a "bootstrap session" full of setup chatter. A clean restart gives the operator a first *real* session with correctly-loaded plugins, fresh tmux state, and no config-time noise.

Why not `hermit-docker restart`: Docker's default stop_grace_period is 10s, which is shorter than the entrypoint's 30-iteration session-close poll — SIGKILL can land mid-close. (We raised `stop_grace_period` to 60s in the compose template, so `restart` is now also safe in principle, but `down+up` gives a recreated container which is stronger: clears ephemeral container-layer state and re-runs the entrypoint from a clean slate.)

### 9. Verify

**Enable the Docker watchdog.** Docker hermits run the watchdog from the entrypoint loop, so turn it on now:

```
jq '.watchdog.enabled = true' .claude-code-hermit/config.json > .claude-code-hermit/config.json.tmp \
  && mv .claude-code-hermit/config.json.tmp .claude-code-hermit/config.json
```

This only flips `.watchdog.enabled` — the other watchdog tuning keys (`stale_factor`, `escalate_after`, `operator_grace`) are preserved.

Run `.claude-code-hermit/bin/hermit-status` and show output. `no session` is the expected output on a fresh setup — it means the container is up and will start its first session on the next cron routine or channel message. Do **not** add `sleep` before `hermit-status`; if you need to wait for a session to appear, use `Monitor` with an `until`-loop (not chained sleeps).

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
  .claude-code-hermit/bin/hermit-docker update    — rebuild image + update plugins (durable pin move) + auto-evolve
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

**Domain-plugin apt dependencies.** Declare system packages your plugin needs in a `## Docker apt dependencies` section in the plugin's hatch SKILL.md or a `DOCKER.md` at the plugin root. See step 7b.packages and [Creating Your Own Hermit — Docker dependencies](../../docs/creating-your-own-hermit.md#docker-dependencies).

**Why the three hardening stanzas (`no-new-privileges`, `cap_drop`, `pids_limit`)?** The container may run with `bypassPermissions` (or the default `auto` mode), and the recommended-plugins flow accepts third-party marketplaces — defense in depth matters here. The load-bearing one is `no-new-privileges:true` — it blocks setuid escalation at the kernel level, which is a real vector against future supply-chain compromise of any installed plugin. `cap_drop: ALL` is incremental: the container already runs as non-root `claude` so most caps were already unreachable, but dropping them explicitly closes the kernel-enforced ceiling. `pids_limit: 2048` is a resource bound, not a security primitive — it caps fork-bomb-style payloads with comfortable headroom over hermit's ~80 PID steady state. Hermit's runtime needs none of what's removed (verified across tmux, claude CLI, bun, jq, npm, git+HTTPS plugin installs). Operators extending the container with services on privileged ports (<1024), setuid helpers, or high-PID workloads must relax the relevant stanza explicitly. See [Security — Container Hardening](../../docs/security.md#container-hardening) for the full rationale.

**Want stronger isolation?** v1.0.26 ships an opt-in advanced wizard, `/claude-code-hermit:docker-security`, that adds LAN containment with DNS policy (firewall + DNS sidecar with port-53 redirect for actual enforcement), read-only root filesystem with smoke test, resource bounds with kernel hygiene sysctls, and a boot-time plugin-install audit log. Each toggle is opt-in with honest cost/benefit framing, runs verification against the live container, and is fully reversible. **Note:** the LAN containment toggle is hard-skipped when `docker.network_mode: "host"` is in use — bridge networking required. See [Docker Security](../../docs/docker-security.md).
