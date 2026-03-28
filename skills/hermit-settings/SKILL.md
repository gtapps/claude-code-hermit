---
name: hermit-settings
description: View or change hermit configuration for this project. Manages model, channels, budget prompts, morning brief, heartbeat, routines, idle agency, and unattended mode.
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
/claude-code-hermit:hermit-settings routines        — enable/disable morning and evening routines
/claude-code-hermit:hermit-settings idle-agency     — toggle autonomous idle work
```

## Plan

### 1. Read config

Read `.claude-code-hermit/config.json`. If it doesn't exist, inform the operator: "No config found. Run `/claude-code-hermit:init` first."

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
  Heartbeat:       disabled (every: 30m, show_ok: false, active: 08:00-23:00)
  Permission mode:  acceptEdits (permission_mode: "acceptEdits")
  Auto session:    enabled (auto_session: true)
  tmux name:       hermit-myproject
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
Ask: "Permission mode for unattended operation? (acceptEdits / dontAsk / bypassPermissions) [current value]"
- `acceptEdits` — auto-approves file edits, prompts for shell commands (default)
- `dontAsk` — denies all tools not in `permissions.allow`; requires a curated allowlist in `settings.json`
- `bypassPermissions` — no checks; isolated containers/VMs only
- See [Permission Modes](https://code.claude.com/docs/en/permission-modes)
Update `permission_mode` in config.json.

**If argument is "heartbeat":**
- Show current heartbeat config
- Ask: "Enable background heartbeat? (yes / no) [current value]"
- If yes: ask for interval, show_ok, and active hours
- Update `heartbeat` object in config.json.
  - Note: "Heartbeat changes take effect on next `/claude-code-hermit:heartbeat start` or `hermit-start.py` run."

**If argument is "routines":**
- Show current state of `heartbeat.morning_routine` and `heartbeat.evening_routine`
- Ask: "Enable morning routine? Generates a brief at the start of each day. (yes / no) [current value]"
- Ask: "Enable evening routine? Archives the day's work and reflects at end of day. (yes / no) [current value]"
- Update `heartbeat.morning_routine` and `heartbeat.evening_routine` in config.json.

**If argument is "idle-agency":**
- Show current state of `heartbeat.idle_agency` and `escalation`
- Ask: "Allow autonomous idle work? When idle, your assistant checks for queued tasks, reflects on patterns, and runs maintenance. Gated by your escalation setting (currently: {escalation}). (yes / no) [current value]"
- Update `heartbeat.idle_agency` in config.json.

### 3. Write config

Write the updated config back to `.claude-code-hermit/config.json`.
Confirm the change to the operator.
