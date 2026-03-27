---
name: init
description: Initializes the autonomous agent in the current project. Creates the state directory, templates, OPERATOR.md, and config.json. Appends session discipline to CLAUDE.md. Detects installed hermits. Run once per project, like git init.
---
# Initialize Autonomous Agent

Set up the autonomous agent for this project. This creates the per-project state directory, configures the project for session-based work, and optionally activates hermits.

## Plan

### 1. Check if already initialized

Check if `.claude/.claude-code-hermit/` exists in the current project.
- If it exists and has content: inform the operator that the agent is already initialized. Ask if they want to reinitialize (which resets templates but preserves sessions, proposals, config, and OPERATOR.md).
- If it doesn't exist: proceed with initialization.

### 2. Create state directory structure

Create the following directories and files:

```
.claude/.claude-code-hermit/
├── sessions/
├── proposals/
├── templates/
│   ├── SHELL.md.template
│   ├── SESSION-REPORT.md.template
│   └── PROPOSAL.md.template
├── bin/
│   ├── hermit-run
│   ├── hermit-start
│   └── hermit-stop
└── OPERATOR.md
```

- Read the template files from `${CLAUDE_SKILL_DIR}/../../state-templates/`
- Copy `SHELL.md.template`, `SESSION-REPORT.md.template`, `PROPOSAL.md.template` into `templates/`
- **OPERATOR.md guard:** If `.claude/.claude-code-hermit/OPERATOR.md` already exists, do NOT copy the template over it. Remember this fact as `operator_existed = true` for use in step 5a. If it does not exist, copy `OPERATOR.md` from the templates into the state directory root.
- Copy `HEARTBEAT.md.template` → `.claude/.claude-code-hermit/HEARTBEAT.md` (the operator's editable checklist)
- Copy `bin/hermit-run`, `bin/hermit-start`, and `bin/hermit-stop` from `${CLAUDE_SKILL_DIR}/../../state-templates/bin/` into `.claude/.claude-code-hermit/bin/`. Ensure they are executable (`chmod +x`).

### 3. Detect hermits

Look for sibling plugin directories that extend Hermit:
- Use Glob on `${CLAUDE_PLUGIN_ROOT}/../*/.claude-plugin/plugin.json`
- Read each found `plugin.json` and check if the `name` field contains "hermit" but is NOT "claude-code-hermit"
If hermits are found:
- List them and ask: "Activate a hermit for this project?"
- If the operator selects one: read that hermit's `state-templates/CLAUDE-APPEND.md` and append it to the target project's CLAUDE.md (after the core append in step 5)
- If none found or operator declines: skip

### 4. Setup wizard

Run a conversational setup to configure project preferences. All questions have sensible defaults. The wizard is split into two groups: **Agent Identity** (who the agent is) and **Operational** (how the agent runs).

#### Agent Identity

**4a. Agent name**
Ask: "Give your agent a name? This personalizes session reports, channel messages, and briefs. (e.g., Atlas, Hermit, Scout) [skip]"
- If provided: record as `agent_name: "Atlas"`
- If skipped: record as `agent_name: null`

**4b. Preferred language**
Auto-detect the system locale by running Bash: `echo $LANG | cut -d_ -f1` (falls back to `en` if undetectable).
Ask: "What language should the agent use for communication? [auto-detected: pt]"
- If operator confirms or presses Enter: record the detected value
- If operator provides a different language code (e.g., `en`, `es`, `fr`): record that instead
- Record as `language: "pt"`

**4c. Timezone**
Auto-detect the system timezone by running Bash: `cat /etc/timezone 2>/dev/null || timedatectl show -p Timezone --value 2>/dev/null || date +%Z` (falls back to `UTC` if undetectable).
Ask: "Timezone for scheduling? [auto-detected: Europe/Lisbon]"
- If operator confirms or presses Enter: record the detected value
- If operator provides a different timezone: record that instead
- Record as `timezone: "Europe/Lisbon"`

**4d. Escalation threshold**
Ask: "How autonomous should the agent be?
  1. Conservative — ask before most non-trivial actions, create proposals instead of fixing directly
  2. Balanced — act on routine tasks, ask for significant changes (default)
  3. Autonomous — proceed unless blocked, minimize interruptions

Choose 1-3: [2]"
- Record as `escalation: "conservative"` / `"balanced"` / `"autonomous"`

**4e. Sign-off style** (only ask if agent_name was provided in 4a)
Ask: "Sign-off line for channel messages and briefs? (e.g., '{name} out.', '— {initial}.', or skip) [skip]"
- If provided: record as `sign_off: "Atlas out."`
- If skipped: record as `sign_off: null`

#### Operational

**4f. Channels**
Ask: "Configure channels for this project? (telegram / discord / none) [none]"
- If telegram or discord selected: record the short name (e.g., `"discord"`) in the `channels` array. The boot script maps it to the full plugin identifier (`plugin:discord@claude-plugins-official`).
- If the channel plugin isn't installed, note: "Install the channel plugin globally first with `/plugin install`"

**4f2. Remote control**
Ask: "Enable remote control? This lets you connect from a browser or phone via claude.ai/code. (yes / no) [yes]"
- If yes (default): record `remote: true` in config
- If no: record `remote: false`

**4g. Morning brief** (only if channels were selected in 4f)
Ask: "Enable morning brief delivery? (yes / no) [no]"
- If yes: ask "What time? (e.g., 07:00) [07:00]"
- Record in config as `morning_brief: { "enabled": true, "time": "07:00", "channel": "<selected channel>" }` or `null` if declined

**4i. Session budget**
Ask: "Ask for a cost budget at session start? (always / never) [never]"
- Record as `ask_budget: true` or `false`

**4j. Permission mode**
Ask: "Permission mode for unattended operation? (acceptEdits / dontAsk / bypassPermissions) [acceptEdits]"
- `acceptEdits` — auto-approves file edits, prompts for shell commands (default)
- `dontAsk` — denies all tools not in `permissions.allow`; requires a curated allowlist in `settings.json`
- `bypassPermissions` — no checks at all; only for isolated containers/VMs
- See [Permission Modes](https://code.claude.com/docs/en/permission-modes)
- Record as `permission_mode: "<value>"`

**4k. Daily routines**
Ask: "Should your assistant have a morning and evening routine? Morning: reviews overnight work, prepares a brief. Evening: archives the day, reflects on patterns. (yes / no) [yes]"
- If yes: record `heartbeat.morning_routine: true` and `heartbeat.evening_routine: true`
- If no: record both as `false`

**4l. Idle agency**
Ask: "When idle, should it work on accepted proposals and maintenance autonomously? Gated by your escalation setting. (yes / no) [yes]"
- Record as `heartbeat.idle_agency: true` or `false`

### 5. Write config.json

Write the collected preferences to `.claude/.claude-code-hermit/config.json`:

```json
{
  "_hermit_versions": {
    "claude-code-hermit": "<read from plugin.json>"
  },
  "_plugin_root": "<resolved from ${CLAUDE_PLUGIN_ROOT}>",
  "agent_name": null,
  "language": null,
  "timezone": null,
  "escalation": "balanced",
  "sign_off": null,
  "channels": [],
  "remote": true,
  "permission_mode": "acceptEdits",
  "tmux_session_name": "hermit-{project_name}",
  "auto_session": true,
  "ask_budget": false,
  "morning_brief": null,
  "heartbeat": {
    "enabled": true,
    "every": "30m",
    "show_ok": false,
    "active_hours": {
      "start": "08:00",
      "end": "23:00"
    },
    "morning_routine": true,
    "evening_routine": true,
    "idle_agency": true
  }
}
```

Replace `{project_name}` with the actual project directory name in the template.

Read `${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json` to get the current plugin version and write it into `_hermit_versions["claude-code-hermit"]`. If a hermit was activated in step 3, also stamp its version.

Resolve `${CLAUDE_PLUGIN_ROOT}` to an absolute path and write it as `_plugin_root`. This path is used by the wrapper scripts in `bin/` to locate the plugin's boot scripts.

If re-initializing: merge with existing config (preserve values not asked about, update values that were asked about). Always update `_plugin_root` to the current `${CLAUDE_PLUGIN_ROOT}` value.

### 5a. OPERATOR.md onboarding

Generate OPERATOR.md through a project scan and targeted conversation instead of asking the operator to edit it manually.

**Re-init guard:** If `operator_existed` is true (from step 2):
- Ask: "OPERATOR.md already exists — regenerate it from a fresh project scan? Your current one will be saved as OPERATOR.md.bak."
- If yes: rename existing to `.claude/.claude-code-hermit/OPERATOR.md.bak`, then proceed with phases below.
- If no: skip this entire step.

#### Phase 1 — Project scan (silent, no output to operator)

Scan the target project for context. Read ONLY the following if they exist — never read source code files. **Read all existing files in parallel** (batch into a single tool-call turn) to minimize scan time:

| File | Read scope |
|------|-----------|
| `CLAUDE.md` | Full file |
| `README.md` | First 200 lines |
| `package.json` | Full file |
| `requirements.txt` | Full file |
| `pyproject.toml` | Full file |
| `Cargo.toml` | Full file |
| `go.mod` | Full file |
| `docker-compose.yml` | Full file |
| `.github/workflows/` | List filenames; read the first workflow file |
| `.gitlab-ci.yml` | First 100 lines |
| `Makefile` | First 50 lines |

Also get the directory structure (2 levels deep) to understand the project layout.

Collect findings silently. Do NOT print scan results to the operator.

#### Phase 2 — Draft OPERATOR.md

Using the scan results, pre-fill the OPERATOR.md template sections. Follow these rules strictly:

1. **Never duplicate CLAUDE.md content.** If CLAUDE.md already covers a topic (testing, conventions, build commands), write "See CLAUDE.md" instead of repeating it.
2. **Only fill high-confidence inferences.** If the scan clearly reveals something (e.g., package.json shows Node.js, README describes the project), replace the template's HTML comment with actual content. If uncertain, leave the section empty.
3. **Mark unknowable sections** by replacing the template's HTML comment with `<!-- Needs your input -->` so Phase 3 knows what to ask about.
4. **Front-load critical context** in the first 50 lines: the header comment, Project, Current Priority, Constraints, Sensitive Areas, and Operator Preferences must all appear before line 50 (the SessionStart hook reads `head -50`).
5. **Keep it concise.** OPERATOR.md is loaded every session-start — bloat costs tokens.

Write the draft to `.claude/.claude-code-hermit/OPERATOR.md`.

#### Phase 3 — Targeted questions (batch)

Present 3–5 questions to the operator in a single numbered list. Select from this bank, applying the skip rules:

| # | Question | Skip if... | Maps to section |
|---|----------|------------|-----------------|
| 1 | "What's the current priority or goal for this project?" | Never skip | Current Priority |
| 2 | "Are there fragile or sensitive areas I should avoid touching without asking?" | Never skip | Sensitive Areas |
| 3 | "What actions require your explicit approval before I proceed?" | Never skip | Constraints |
| 4 | "How do you prefer I communicate? (concise updates / detailed explanations / ask before every decision)" | Never skip | Operator Preferences |
| 5 | "Any CI/CD quirks I should know about? (flaky tests, required checks, deploy process)" | No CI config found in Phase 1 | Notes |
| 6 | "How should I handle testing? (run before commit, specific commands, coverage requirements)" | CLAUDE.md already covers testing | Notes |
| 7 | "How large is the team working on this? (solo / small team / large team)" | Skip unless batch is under 5 questions (i.e., both Q5 and Q6 were skipped) | Operator Preferences |

Tell the operator: "I've scanned your project and drafted OPERATOR.md. A few questions to fill in what I couldn't infer:"

Ask all selected questions at once as a numbered batch. Accept short answers — the agent expands them into prose. If the operator says "skip" for any question, leave that section sparse.

**Hermit extension:** If a hermit was activated in step 3 and provides a file at `state-templates/OPERATOR-QUESTIONS.md`, read it and append those questions to the batch after the core questions. The hermit's question file must include a "Maps to section" column for each question (e.g., `## Development Conventions`). In Phase 4, create or append to those sections in OPERATOR.md — if the section doesn't exist yet, add it after the core sections.

#### Phase 4 — Write final OPERATOR.md

Incorporate the operator's answers into the draft:
- Merge answers into the appropriate sections based on the "Maps to section" column
- Expand short answers into concise OPERATOR.md prose
- Strip all HTML comments from sections that have been filled in (both `<!-- Needs your input -->` and original template comments)
- Keep `<!-- Needs your input -->` markers only on sections the operator skipped
- Preserve the header comment at the top of the file (lines 1–5)
- For hermit sections that don't exist yet, create them after the core sections

Write the final version to `.claude/.claude-code-hermit/OPERATOR.md`.

#### Phase 5 — Confirm

Tell the operator: "OPERATOR.md is ready. You can review it at `.claude/.claude-code-hermit/OPERATOR.md`. Refine anytime — just tell me what changed."

### 6. Append session discipline to CLAUDE.md

- Check if `CLAUDE.md` exists at the project root
- If it exists: check if it already contains `claude-code-hermit: Session Discipline`
  - If yes: skip (already configured)
  - If no: read `${CLAUDE_SKILL_DIR}/../../state-templates/CLAUDE-APPEND.md` and append its contents to the end of CLAUDE.md
- If CLAUDE.md doesn't exist: create it with the append block as the initial content

If a hermit was activated in step 3, also append its CLAUDE-APPEND.md here.

### 7. Update .gitignore

- Check if `.gitignore` exists at the project root
- If it exists: check if it already contains `.claude/cost-log.jsonl`
  - If yes: skip
  - If no: read `${CLAUDE_SKILL_DIR}/../../state-templates/GITIGNORE-APPEND.txt` and append its contents
- If .gitignore doesn't exist: create it with the append content

### 8. Ensure plugin permissions in settings.json

The plugin's hooks and boot scripts require specific Bash permissions to run without prompting. Merge these into `.claude/settings.json` (the project-level, committed settings file):

**Required permissions:**
```json
{
  "permissions": {
    "allow": [
      "Bash(git diff:*)",
      "Bash(git status:*)",
      "Bash(git log:*)",
      "Bash(node */scripts/cost-tracker.js*)",
      "Bash(node */scripts/suggest-compact.js*)",
      "Bash(node */scripts/run-with-profile.js*)",
      "Bash(node */scripts/evaluate-session.js*)",
      "Bash(bash -c 'AGENT_DIR=\".claude/.claude-code-hermit\"*)",
      "Edit(.claude/.claude-code-hermit/**)",
      "Write(.claude/.claude-code-hermit/**)"
    ]
  }
}
```

**Why each one:**
- `git diff`, `git status`, `git log` — session-diff.js hook auto-populates `## Changed` in SHELL.md
- `node */scripts/<name>.js` — Stop hooks (cost-tracker, suggest-compact, session-diff, evaluate-session), scoped to plugin scripts only
- `bash -c 'AGENT_DIR=...` — SessionStart hook that loads session context on every startup
- `Edit`, `Write` on `.claude/.claude-code-hermit/**` — heartbeat appends to SHELL.md, increments config.json tick counter, and skills update session state without prompting

**Steps:**
1. If `.claude/settings.json` exists: read it and identify which required permissions are missing from `permissions.allow`
2. If `.claude/settings.json` does not exist: all permissions are missing
3. If no permissions are missing: skip silently
4. If permissions need to be added: show the operator the list of permissions to add and ask for confirmation:
   "The plugin's hooks need these permissions in .claude/settings.json to run without prompting:
   - Bash(git diff/status/log:*) — session-diff hook
   - Bash(node */scripts/<name>.js*) — Stop hooks (cost tracker, session diff, etc.)
   - Bash(bash -c 'AGENT_DIR=...) — SessionStart context loader
   - Edit/Write(.claude/.claude-code-hermit/**) — heartbeat and session state updates
   Add these to .claude/settings.json? (yes / no) [yes]"
5. If the operator confirms: merge into the existing `permissions.allow` array (never remove existing entries), write back
6. If the operator declines: skip, and note: "You may be prompted to approve hook commands during sessions. Run `/claude-code-hermit:hermit-settings permissions` to add them later."

### 9. Report results

Print a summary:

```
Autonomous agent initialized!

Created:
  .claude/.claude-code-hermit/sessions/
  .claude/.claude-code-hermit/proposals/
  .claude/.claude-code-hermit/templates/ (3 templates)
  .claude/.claude-code-hermit/OPERATOR.md (onboarded)
  .claude/.claude-code-hermit/HEARTBEAT.md
  .claude/.claude-code-hermit/bin/ (hermit-start, hermit-stop)
  .claude/.claude-code-hermit/config.json

Identity:
  Agent name:      Atlas
  Language:        pt (auto-detected)
  Timezone:        Europe/Lisbon (auto-detected)
  Escalation:      balanced
  Sign-off:        Atlas out.

Config:
  Channels: none
  Budget prompts: enabled
  Morning brief: disabled
  Heartbeat: disabled
  Unattended mode: off

Hermits: (none activated)

Updated:
  CLAUDE.md — session discipline block appended
  .gitignore — cost-log entry added
  .claude/settings.json — plugin permissions added

Next steps:
  1. Run /claude-code-hermit:session to start your first session
  2. Refine OPERATOR.md anytime — just tell me what changed
  3. Change settings with /claude-code-hermit:hermit-settings
  4. For always-on operation: .claude/.claude-code-hermit/bin/hermit-start
  5. After plugin updates, run /claude-code-hermit:upgrade
```
