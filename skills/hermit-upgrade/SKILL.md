---
name: hermit-upgrade
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

If config.json doesn't exist: report "No config found. Run `/claude-code-hermit:hatch` first." and stop.

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

**Prompts** — use the same wording and interaction model as the init wizard (see `skills/hatch/SKILL.md`):

- `agent_name` (Phase 2, conversational): "Give your agent a name? This personalizes session reports, channel messages, and briefs. (e.g., Atlas, Hermit, Scout) [skip]"
- `language` + `timezone` (Phase 2, single AskUserQuestion batch — no `options`):
  - Language: "Language for communication? [auto-detected: {value}] — confirm or type a code (en, pt, es, fr…)"
  - Timezone: "Timezone for scheduling? [auto-detected: {value}] — confirm or type a different timezone"
- `escalation` (Phase 3, AskUserQuestion with `options`): "How autonomous should your assistant be?" — options: Conservative / Balanced (default) / Autonomous
- `sign_off` (Phase 2, conversational — only if agent_name provided): "Sign-off line for channel messages and briefs? (e.g., '{name} out.', '— {initial}.') [skip]"

**v0.0.9 prompts:**
- `idle_behavior` (AskUserQuestion with `options`): "What should hermit do when idle between tasks?" — options: Discover (default) / Wait

**v0.0.9 migration** (run before asking about new keys):

This migration converts deprecated v0.0.4 config keys into the new routines system. Order matters for dedup.

1. **Migrate `morning_brief`** (top-level, nullable object with `.time` and `.channel`):
   - If `morning_brief` exists and is not null and has a `.time` field:
     - Add `{"id":"morning","time":"<morning_brief.time>","skill":"claude-code-hermit:brief --morning","enabled":true}` to `routines` array
     - Set `morning_brief` to `null`
     - Tell operator: "Morning brief migrated to routines system."

2. **Migrate `heartbeat.morning_routine`** (boolean):
   - If `heartbeat.morning_routine` exists:
     - If `true` AND no routine with `id: "morning"` already in `routines` (from step 1):
       - Add `{"id":"morning","time":"<active_hours.start + 30m>","skill":"claude-code-hermit:brief --morning","enabled":true}`
     - Remove `heartbeat.morning_routine` from config

3. **Migrate `heartbeat.evening_routine`**:
   - If `heartbeat.evening_routine` exists:
     - If `true`: add `{"id":"evening","time":"<active_hours.end - 30m>","skill":"claude-code-hermit:brief --evening","enabled":true}`
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

**v0.2.4 migration:**

1. **Remove `_plugin_root`** — If `_plugin_root` exists in config.json, delete the key entirely. Boot scripts now resolve the plugin path at runtime by scanning `~/.claude/plugins/`. This key caused path conflicts between Docker and host environments.

**v0.2.12 migration:**

1. **Prefix routine skills** — The routine watcher no longer auto-prepends `claude-code-hermit:`. Scan `config.routines[]`: for any entry whose `.skill` does NOT contain `:`, prepend `claude-code-hermit:` to the value. This is a one-time migration for existing configs.
   - Example: `"skill": "brief --morning"` → `"skill": "claude-code-hermit:brief --morning"`
   - Skills that already contain `:` are left as-is.
   - Tell operator: "Routine skills migrated to use full names (watcher no longer auto-prefixes)."

**v0.3.0 migration:**

1. **Create state/ directory:** `mkdir -p .claude-code-hermit/state/`
2. **Initialize state files** (create each if not present):
   - `state/alert-state.json`: `{"alerts": {}, "last_digest_date": null, "self_eval": {}}`
   - `state/reflection-state.json`: `{"last_reflection": null}`
   - `state/routine-queue.json`: `{"queued": []}`
   - `state/proposal-metrics.jsonl`: empty file
   No backfill of historical proposal data — metrics start from v0.3.0.
