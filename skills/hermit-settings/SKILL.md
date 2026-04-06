---
name: hermit-settings
description: View or change hermit configuration for this project. Manages model, channels, budget prompts, morning brief, heartbeat, routines, idle behavior, compaction thresholds, Docker packages, and unattended mode.
disable-model-invocation: true
---
# Hermit Settings

View or modify the hermit configuration for this project.

## Usage

```
/claude-code-hermit:hermit-settings              — show all current settings
/claude-code-hermit:hermit-settings name          — set agent name
/claude-code-hermit:hermit-settings language       — set preferred language
/claude-code-hermit:hermit-settings timezone       — set timezone
/claude-code-hermit:hermit-settings escalation     — set escalation threshold
/claude-code-hermit:hermit-settings sign-off       — set sign-off line
/claude-code-hermit:hermit-settings channels       — configure channels
/claude-code-hermit:hermit-settings remote          — toggle remote control
/claude-code-hermit:hermit-settings model           — set Claude model
/claude-code-hermit:hermit-settings budget         — toggle budget prompting
/claude-code-hermit:hermit-settings brief          — configure morning brief
/claude-code-hermit:hermit-settings permissions    — configure unattended mode
/claude-code-hermit:hermit-settings heartbeat      — enable/disable, interval, quiet mode, active hours
/claude-code-hermit:hermit-settings routines        — manage scheduled routines (add/edit/remove/enable/disable)
/claude-code-hermit:hermit-settings idle             — set idle behavior (wait or discover)
/claude-code-hermit:hermit-settings env              — view/edit environment variables
/claude-code-hermit:hermit-settings compact          — configure SHELL.md compaction thresholds
/claude-code-hermit:hermit-settings docker           — view/edit Docker packages
/claude-code-hermit:hermit-settings plugin-checks    — manage scheduled plugin skill checks
```

## Plan

### 1. Read config

Read `.claude-code-hermit/config.json`. If it doesn't exist, inform the operator: "No config found. Run `/claude-code-hermit:hatch` first."

### 2. Show or modify

**If no argument** (or argument is "all"):
Display all current settings in a readable format:

```
Hermit Settings (.claude-code-hermit/config.json)

Identity:
  Agent name:      Atlas (agent_name: "Atlas")
  Language:        pt (language: "pt")
  Timezone:        Europe/Lisbon (timezone: "Europe/Lisbon")
  Escalation:      balanced (escalation: "balanced")
  Sign-off:        Atlas out. (sign_off: "Atlas out.")

Operational:
  Channels:        none
  Remote control:  disabled (remote: false)
  Model:           default (model: null)
  Budget prompts:  disabled (ask_budget: false)
  Morning brief:   disabled
  Idle behavior:   discover (idle_behavior: "discover")
  Idle budget:     $0.50 (idle_budget: "$0.50")
  Heartbeat:       disabled (every: 30m, show_ok: false, active: 08:00-23:00, stale: 2h)
  Routines:        2 configured (morning 08:30, evening 22:30)
  Permission mode:  acceptEdits (permission_mode: "acceptEdits")
  Auto session:    enabled (auto_session: true)
  tmux name:       hermit-myproject

Compaction:
  Monitoring:      compact at 30 lines, keep 20 (compact.monitoring_threshold/keep)
  Session Summary: compact at 30 lines, keep 15 (compact.summary_threshold/keep)

Environment (env):
  AGENT_HOOK_PROFILE              standard
  COMPACT_THRESHOLD               50
  CLAUDE_AUTOCOMPACT_PCT_OVERRIDE 50
  MAX_THINKING_TOKENS             10000

Plugin Checks:
  automation-recommender  claude-code-setup     interval  7 days   2026-04-01  enabled
  md-audit                claude-md-management  interval  7 days   (never)     enabled
  md-revise               claude-md-management  session   —        2026-04-06  enabled

Docker:
  Packages:          build-essential, ffmpeg (or "none")
```

