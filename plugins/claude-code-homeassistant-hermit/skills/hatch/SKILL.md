---
name: hatch
description: One-time Home Assistant setup for this hermit. Configures HA access, connects to the official Home Assistant MCP Server integration, and verifies both the Python CLI and HA MCP. Run once per project after /claude-code-hermit:hatch.
---

# Home Assistant Hatch

Set up the Home Assistant layer for this project. Idempotent — safe to re-run; will skip completed steps and offer re-verify only.

## Plan

### 1. Prereq check

Read `.claude-code-hermit/config.json`.

- If the file is missing or `_hermit_versions["claude-code-hermit"]` is absent or less than `1.0.16`:
  - `AskUserQuestion`: "Core hermit is not initialized. Run `/claude-code-hermit:hatch` now?"
  - Yes → invoke `/claude-code-hermit:hatch`, then continue.
  - No → stop and explain what is required.

### 2. Idempotency check

Read `_hermit_versions["claude-code-homeassistant-hermit"]` from `config.json`. Read the `version` field from `${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json`.

- If versions match → `AskUserQuestion`: "Already set up. Re-verify HA access only (skip setup wizard)?". Yes → skip to §6. No → continue.
- If stale or absent → continue with setup.

### 3. Verify .env

Run `${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab boot status` and inspect the JSON output.

> **Important**: do NOT use `grep`, `cat`, or `echo` on `.env` — the deny-pattern hook blocks any Bash command whose arguments contain the literal string `TOKEN`. Always use the CLI to check credential state.

- `token_configured: true` and `local_url` non-null → proceed.
- **If either is missing**:
  1. Tell the user:
     ```
     .env is missing or incomplete. Please create `.env` at the project root with:

       HOMEASSISTANT_URL=http://homeassistant.local:8123   # or your remote URL
       HOMEASSISTANT_TOKEN=<your long-lived access token>

     Long-Lived Access Tokens: Home Assistant → Profile → Long-Lived Access Tokens.
     ```
  2. `AskUserQuestion`: "When your `.env` is ready, type **done** to continue (or **abort** to stop)."
     - **done** → re-run `boot status` and re-check. If still missing, repeat from step 1. If valid, proceed.
     - **abort** → stop.
  Do not write or modify `.env` — it is the user's responsibility.

Also check locale:

- Read `.claude-code-hermit/OPERATOR.md`. If a `## HA hermit` section has a `- Language:` entry, use it silently — do not re-ask.
- If absent, ask: **Language / locale**: What language should the agent use for HA-facing output? (e.g. `en`, `pt`, `es`) Save it via `${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab boot store --language <locale>` (writes to OPERATOR.md under `## HA hermit`).

Do not collect or store the token — it stays in `.env` only.

### 4. Python runtime deps + CLI check

Run `python3 -c "import yaml, dotenv"` (or `.venv/bin/python -c "import yaml, dotenv"` if `.venv/` exists).

- **If it passes** → skip to the CLI status check below.
- **If it fails**:
  1. Probe `python3 -m venv --help`. If that fails, stop and tell the user: `apt install python3-venv` (or OS equivalent), then re-run hatch.
  2. `AskUserQuestion`: "Install Python deps into a project-local `.venv`? Recommended — isolates from system Python and works on PEP 668 hosts." Options: `venv` (default) / `system` / `skip`.
     - **`venv`**: run `python3 -m venv ${CLAUDE_PLUGIN_ROOT}/.venv` then `${CLAUDE_PLUGIN_ROOT}/.venv/bin/pip install PyYAML python-dotenv`. Re-probe — if still failing, stop with a diagnostic.
     - **`system`**: run `pip install --user PyYAML python-dotenv`. If it errors with `externally-managed-environment` (PEP 668), offer to fall back to `venv` automatically.
     - **`skip`**: note that §6 will probe again and will fail if deps are absent; continue anyway.
  3. **Do not exit or ask the user to re-run the skill** — continue to the CLI status check in-flight.

CLI check: run `${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab boot status` (read-only, no `--probe`) to confirm the launcher and Python package resolve correctly.

### 5. Home Assistant MCP Server setup

**Step A — Enable the integration in Home Assistant**

Tell the user: go to Home Assistant → Settings → Devices & Services → Add Integration → search "Model Context Protocol Server". Enable it. This exposes the MCP endpoint at `<your HA URL>/api/mcp`.

Reference: https://www.home-assistant.io/integrations/mcp_server/

**Step B — Write `.mcp.json`**

Read the HA URL from the `boot status` JSON (`active_url` field, already fetched in §3). Read the token from `.env` using:

```bash
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab boot status
```

