---
name: upgrade
description: Upgrades hermit configuration and templates after a plugin update. Detects version gaps, presents new features, walks through new settings. Run after updating the plugin.
---
# Upgrade Hermit

Upgrade the project's hermit configuration after a plugin update.

## Plan

### 1. Read versions

- Read `.claude-code-hermit/config.json`
- Read `${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json` to get the current plugin version
- Read `_hermit_versions` from config (default to `{"claude-code-hermit": "0.0.0"}` if the field is missing — this means the project was initialized before version tracking existed)
- Compare: `config_version` vs `plugin_version`

If versions match: report "You're up to date (vX.Y.Z). Nothing to upgrade." and stop.

If config.json doesn't exist: report "No config found. Run `/claude-code-hermit:init` first." and stop.

### 2. Read changelog

- Read `${CLAUDE_PLUGIN_ROOT}/CHANGELOG.md`
- Extract entries between the config version and the plugin version
- Present a summary to the operator: "Upgrading from vX.Y.Z to vA.B.C. Here's what changed:"
- Show only the relevant changelog sections (not the entire file)

### 3. Detect new config keys

- Read `${CLAUDE_PLUGIN_ROOT}/state-templates/config.json.template` for the current schema
- Compare keys in the template against keys in the project's config.json
- Identify new keys not present in the project's config

### 4. Ask about new settings

For each new key, check the table below. If the key is interactive, ask the operator. If not, add it silently with the default value. Batch interactive questions into a single numbered list.

The prompts below match the init wizard exactly. Use the same wording for consistency.

| Key | Added in | Interactive | Default |
|-----|----------|-------------|---------|
| `agent_name` | 0.0.1 | yes | `null` |
| `language` | 0.0.1 | yes (auto-detect via `echo $LANG | cut -d_ -f1`) | `"en"` |
| `timezone` | 0.0.1 | yes (auto-detect via `cat /etc/timezone 2>/dev/null || timedatectl show -p Timezone --value 2>/dev/null || date +%Z`) | `"UTC"` |
| `escalation` | 0.0.1 | yes | `"balanced"` |
| `sign_off` | 0.0.1 | conditional (only if `agent_name` was set) | `null` |
| `_plugin_root` | 0.0.1 | no | Resolve from `${CLAUDE_PLUGIN_ROOT}` |
| `heartbeat.self_eval_interval` | 0.0.1 | no | `20` |
| `heartbeat.total_ticks` | 0.0.1 | no | `0` |
| `remote` | 0.0.1 | yes | `true` |
| `always_on` | 0.0.1 | no | `true` |
| `heartbeat._last_reflection` | 0.0.4 | no | `null` |
| `env` | 0.0.7 | no | `{"AGENT_HOOK_PROFILE": "standard", "COMPACT_THRESHOLD": "50", "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE": "50", "MAX_THINKING_TOKENS": "10000"}` |
| `docker` | 0.0.7 | no | `{"packages": []}` |
| `idle_behavior` | 0.0.9 | yes | `"wait"` |
| `idle_budget` | 0.0.9 | no | `"$0.50"` |
| `heartbeat.stale_threshold` | 0.0.9 | no | `"2h"` |
| `routines` | 0.0.9 | no (migrated or empty) | `[]` |

**Prompts** (use the same text as the init wizard in `skills/init/SKILL.md` steps 4a–4e):
- `agent_name`: "Give your agent a name? This personalizes session reports, channel messages, and briefs. (e.g., Atlas, Hermit, Scout) [skip]"
- `language`: "What language should your assistant use for communication? [auto-detected: {value}]"
- `timezone`: "Timezone for scheduling? [auto-detected: {value}]"
- `escalation`: "How autonomous should your assistant be? 1. Conservative — ask before most non-trivial actions, create proposals instead of fixing directly. 2. Balanced — act on routine tasks, ask for significant changes (default). 3. Autonomous — proceed unless blocked, minimize interruptions. Choose 1-3: [2]"
- `sign_off`: "Sign-off line for channel messages and briefs? (e.g., '{name} out.', '— {initial}.', or skip) [skip]"

**v0.0.9 prompts:**
- `idle_behavior`: "What should the hermit do when idle between tasks? 1. Wait — only check for new tasks and channel messages (default). 2. Discover — also run maintenance tasks from OPERATOR.md and periodic reflection. Choose 1-2: [1]"

**v0.0.9 migration** (run before asking about new keys):

This migration converts deprecated v0.0.4 config keys into the new routines system. Order matters for dedup.

1. **Migrate `morning_brief`** (top-level, nullable object with `.time` and `.channel`):
   - If `morning_brief` exists and is not null and has a `.time` field:
     - Add `{"id":"morning","time":"<morning_brief.time>","skill":"brief --morning","enabled":true}` to `routines` array
     - Set `morning_brief` to `null`
     - Tell operator: "Morning brief migrated to routines system."

2. **Migrate `heartbeat.morning_routine`** (boolean):
   - If `heartbeat.morning_routine` exists:
     - If `true` AND no routine with `id: "morning"` already in `routines` (from step 1):
       - Add `{"id":"morning","time":"<active_hours.start + 30m>","skill":"brief --morning","enabled":true}`
     - Remove `heartbeat.morning_routine` from config

3. **Migrate `heartbeat.evening_routine`**:
   - If `heartbeat.evening_routine` exists:
     - If `true`: add `{"id":"evening","time":"<active_hours.end - 30m>","skill":"brief --evening","enabled":true}`
     - Remove `heartbeat.evening_routine` from config