**If argument is "name":**
Ask: "Agent name? (e.g., Atlas, Hermit, Scout, or 'none' to clear) [current value or skip]"
Update `agent_name` in config.json. Set to `null` if operator says "none" or "clear".

**If argument is "language":**
Auto-detect the system locale via Bash as a default suggestion.
Ask: "Preferred language? (e.g., pt, en, es, fr) [current value or auto-detected]"
Update `language` in config.json.

**If argument is "timezone":**
Auto-detect the system timezone via Bash as a default suggestion.
Ask: "Timezone? (e.g., Europe/Lisbon, America/New_York, UTC) [current value or auto-detected]"
Update `timezone` in config.json.

**If argument is "escalation":**
Ask: "How autonomous should your assistant be?
  1. Conservative — ask before most non-trivial actions, create proposals instead of fixing directly
  2. Balanced — act on routine tasks, ask for significant changes (default)
  3. Autonomous — proceed unless blocked, minimize interruptions

Choose 1-3: [current value]"
Update `escalation` in config.json with `"conservative"` / `"balanced"` / `"autonomous"`.

**If argument is "sign-off":**
Ask: "Sign-off line for channel messages and briefs? (e.g., 'Atlas out.', '— A.', or 'none' to clear) [current value or skip]"
Update `sign_off` in config.json. Set to `null` if operator says "none" or "clear".

**If argument is "channels":**
Ask: "Configure channels for this project? (telegram / discord / none) [current value]"
Update `channels` array in config.json. Store short names (e.g., `"discord"`); the boot script maps them to full plugin identifiers.
Note: "Channel changes take effect on next `hermit-start` run."

**If argument is "remote":**
Ask: "Enable remote control? Connect from a browser or phone via claude.ai/code. (yes / no) [current value]"
Update `remote` in config.json.
Note: "Remote control changes take effect on next `hermit-start` run."

**If argument is "model":**
Ask: "Claude model to use? (e.g., opus, sonnet, haiku, claude-sonnet-4-5-20250514, or 'none' for default) [current value or default]"
Update `model` in config.json. Set to `null` if operator says "none", "default", or "clear".
Note: "Model changes take effect on next `hermit-start` run."

**If argument is "budget":**
Ask: "Ask for a cost budget at session start? (always / never) [current value]"
Update `ask_budget` in config.json.

**If argument is "brief":**
- If no channels configured: "Morning brief requires channels. Configure channels first with `/claude-code-hermit:hermit-settings channels`."
- If channels configured:
  - Ask: "Enable morning brief delivery? (yes / no) [current value]"
  - If yes: Ask "What time? (e.g., 07:00) [current or 07:00]" and "Which channel? [current or first configured]"
  - Update `morning_brief` in config.json.