For the token value, use the **Read** tool on `.env` (not Bash — the deny-pattern hook blocks any Bash argument containing the literal string `TOKEN`, including via `python -c`). Parse the `HOMEASSISTANT_TOKEN=...` line in-memory and use the value directly when writing `.mcp.json`. Do not echo the token to the conversation or log it.

Check the project root for `.mcp.json`:
- If absent → write it with literal values substituted.
- If present → read it and check the `homeassistant` entry:
  - If absent → merge it in with literal values.
  - If present **and** the `url` or `Authorization` value contains `${` (old placeholder format) → rewrite that entry with literal values and tell the user the stale entry was replaced.
  - If present and already contains literal values → skip.

```json
{
  "mcpServers": {
    "homeassistant": {
      "type": "http",
      "url": "<HOMEASSISTANT_URL>/api/mcp",
      "headers": { "Authorization": "Bearer <HOMEASSISTANT_TOKEN>" }
    }
  }
}
```

Replace `<HOMEASSISTANT_URL>` with the `active_url` from `boot status` (resolves to `HOMEASSISTANT_URL`, or `HOMEASSISTANT_LOCAL_URL` for existing installs) and `<HOMEASSISTANT_TOKEN>` with the literal values read above.

The name `homeassistant` is required — skills and the safety hook match on `mcp__homeassistant__*` tool IDs.

> **Note**: `.mcp.json` now contains a live bearer token. Claude Code reads MCP env vars from the process environment, **not** from `.env`, so literal values are required here.

After writing `.mcp.json`, check the project's `.gitignore`:
- If `.mcp.json` is absent from it → append `.mcp.json` on a new line.
- If already present → skip.

**Step C — Activate and verify**

Tell the user: **restart Claude Code** in this project directory. On first use, Claude Code will prompt you to trust the `homeassistant` server — approve it. Then run `/mcp` to confirm `homeassistant` appears as connected. The next `ha-boot` will verify live HA connectivity.

### 6. Verify Python CLI (full probe)

Run `${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab boot status --probe` and present the result. If it fails:

- Missing deps → repeat the §4 venv install steps inline (create `.venv`, pip install) without exiting or re-invoking hatch.
- Connection refused → check `HOMEASSISTANT_LOCAL_URL` in `.env`.
- Auth error → check `HOMEASSISTANT_TOKEN`.

### 7. Append to CLAUDE.md / CLAUDE.local.md

**Resolve target file:** Read `.claude-code-hermit/state/hatch-options.json`. Use the `"target"` field:
- `"local"` → `target_file = CLAUDE.local.md`
- `"committed"` or absent → `target_file = CLAUDE.md`
- If the file doesn't exist (no `hatch-options.json` yet — operator's core hermit predates 1.1.1): detect `core_install_scope` from `claude plugin list --json` using the same precedence rules as core hatch Step 1.5 item 2 (filter entries where plugin name is `claude-code-hermit` and `enabled == true`; precedence `local` > `project` (both require `projectPath == project root`) > `user` (any `projectPath`) > `null`; map `project` → `committed`, `local`/`user`/`null` → `local`). Ask with `AskUserQuestion` (header: "Visibility") — scope-derived default at position 0 with `(recommended)`: **`.local` files** (gitignored — operator-personal) / **Committed files** (shared with teammates). Write the canonical 5-field schema to `.claude-code-hermit/state/hatch-options.json`:

  ```json
  {
    "target": "<choice>",
    "core_install_scope": "<project|local|user|null>",
    "stamped_at": "<current ISO 8601 timestamp with timezone offset>",
    "stamped_by": "claude-code-homeassistant-hermit:hatch",
    "version": "<current ha-hermit plugin version from ${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json>"
  }
  ```

Read the plugin version from `${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json` and the stamped version from `.claude-code-hermit/config.json` at `_hermit_versions["claude-code-homeassistant-hermit"]` (treat absent as `null`). Step 8 of this skill stamps that field at the end of every run, so on re-runs it reflects the version that last wrote the block. Look for the marker `<!-- claude-code-homeassistant-hermit: Home Assistant Workflow -->` in `target_file`:

- **Marker present AND stamped version equals plugin version:** skip — block is current. Do not read the template.
- **All other cases** (marker absent, stamped version null, OR stamped version stale): read `${CLAUDE_PLUGIN_ROOT}/state-templates/CLAUDE-APPEND.md` and either append it to `target_file` (marker absent — the Edit tool creates `target_file` if missing) or replace the marked block (marker present) — everything from the opening `<!-- claude-code-homeassistant-hermit: Home Assistant Workflow -->` through the matching closing `<!-- /claude-code-homeassistant-hermit: Home Assistant Workflow -->`, inclusive. The template is the source of truth; no operator prompt is needed.

