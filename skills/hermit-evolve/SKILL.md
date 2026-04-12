---
name: hermit-evolve
description: Evolves hermit configuration and templates after a plugin update. Detects version gaps, presents new features, walks through new settings. Run after updating the plugin.
---
# Evolve Hermit

Upgrade the project's hermit configuration after a plugin update.

## Plan

### 1. Read versions

- Read `.claude-code-hermit/config.json`
- Read `${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json` to get the current plugin version
- Read `_hermit_versions` from config (default to `{"claude-code-hermit": "0.0.0"}` if the field is missing — this means the project was initialized before version tracking existed)
- Compare: `config_version` vs `plugin_version`

If versions match: report "You're up to date (vX.Y.Z). Nothing to upgrade." and stop.

If config.json doesn't exist: report "No config found. Run `/claude-code-hermit:hatch` first." and stop.

### 2. Read changelog

- Read `${CLAUDE_PLUGIN_ROOT}/CHANGELOG.md`
- Extract entries between the config version and the plugin version
- Present a summary to the operator: "Upgrading from vX.Y.Z to vA.B.C. Here's what changed:"
- Show only the relevant changelog sections (not the entire file)

### 2b. Execute version migrations

For each CHANGELOG.md version entry between `config_version` (exclusive) and `plugin_version` (inclusive), processed in **oldest-first order**:

1. Find the `### Upgrade Instructions` section within that version's entry
2. If found, execute every instruction in that section — these are the authoritative migration steps
3. Present version-specific operator notes as you go
4. If a step is interactive (asks the operator a question), ask it before proceeding

This is the same pattern used for hermit plugin upgrades in step 7. The CHANGELOG.md `### Upgrade Instructions` sections are the single source of truth for migrations — do not skip or merely display them.

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
| `heartbeat.total_ticks` | 0.0.1 | no | `0` |
| `remote` | 0.0.1 | yes | `true` |
| `always_on` | 0.0.1 | no | `true` |
| `heartbeat.waiting_timeout` | 0.3.0 | no | `null` |
| `env` | 0.0.7 | no | `{"AGENT_HOOK_PROFILE": "standard", "COMPACT_THRESHOLD": "50", "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE": "50", "MAX_THINKING_TOKENS": "10000"}` |
| `docker` | 0.0.7 | no | `{"packages": []}` |
| `idle_behavior` | 0.0.9 | yes | `"discover"` |
| `idle_budget` | 0.0.9 | no | `"$0.50"` |
| `heartbeat.stale_threshold` | 0.0.9 | no | `"2h"` |
| `routines` | 0.0.9 | no (migrated or empty) | `[]` |
| `plugin_checks` | 0.3.1 | no | `[]` |
| `monitors` | 0.3.14 | no | `[]` |
| `git_tracking` | 0.3.15 | no | `"private"` |

**Prompts** — use the same wording and interaction model as the init wizard (see `skills/hatch/SKILL.md`):

- `agent_name` (Phase 2, conversational): "Give your agent a name? This personalizes session reports, channel messages, and briefs. (e.g., Atlas, Hermit, Scout) [skip]"
- `language` + `timezone` (Phase 2, single AskUserQuestion batch — no `options`):
  - Language: "Language for communication? [auto-detected: {value}] — confirm or type a code (en, pt, es, fr…)"
  - Timezone: "Timezone for scheduling? [auto-detected: {value}] — confirm or type a different timezone"
- `escalation` (Phase 3, AskUserQuestion with `options`): "How autonomous should your assistant be?" — options: Conservative / Balanced (default) / Autonomous
- `sign_off` (Phase 2, conversational — only if agent_name provided): "Sign-off line for channel messages and briefs? (e.g., '{name} out.', '— {initial}.') [skip]"
- `idle_behavior` (AskUserQuestion with `options`): "What should hermit do when idle between tasks?" — options: Discover (default) / Wait

Tell the operator: "New settings available in this version:" then present only the questions for keys that are actually missing from their config. If no interactive keys are missing, skip this step.