3. **Migrate `_last_reflection`:** If `config.json` has `heartbeat._last_reflection`, copy value to `state/reflection-state.json` as `last_reflection`. Remove `_last_reflection` from config.
4. **Update heartbeat.every:** If still `"30m"`, prompt operator: "Default heartbeat frequency changed to 2h in v0.3.0. Update? (y/n)". If yes, set to `"2h"`.
5. **Remove `self_eval_interval` from config:** If present in `heartbeat` block, remove it. (Now a constant in the skill instructions.)
6. **Remove `## Cost` from SHELL.md:** If active SHELL.md has a `## Cost` section: read the current cumulative cost value and report it to the operator: `"Migration note: cumulative session cost was $X.XX. Cost data is now in .status.json and will be shown on startup via the SessionStart hook."` Then remove the section. Don't silently discard data.
7. **Add `state/` to .gitignore** if not present (check for `.claude-code-hermit/state/` line).
8. **Remove `.heartbeat-skips`** if the file exists at `.claude-code-hermit/.heartbeat-skips`.
9. **Add `run_during_waiting: true`** to existing brief routines in config.json (routines where `.skill` contains `brief`).
10. **Add heartbeat-restart routine** if no routine with `id: "heartbeat-restart"` exists in config.json: `{"id": "heartbeat-restart", "time": "04:00", "skill": "claude-code-hermit:heartbeat start", "run_during_waiting": true, "enabled": true}`. Prevents silent heartbeat expiry in always-on deployments.
11. **Create `state/micro-proposals.json`** with `{"active": null}` if it does not exist.
12. **Backfill proposal frontmatter:** Scan all `.claude-code-hermit/proposals/PROP-*.md` files. For each file with YAML frontmatter (starts with `---`): if `responded` field is missing, add `responded: false`. If `self_eval_key` field is missing, add `self_eval_key: null`. This ensures the first-response guard in proposal-act works correctly on pre-v0.3.0 proposals.
13. **Update `heartbeat.waiting_timeout`:** Add `waiting_timeout: null` to `heartbeat` block if not present. (Silent, no operator prompt.)

**v0.3.0 additional checks:**
- Note to operator: "v0.3.0 is a significant update. Key changes:"
  - "Alert deduplication — repeated heartbeat alerts are now suppressed after 5 fires. A daily digest covers suppressed alerts."
  - "Micro-proposals — routine improvements now go through a lightweight yes/no channel approval instead of full PROP-NNN files."
  - "Waiting state — sessions can now be `waiting` (blocked on operator input) in addition to `in_progress` and `idle`."
  - "Cost tracking — the `## Cost` section has been removed from SHELL.md. Cost data is now in `.status.json` and shown on startup."
  - "Heartbeat frequency — default changed from 30m to 2h. You were prompted about this in step 4."
  - "Heartbeat restart — a daily 4am routine now resets the heartbeat loop to prevent silent expiry in always-on deployments."
- Note about CLAUDE.md: "The session discipline block in CLAUDE.md has been significantly trimmed (130 → ~35 lines). The upgrade will replace it automatically."

**v0.2.14 migration:**

1. **OPERATOR.md rethink (interactive)** — Ask the operator: "The OPERATOR.md template has been simplified — rigid sections replaced with concise freeform context. Would you like to rethink your OPERATOR.md? I can scan your project and rewrite it in the new style."
   - If **yes**: save current OPERATOR.md as `.claude-code-hermit/OPERATOR.md.bak`, then run the hatch OPERATOR.md onboarding flow (step 5a, Phases 1–5 from `skills/hatch/SKILL.md`) against the existing project. This scans the project, asks targeted questions, and writes a new freeform OPERATOR.md.
   - If **no**: skip. Existing OPERATOR.md files work fine — the hermit reads them as freeform context regardless of section structure.

2. **Migrate idle tasks to IDLE-TASKS.md** — If `.claude-code-hermit/IDLE-TASKS.md` does not exist:
   - Copy `${CLAUDE_PLUGIN_ROOT}/state-templates/IDLE-TASKS.md.template` to `.claude-code-hermit/IDLE-TASKS.md`.
   - Read OPERATOR.md for a `## When Idle` section. If found:
     - Extract all list items from the section.
     - Append each as a `- [ ]` checklist entry in IDLE-TASKS.md.
     - Remove the `## When Idle` section (header + content) from OPERATOR.md.
     - Tell operator: "Migrated {N} idle tasks from OPERATOR.md to IDLE-TASKS.md."
   - If no `## When Idle` section: tell operator: "Created IDLE-TASKS.md — add low-priority maintenance tasks for your hermit to work on during downtime."

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

**v0.0.4 additional checks:**
- Note about HEARTBEAT.md: "HEARTBEAT.md template has a new grouped structure (Task Checks, Idle Checks, Standing Checks). Your custom checklist is preserved. See `templates/HEARTBEAT.md.template` if you want to adopt the grouping."

**v0.0.9 additional checks:**
- Note about HEARTBEAT.md: "HEARTBEAT.md now includes a weight guideline comment (keep under 10 items). Your custom checklist is preserved."
- Note about routines: "Morning and evening routines are now managed by the routine watcher shell script instead of the heartbeat LLM. Your config has been migrated automatically. Manage routines with `/hermit-settings routines`."

Only update files in `templates/`:
- `SHELL.md.template`
- `SESSION-REPORT.md.template`
- `PROPOSAL.md.template`

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