Stray-block migration (block stranded in the non-target file after a target flip) is handled one-shot by the Upgrade Instructions in this version's CHANGELOG entry, executed by `hermit-evolve` Step 7. Hatch itself stays focused on target-aware setup and steady-state refresh.

### 7.5 Safety mode

Read `ha_safety_mode` from `.claude-code-hermit/config.json`.

- **If the key is already set**: `AskUserQuestion`: "Current safety mode is `<value>`. Change it?" Yes → re-prompt. No → skip this step.
- **If absent**: ask the operator which safety mode to use for sensitive domains (`lock`, `alarm_control_panel`, security-related `cover`/`button`/`switch`):
  - `strict` (recommended) — always block autonomous actuation; work goes through a proposal instead.
  - `ask` — operator is prompted before any actuation of a sensitive entity. Build/validate normally; both YAML apply and direct MCP calls require an explicit operator confirmation before execution.

Write the chosen value to `config.json` as `ha_safety_mode`. Default to `strict` if the operator skips or is unsure.

### 8. Stamp version and register routines

Write `_hermit_versions["claude-code-homeassistant-hermit"]` into `.claude-code-hermit/config.json` with the current plugin version.

**Compiled templates**: Copy `${CLAUDE_PLUGIN_ROOT}/state-templates/compiled/acknowledged-violations.md` to `.claude-code-hermit/compiled/acknowledged-violations.md` if that file does not already exist. Set `created` in the frontmatter to today's ISO date. This gives the operator a ready-to-use suppression list for the safety audit.

**Boot skill registration**: Read `config.boot_skill` from `config.json`.

The skill name format is `/<plugin-id>:<skill-id>`. Parse the plugin-id as the text between `/` and `:`.