**If argument is "permissions":**
Ask: "Permission mode for Claude Code? (default / acceptEdits / plan / dontAsk / bypassPermissions) [current value]"
- `default` — prompts for permission on first use of each tool
- `acceptEdits` — auto-approves file edits, prompts for shell commands (default)
- `plan` — read-only exploration, no file modifications or shell commands
- `dontAsk` — denies all tools not in `permissions.allow`; requires a curated allowlist in `settings.json`
- `bypassPermissions` — no checks; isolated containers/VMs only
- Note: `auto` mode exists but is only available for Teams and Enterprise accounts
- See [Permission Modes](https://code.claude.com/docs/en/permission-modes)
Update `permission_mode` in config.json.

**If argument is "heartbeat":**
- Show current heartbeat config (including `stale_threshold`)
- Ask: "Enable background heartbeat? (yes / no) [current value]"
- If yes: ask for interval, show_ok, active hours, and stale threshold
  - Stale threshold: "Alert if an active session has no progress for how long? (e.g., 2h, 30m) [current value]"
- Update `heartbeat` object in config.json.
  - Note: "Heartbeat changes take effect on next `/claude-code-hermit:heartbeat start` or `hermit-start.py` run."

**If argument is "routines":**
- Show current routines from `config.routines` array:
  ```
  Routines (config.json routines → routine-watcher.sh):

    #  ID           Time   Days      Skill                                Status
    1. morning      08:30  daily     claude-code-hermit:brief --morning    enabled
    2. evening      22:30  daily     claude-code-hermit:brief --evening    enabled
    3. weekly-deps  09:00  mon       claude-code-hermit:session-start ...  disabled

  (or "No routines configured" if empty)
  ```
- Ask: "Add / edit / remove / enable / disable? (or 'done')"
- **Add wizard:** ask for:
  - ID (unique name, e.g., "weekly-deps")
  - Time (HH:MM)
  - Days (daily, or specific days like "mon,wed,fri")
  - Skill to run (full slash-command name, e.g. `claude-code-hermit:brief` for plugin skills, `ha-refresh-context` for local project skills)
  - Enabled (yes/no, default yes)
  - Write to `config.json` routines array. The watcher picks it up within 60 seconds.
- **Edit:** select by number, change any field.
- **Remove:** select by number, delete from array.
- **Enable/disable:** select by number, toggle `enabled` field.
- Loop until operator says "done".
- Note: "Routine changes take effect within 60 seconds (watcher re-reads config each cycle)."

**If argument is "idle":**
- Show current `idle_behavior` and `idle_budget` values
- Ask: "What should the hermit do when idle between tasks?
    1. Discover — also run idle tasks, reflection, and priority alignment (default)
    2. Wait — only check for new tasks and channel messages
  Choose 1-2: [current value]"
- Update `idle_behavior` in config.json with `"wait"` or `"discover"`.
- If "discover" is selected, show `idle_budget` and offer to change it:
  "Cost cap per idle task? [{current value}]"
  Update `idle_budget` if changed.

**If argument is "env":**
- Show current `env` values from config.json in a table:
  ```
  Environment Variables (config.json env → .claude/settings.local.json)

    AGENT_HOOK_PROFILE              standard
    COMPACT_THRESHOLD               50
    CLAUDE_AUTOCOMPACT_PCT_OVERRIDE 50
    MAX_THINKING_TOKENS             10000
  ```
- **Protected keys** that cannot be changed via this command: `AGENT_HOOK_PROFILE`. These are managed by the boot script and docker-setup. If the operator tries to set one, respond: "AGENT_HOOK_PROFILE is managed by the boot script (standard for interactive, strict for Docker). To change it, edit config.json directly — the boot script validates on next start."
- Ask: "Set, change, or remove an env var? (e.g., 'MAX_THINKING_TOKENS 20000', 'remove COMPACT_THRESHOLD', or 'done') [done]"
- Loop until operator says "done", "skip", or presses Enter:
  - If input targets a protected key: reject with the message above
  - If input is `remove <KEY>`: delete the key from `env`
  - If input is `<KEY> <VALUE>`: set `env[KEY] = VALUE`
- Note: "Env changes are written to `.claude/settings.local.json` on next `hermit-start`. To apply now, restart the hermit session."

**If argument is "compact":**
- Show current `compact` values from config.json:
  ```
  SHELL.md Compaction (config.json compact → session-mgr idle transition)

    monitoring_threshold    30    (compact when Monitoring exceeds this many lines)
    monitoring_keep         20    (keep this many recent entries after compacting)
    summary_threshold       30    (compact when Session Summary exceeds this many lines)
    summary_keep            15    (keep this many recent entries after compacting)
  ```
- Ask: "Change a threshold? (e.g., 'monitoring_threshold 50', 'summary_keep 20', or 'done') [done]"
- Loop until operator says "done", "skip", or presses Enter:
  - Validate: value must be a positive integer
  - Validate: `*_keep` must not exceed its corresponding `*_threshold` (setting keep equal to threshold effectively disables compaction for that section)
  - Update `compact[key]` in config.json
- Note: "Compaction runs at each idle transition (task completion). No restart needed."

**If argument is "docker":**
- Show current `docker.packages` list:
  ```
  Docker Packages (config.json docker.packages → Dockerfile.hermit)

    build-essential
    ffmpeg

  (or "No packages configured" if empty)
  ```
- Ask: "Add or remove packages? (e.g., 'add ffmpeg imagemagick', 'remove ffmpeg', or 'done') [done]"
- Loop until operator says "done", "skip", or presses Enter:
  - If input is `remove <PKG> [<PKG>...]`: remove the packages from `docker.packages`
  - If input is `add <PKG> [<PKG>...]`: add the packages to `docker.packages` (deduplicate)
  - If input is just package names without add/remove prefix: treat as add
- After changes, note: "Rebuild your container to apply: `docker compose -f docker-compose.hermit.yml build`"

- Then show current `docker.recommended_plugins`:
  ```
  Recommended Plugins (config.json docker.recommended_plugins)

    [enabled]  claude-code-setup (claude-plugins-official) — auto-installed on boot
    [tracked]  superpowers (obra/superpowers-marketplace) — manual install only

  (or "No recommended plugins configured" if empty)

  Note: Only claude-plugins-official plugins are auto-installed.
  Third-party plugins are tracked for reference but must be installed manually.
  ```
- Ask: "Enable, disable, add, or remove recommended plugins? (e.g., 'enable claude-code-setup', 'add claude-code-setup', 'add superpowers obra/superpowers-marketplace', 'remove superpowers', or 'done') [done]"
- Loop until operator says "done", "skip", or presses Enter:
  - `enable <PLUGIN>`: set `enabled: true` on matching entry
  - `disable <PLUGIN>`: set `enabled: false` on matching entry
  - `remove <PLUGIN>`: remove the entry entirely
  - `add <PLUGIN> [<MARKETPLACE>]`: add new entry with `marketplace` (`"claude-plugins-official"` if omitted), `scope: "project"`, `enabled: true`. Deduplicate by plugin name. If marketplace is third-party (contains `/`), warn: "Third-party plugins are not auto-installed — you'll need to install manually inside the container."
  - If input is just a plugin name without a verb: treat as `enable` if it exists, `add` if it doesn't
- After changes for official plugins, note: "Restart container to install new plugins."
- After changes for third-party plugins, note: "Entry saved for tracking. Install manually: `docker exec <container> claude plugin install <plugin>@<marketplace> --scope <scope>`"

**If argument is "plugin-checks":**
- Read `state/reflection-state.json` for runtime state (last run dates). If missing, show "(no runs yet)" for all.
- Show current `plugin_checks` entries from config.json:
  ```
  Plugin Checks (config.json plugin_checks)

    #  ID                      Plugin               Trigger   Interval  Last Run    Status
    1. automation-recommender  claude-code-setup     interval  7 days    2026-04-01  enabled
    2. md-audit                claude-md-management  interval  7 days    (never)     enabled
    3. md-revise               claude-md-management  session   —         2026-04-06  enabled

  (or "No plugin checks configured" if empty)
  ```
- Ask: "Enable, disable, add, remove, or change interval? (e.g., 'disable md-audit', 'interval automation-recommender 14', 'add my-check my-plugin /my-plugin:my-skill interval 7', 'add my-check my-plugin /my-plugin:my-skill session', or 'done') [done]"
- Loop until operator says "done", "skip", or presses Enter:
  - `enable <id>`: set `enabled: true` on matching entry
  - `disable <id>`: set `enabled: false` on matching entry
  - `interval <id> <days>`: update `interval_days` on matching entry (only valid for `trigger: "interval"`)
  - `add <id> <plugin> <skill> interval [days]`: add interval-triggered entry with `enabled: true`, `interval_days` (default: 7). Deduplicate by id.
  - `add <id> <plugin> <skill> session`: add session-triggered entry with `enabled: true`. Deduplicate by id.
  - `remove <id>`: delete the entry from config and its state from `state/reflection-state.json`
- Note: "Interval checks run during idle reflection. Session checks run at task completion. Changes take effect on the next cycle."

### 3. Write config

Write the updated config back to `.claude-code-hermit/config.json`.
Confirm the change to the operator.
