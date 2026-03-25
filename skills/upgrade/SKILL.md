---
name: upgrade
description: Upgrades hermit configuration and templates after a plugin update. Detects version gaps, presents new features, walks through new settings. Run after updating the plugin.
---
# Upgrade Hermit

Upgrade the project's hermit configuration after a plugin update.

## Plan

### 1. Read versions

- Read `.claude/.claude-code-hermit/config.json`
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

**Prompts** (use the same text as the init wizard in `skills/init/SKILL.md` steps 4a–4e):
- `agent_name`: "Give your agent a name? This personalizes session reports, channel messages, and briefs. (e.g., Atlas, Hermit, Scout) [skip]"
- `language`: "What language should the agent use for communication? [auto-detected: {value}]"
- `timezone`: "Timezone for scheduling? [auto-detected: {value}]"
- `escalation`: "How autonomous should the agent be? 1. Conservative — ask before most non-trivial actions, create proposals instead of fixing directly. 2. Balanced — act on routine tasks, ask for significant changes (default). 3. Autonomous — proceed unless blocked, minimize interruptions. Choose 1-3: [2]"
- `sign_off`: "Sign-off line for channel messages and briefs? (e.g., '{name} out.', '— {initial}.', or skip) [skip]"

Tell the operator: "New settings available in this version:" then present only the questions for keys that are actually missing from their config. If no interactive keys are missing, skip this step.

### 5. Update templates

- Compare each template file in `${CLAUDE_PLUGIN_ROOT}/state-templates/` against the corresponding file in `.claude/.claude-code-hermit/templates/`
- If the plugin's template has different content: replace the project's template
- Report which templates were updated

**Never touch:** sessions, proposals, OPERATOR.md, HEARTBEAT.md (operator-editable), or config.json (handled separately).

Only update files in `templates/`:
- `SHELL.md.template`
- `SESSION-REPORT.md.template`
- `PROPOSAL.md.template`

### 5b. Update boot script wrappers

- Check if `.claude/.claude-code-hermit/bin/` exists
- If not: copy `${CLAUDE_PLUGIN_ROOT}/state-templates/bin/hermit-start` and `hermit-stop` into `.claude/.claude-code-hermit/bin/`. Ensure they are executable.
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

### 7. Hermit agent upgrades

- Detect installed hermit agents using the same logic as init: scan `${CLAUDE_PLUGIN_ROOT}/../*/.claude-plugin/plugin.json` for names containing "hermit" that aren't "claude-code-hermit"
- For each detected hermit agent:
  - Read the hermit agent's `plugin.json` version
  - Compare against `_hermit_versions[agent_name]` (default `"0.0.0"` if missing)
  - If version gap exists:
    - Read the hermit agent's `CHANGELOG.md` if it exists and present relevant entries
    - Update the hermit agent's CLAUDE-APPEND block in CLAUDE.md (find marker, replace content)
    - If the hermit agent provides an `UPGRADE.md` at its root, read it and follow its instructions
    - Update `_hermit_versions[agent_name]` to the current hermit agent version
  - If no gap: skip silently

### 8. Ensure plugin permissions in settings.json

Same logic as init step 8: check `.claude/settings.json` for the plugin's required Bash permissions (`git diff`, `git status`, `git log`, `python3`, `node`, and the SessionStart hook `bash -c` command). If any are missing, show the operator which ones and ask for confirmation before adding. Only add missing entries — never remove existing ones. If all are already present, skip silently.

### 9. Write updated config

- Merge new keys into existing config (existing operator values are never overwritten)
- Update `_hermit_versions` with current versions for core and all detected hermit agents
- Write to `.claude/.claude-code-hermit/config.json`

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

Hermit agents:
  claude-code-dev-hermit: v0.2.0 -> v0.3.0 (updated)

Run /claude-code-hermit:hermit-settings to adjust any settings.
```

Adjust the summary based on what actually changed. Omit sections where nothing changed.