- If `null` or absent → set it to `/claude-code-homeassistant-hermit:ha-boot`.
- If the value starts with `/claude-code-homeassistant-hermit:` → no-op (report "already set").
- Otherwise (another plugin's namespace) → leave it unchanged and warn: "boot_skill is already set to `<value>` from another plugin — skipping to avoid conflict. Run `/claude-code-hermit:hermit-settings boot-skill` to update it manually."

**HA routine registration**: `config.routines` is an array of objects with `{id, schedule, skill, enabled, run_during_waiting}`. For each HA routine below, check whether an entry with that `id` already exists in the array. If it does, skip. If not, prompt and merge it in.

1. **Context refresh** — "Add daily HA context-refresh routine (08:30 every day)? Keeps entity snapshots fresh automatically."
   ```json
   {"id": "daily-ha-context", "schedule": "30 8 * * *", "skill": "claude-code-homeassistant-hermit:ha-refresh-context", "enabled": true, "run_during_waiting": false}
   ```

2. **Morning brief** — three paths based on the current `config.routines` state:

   **Fresh install** (no entry with `id: "morning-brief"` exists): prompt — "Add morning house brief routine? Delivers a unified morning summary combining house state and hermit context."
   - If yes: follow-up — "Use unified mode (08:30, fires in waiting state, replaces core `morning` routine)? Recommended for always-on setups."
     - Unified yes: merge `{"id": "morning-brief", "schedule": "30 8 * * *", "skill": "claude-code-homeassistant-hermit:ha-morning-brief", "enabled": true, "run_during_waiting": true}`. If `config.routines` contains an entry with `id: "morning"` and `enabled: true`, set its `enabled` to `false` and emit: "Disabled core `morning` routine — `morning-brief` subsumes it."
     - Unified no (legacy): merge `{"id": "morning-brief", "schedule": "0 9 * * *", "skill": "claude-code-homeassistant-hermit:ha-morning-brief", "enabled": false, "run_during_waiting": false}`.
   - If no: skip.

   **Re-hatch upgrade** (entry with `id: "morning-brief"` exists but has `schedule: "0 9 * * *"` OR `run_during_waiting: false`): prompt — "Your `morning-brief` routine uses the old schedule (09:00, not firing during waiting). Upgrade to unified mode (08:30, always-on)?"
   - If yes: update in-place to `schedule: "30 8 * * *"`, `enabled: true`, `run_during_waiting: true`. Then disable core `morning` if present and enabled (same logic as fresh install unified path).
   - If no: leave unchanged.

   **Already current** (entry exists with `schedule: "30 8 * * *"` and `run_during_waiting: true`): skip (no-op, report "config is current — check `enabled` flag if the routine isn't firing").

   **Non-standard config** (entry exists but matches none of the above conditions — e.g. custom schedule): skip (no-op, report "non-standard `morning-brief` config detected — skipping upgrade prompt").

3. **Evening brief** — "Add evening house-check routine (22:30 every day)? Delivers a brief end-of-day security and device confirmation."
   - If yes: merge `{"id": "evening-brief", "schedule": "30 22 * * *", "skill": "claude-code-homeassistant-hermit:ha-evening-brief", "enabled": true, "run_during_waiting": true}`. If `config.routines` contains an entry with `id: "evening"` and `enabled: true`, set its `enabled` to `false` and emit: "Disabled core `evening` routine — `evening-brief` subsumes it."
   - If no: skip.

After adding or updating any entries, remind the operator: "Run `/claude-code-hermit:hermit-routines load` to activate routines in the current session."

**Scheduled checks registration**: `config.scheduled_checks` is an array of periodic skill entries that the `scheduled-checks` routine (via `reflect-scheduled-checks`) invokes on a cadence and funnels through the proposal pipeline. For each entry below, check whether an existing record has the same `id`. If not, append it — no prompt needed, all three are safe read-only analyses.

```json
{"id": "ha-patterns",            "plugin": "claude-code-homeassistant-hermit", "skill": "claude-code-homeassistant-hermit:ha-analyze-patterns",        "enabled": true, "trigger": "interval", "interval_days": 7}
{"id": "ha-safety-audit",        "plugin": "claude-code-homeassistant-hermit", "skill": "claude-code-homeassistant-hermit:ha-safety-audit",           "enabled": true, "trigger": "interval", "interval_days": 7}
{"id": "ha-integration-health",  "plugin": "claude-code-homeassistant-hermit", "skill": "claude-code-homeassistant-hermit:ha-integration-health",    "enabled": true, "trigger": "interval", "interval_days": 1}
```

These replace any need for CronCreate routines around analysis/observability — the `scheduled-checks` routine picks up whichever check is due, runs it, and any findings surface as proposals automatically.

## Docker apt dependencies

- python3-yaml
- python3-dotenv

### 9. Final report

Summarize:

```
hatch complete
  ✓  .env verified (user-managed)
  ✓  Python deps: <venv at .venv/ | system python> → OK / FAILED
  ✓  Python CLI: bin/ha-agent-lab boot status --probe → OK / FAILED
  ✓  .mcp.json: homeassistant entry written / already present
  ✓  CLAUDE.md updated
  ✓  config.json stamped v<version>
  ✓  boot_skill: /claude-code-homeassistant-hermit:ha-boot (set | already set | operator override preserved)
  ✓  Routines registered: daily-ha-context, morning-brief (disabled by default), evening-brief
  ✓  Scheduled checks registered: ha-patterns, ha-safety-audit, ha-integration-health

Manual steps remaining:
  - Enable 'Model Context Protocol Server' integration in Home Assistant (if not done)
    Settings → Devices & Services → Add Integration → search "MCP"
  - Restart Claude Code and approve the 'homeassistant' server on first use
  - Run /mcp to confirm 'homeassistant' is connected

Go always-on (recommended):
  - Docker:     /claude-code-hermit:docker-setup
      Builds the container and walks you through channel pairing in one go.
  - Bare tmux:  .claude-code-hermit/bin/hermit-start
      For channels (Discord/Telegram) with tmux, run
      /claude-code-hermit:channel-setup first.

Prefer to test interactively first?
  1. /claude-code-homeassistant-hermit:ha-boot
       — single entry point: starts the hermit session, probes HA,
         and auto-refreshes the context snapshot if stale/missing.
  2. /claude-code-hermit:hermit-routines load
       — activates scheduled routines in the current Claude session.

The always-on runtime does both of these automatically — the interactive
steps are only for a test drive before handing over to the runtime.
```

---

## Docker network requirements

Read by `/claude-code-hermit:docker-security` when the operator enables LAN containment + DNS policy. Each entry is surfaced as a per-entry confirmation prompt; nothing here is auto-applied.

### Domains (DNS allowlist)

- nabu.casa
- home-assistant.io
- READ_FROM_ENV:HOMEASSISTANT_URL

### LAN allowlist suggestions

- ASK_OPERATOR_FOR_HA_IP

The `nabu.casa` entry covers Nabu Casa Cloud (`<id>.ui.nabu.casa`) since dnsmasq's `server=/nabu.casa/...` pattern matches subdomains. `home-assistant.io` covers integration docs (`www.home-assistant.io`) and the developer API reference (`developers.home-assistant.io`) that skills consult when verifying REST/WebSocket endpoints. `READ_FROM_ENV:HOMEASSISTANT_URL` resolves to the hostname of the operator's configured HA instance — covers custom remote domains (e.g. `ha.mydomain.com`) that are not under `nabu.casa`. Operators on a self-hosted local HA instance should accept `ASK_OPERATOR_FOR_HA_IP` and provide the LAN IP of their HA box. mDNS / `homeassistant.local` does not work through dnsmasq — use the IP directly.