4. **Migrate `heartbeat.idle_agency`**:
   - If `heartbeat.idle_agency` exists:
     - If `true`: set `idle_behavior` to `"discover"`
     - If `false`: set `idle_behavior` to `"wait"`
     - Remove `heartbeat.idle_agency` from config

5. **Clean up internal tracking keys**:
   - Remove: `heartbeat._last_morning`, `heartbeat._last_evening`
   - Keep: `heartbeat._last_reflection`

6. **Add new defaults for missing keys**:
   - `idle_budget`: `"$0.50"` (if missing)
   - `heartbeat.stale_threshold`: `"2h"` (if missing)
   - `routines`: `[]` (if missing — should exist from steps above)

7. **Create `.status` file**:
   - Write `"idle"` to `.claude-code-hermit/.status`

Tell the operator: "New settings available in this version:" then present only the questions for keys that are actually missing from their config. If no interactive keys are missing, skip this step.

### 5. Update templates

- Compare each template file in `${CLAUDE_PLUGIN_ROOT}/state-templates/` against the corresponding file in `.claude-code-hermit/templates/`
- If the plugin's template has different content: replace the project's template
- Report which templates were updated

**Never touch:** sessions, proposals, OPERATOR.md, HEARTBEAT.md (operator-editable), or config.json (handled separately).

**v0.0.4 additional checks:**
- Note about HEARTBEAT.md: "HEARTBEAT.md template has a new grouped structure (Task Checks, Idle Checks, Standing Checks). Your custom checklist is preserved. See `templates/HEARTBEAT.md.template` if you want to adopt the grouping."

**v0.0.9 additional checks:**
- Note about HEARTBEAT.md: "HEARTBEAT.md now includes a weight guideline comment (keep under 10 items). Your custom checklist is preserved."
- Note about OPERATOR.md: "OPERATOR.md template now includes a `## When Idle` section for low-priority maintenance tasks. Your existing OPERATOR.md is preserved — add the section manually if desired."
- Note about routines: "Morning and evening routines are now managed by the routine watcher shell script instead of the heartbeat LLM. Your config has been migrated automatically. Manage routines with `/hermit-settings routines`."

Only update files in `templates/`:
- `SHELL.md.template`
- `SESSION-REPORT.md.template`
- `PROPOSAL.md.template`

### 5b. Update boot script wrappers

- Check if `.claude-code-hermit/bin/` exists
- If not: copy `${CLAUDE_PLUGIN_ROOT}/state-templates/bin/hermit-start` and `hermit-stop` into `.claude-code-hermit/bin/`. Ensure they are executable.
- If yes: compare against the plugin's versions and replace if different
- Always update `_plugin_root` in config.json to the current `${CLAUDE_PLUGIN_ROOT}` value (the cache path changes on version upgrade)

### 6. Update CLAUDE-APPEND block

- Read the project's `CLAUDE.md`
- Find the `<!-- claude-code-hermit: Session Discipline -->` marker
- Read `${CLAUDE_PLUGIN_ROOT}/state-templates/CLAUDE-APPEND.md` for the current version
- Compare the block in CLAUDE.md (from the marker to the end of file or next `---` separator) with the template
- If different: replace the block with the updated content
- If the marker is not found: append the full CLAUDE-APPEND.md (same as init)
- Report what changed

### 7. Hermit upgrades

- Detect installed hermits using the same logic as init: scan `${CLAUDE_PLUGIN_ROOT}/../*/.claude-plugin/plugin.json` for names containing "hermit" that aren't "claude-code-hermit"
- For each detected hermit:
  - Read the hermit's `plugin.json` version
  - Compare against `_hermit_versions[hermit_name]` (default `"0.0.0"` if missing)
  - If version gap exists:
    - Read the hermit's `CHANGELOG.md` if it exists and present relevant entries
    - Update the hermit's CLAUDE-APPEND block in CLAUDE.md (find marker, replace content)
    - If the hermit provides an `UPGRADE.md` at its root, read it and follow its instructions
    - Update `_hermit_versions[hermit_name]` to the current hermit version
  - If no gap: skip silently

### 8. Ensure plugin permissions in settings.json

Same logic as init step 8: check `.claude/settings.json` for the plugin's required permissions (`git diff/status/log`, per-script `node` entries, the SessionStart `bash -c` hook, and `Edit`/`Write` on `.claude-code-hermit/**`). If any are missing, show the operator which ones and ask for confirmation before adding. Only add missing entries — never remove existing ones. If all are already present, skip silently. Also remove stale permissions from previous versions if found:
- `Bash(python3:*)`, `Bash(node:*)` — replaced by scoped node entries
- `Edit(.claude/.claude-code-hermit/**)`, `Write(.claude/.claude-code-hermit/**)` — replaced by `.claude-code-hermit/**` (v0.0.6 path change)

### 9. Write updated config

- Merge new keys into existing config (existing operator values are never overwritten)
- Update `_hermit_versions` with current versions for core and all detected hermits
- Write to `.claude-code-hermit/config.json`

### 10. Report

Print a summary:

```
Upgrade complete: vOLD -> vNEW

New settings configured:
  Agent name:  Atlas
  Language:    pt
  Timezone:    Europe/Lisbon
  Escalation:  balanced
  Sign-off:    Atlas out.

Templates updated:
  SHELL.md.template (refreshed)
  SESSION-REPORT.md.template (unchanged)
  PROPOSAL.md.template (unchanged)

CLAUDE.md:
  Session discipline block updated

Hermits:
  example-hermit: v0.2.0 -> v0.3.0 (updated)

Run /claude-code-hermit:hermit-settings to adjust any settings.
```

Adjust the summary based on what actually changed. Omit sections where nothing changed.