### 4-task. Write task list ID to settings.local.json

If `CLAUDE_CODE_TASK_LIST_ID` is not already set in `.claude/settings.local.json`:
1. Derive: `hermit-{project_basename}` (lowercase, alphanumeric + hyphens)
2. Read `.claude/settings.local.json`, merge into `env` block, write back

Also: if an active SHELL.md has a `## Plan` section (legacy plan table), warn the operator: "Close active sessions before upgrading, or the old plan table will be orphaned." Strip the `## Plan` section from the active SHELL.md if operator confirms.

### 5. Update templates

- Compare each template file in `${CLAUDE_PLUGIN_ROOT}/state-templates/` against the corresponding file in `.claude-code-hermit/templates/`
- If the plugin's template has different content: replace the project's template
- Report which templates were updated
- Note: SHELL.md.template no longer has a `## Plan` section — plan tracking is now handled by native Claude Code Tasks

**Never touch:** sessions, proposals, OPERATOR.md, HEARTBEAT.md, IDLE-TASKS.md (operator-editable), or config.json (handled separately).

Only update files in `templates/`:
- `SHELL.md.template`
- `SESSION-REPORT.md.template`
- `PROPOSAL.md.template`

### 5a. Ensure cortex-manifest.json exists

If `.claude-code-hermit/cortex-manifest.json` does not exist:
- Copy from `${CLAUDE_PLUGIN_ROOT}/state-templates/cortex-manifest.json.template` to `.claude-code-hermit/cortex-manifest.json`
- Report: "Created cortex-manifest.json (artifact indexing for Cortex). Configure artifact_paths via `/obsidian-setup` or edit directly."
- If it already exists: skip (operator-managed file, never overwrite)

### 5b. Update boot script wrappers

- Copy all files from `${CLAUDE_PLUGIN_ROOT}/state-templates/bin/` into `.claude-code-hermit/bin/`
- For each file: compare against the existing version and replace if different. Copy new files that don't exist yet.
- Ensure all files in `.claude-code-hermit/bin/` are executable

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
    - Read the hermit's `CHANGELOG.md` if it exists and extract version entries between the config version (exclusive) and the current version (inclusive)
    - Present a summary: "{hermit_name}: upgrading from vOLD to vNEW. Here's what changed:" followed by only the relevant changelog sections
    - **Execute migrations in version order** — For each extracted version entry (oldest first), look for a `### Upgrade Instructions` section. If found, execute every instruction in that section — do not skip or merely display them.
    - **Sync hermit's CLAUDE-APPEND block** — Same procedure as step 6, using:
      - Source template: the hermit's `state-templates/CLAUDE-APPEND.md`. If it doesn't exist, skip.
      - Marker: the first HTML comment line in that template (e.g. `<!-- hermit-name: Section Title -->`)
    - Update `_hermit_versions[hermit_name]` to the current hermit version
  - If no gap: skip silently

### 8. Ensure plugin permissions in settings.json

Same logic as init step 8: check `.claude/settings.json` for the plugin's required permissions (`git diff/status/log`, per-script `node` entries, the SessionStart `bash -c` hook, and `Edit`/`Write` on `.claude-code-hermit/**`). If any are missing, show the operator which ones and ask for confirmation before adding. Only add missing entries — never remove existing ones. If all are already present, skip silently. Also remove stale permissions from previous versions if found:
- `Bash(python3:*)`, `Bash(node:*)` — replaced by scoped node entries
- `Edit(.claude/.claude-code-hermit/**)`, `Write(.claude/.claude-code-hermit/**)` — replaced by `.claude-code-hermit/**` (v0.0.6 path change)

### 9. Write updated config

- Merge new keys into existing config (existing operator values are never overwritten)
- Update `_hermit_versions["claude-code-hermit"]` to the current plugin version
- For hermits: only update versions for hermits already present as keys in `_hermit_versions` — never add new keys here
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
