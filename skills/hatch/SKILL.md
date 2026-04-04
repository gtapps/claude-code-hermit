---
name: hatch
description: Initializes the autonomous agent in the current project. Creates the state directory, templates, OPERATOR.md, and config.json. Appends session discipline to CLAUDE.md. Detects installed hermits. Run once per project, like git init.
---
# Initialize Autonomous Agent

Set up the autonomous agent for this project. This creates the per-project state directory, configures the project for session-based work, and optionally activates hermits.

## Plan

### 1. Check if already initialized

Check if `.claude-code-hermit/` exists in the current project.
- If it exists and has content: inform the operator that the agent is already initialized. Ask if they want to reinitialize (which resets templates but preserves sessions, proposals, config, and OPERATOR.md).
- If it doesn't exist: proceed with initialization.

### 2. Create state directory structure

Create the following directories and files:

```
.claude-code-hermit/
├── sessions/
├── proposals/
├── templates/
│   ├── SHELL.md.template
│   ├── SESSION-REPORT.md.template
│   └── PROPOSAL.md.template
├── bin/
│   ├── hermit-docker
│   ├── hermit-run
│   ├── hermit-start
│   ├── hermit-stop
│   └── hermit-status
└── OPERATOR.md
```

- Read the template files from `${CLAUDE_SKILL_DIR}/../../state-templates/`
- Copy `SHELL.md.template`, `SESSION-REPORT.md.template`, `PROPOSAL.md.template` into `templates/`
- **OPERATOR.md guard:** If `.claude-code-hermit/OPERATOR.md` already exists, do NOT copy the template over it. Remember this fact as `operator_existed = true` for use in step 5a. If it does not exist, copy `OPERATOR.md` from the templates into the state directory root.
- Copy `HEARTBEAT.md.template` → `.claude-code-hermit/HEARTBEAT.md` (the operator's editable checklist)
- Copy `bin/hermit-docker`, `bin/hermit-run`, `bin/hermit-start`, `bin/hermit-stop`, and `bin/hermit-status` from `${CLAUDE_SKILL_DIR}/../../state-templates/bin/` into `.claude-code-hermit/bin/`. Ensure they are executable (`chmod +x`).

### 3. Detect hermits

Look for sibling plugin directories that extend Hermit:
- Use Glob on `${CLAUDE_PLUGIN_ROOT}/../*/.claude-plugin/plugin.json`
- Read each found `plugin.json` and check if the `name` field contains "hermit" but is NOT "claude-code-hermit"
If hermits are found:
- List them and ask: "Activate a hermit for this project?"
- If the operator selects one: read that hermit's `state-templates/CLAUDE-APPEND.md` and append it to the target project's CLAUDE.md (after the core append in step 5)
- If none found or operator declines: skip

### 4. Setup wizard

Collect project preferences in 4–5 interactions. Use `AskUserQuestion` for all questions — multiple-choice questions use `options`, free-text questions omit `options` (renders as a text field).

#### Phase 1 — Auto-detect (silent, parallel)

Run both Bash commands in a single turn before asking anything:
- Language: `echo $LANG | cut -d_ -f1` (fallback: `en`)
- Timezone: `cat /etc/timezone 2>/dev/null || timedatectl show -p Timezone --value 2>/dev/null || date +%Z` (fallback: `UTC`)

#### Phase 2 — Identity

**4a. Agent name** — ask conversationally (single free-text `AskUserQuestion`)
Ask: "Give your agent a name? This personalizes session reports, channel messages, and briefs. (e.g., Atlas, Hermit, Scout) [skip]"
- If provided: record as `agent_name: "Atlas"`
- If skipped: record as `agent_name: null`

**4b+4c. Language + Timezone** — batch both in one `AskUserQuestion` call (no `options` — free-text inputs showing auto-detected defaults):
```
questions: [
  { header: "Language", question: "Language for communication? [auto-detected: {lang}] — confirm or type a code (en, pt, es, fr…)" },
  { header: "Timezone", question: "Timezone for scheduling? [auto-detected: {tz}] — confirm or type a different timezone" }
]
```
- If operator confirms / leaves blank: record detected values
- If operator types different values: record those instead

**4d. Sign-off style** (only if agent_name was provided in 4a — ask conversationally)
Ask: "Sign-off line for channel messages and briefs? (e.g., '{name} out.', '— {initial}.') [skip]"
- If provided: record as `sign_off: "Atlas out."`
- If skipped: record as `sign_off: null`

#### Phase 3 — Behavior (AskUserQuestion batch, 4 questions)

Ask all four in a single `AskUserQuestion` call:

```
questions: [
  {
    header: "Autonomy",
    question: "How autonomous should your assistant be?",
    options: [
      { label: "Balanced — act on routine tasks, ask for significant changes (default)" },
      { label: "Conservative — ask before most non-trivial actions" },
      { label: "Autonomous — proceed unless blocked, minimize interruptions" }
    ]
  },
  {
    header: "Remote control",
    question: "Enable remote control via claude.ai/code?",
    options: [{ label: "Yes (default)" }, { label: "No" }]
  },
  {
    header: "Session budget",
    question: "Ask for a cost budget at session start?",
    options: [{ label: "Never (default)" }, { label: "Always" }]
  },
  {
    header: "Idle behavior",
    question: "What should hermit do when idle between tasks?",
    options: [
      { label: "Discover — also run maintenance tasks and periodic reflection (default)" },
      { label: "Wait — only check for new tasks and channel messages" }
    ]
  }
]
```

Record: `escalation` (conservative/balanced/autonomous), `remote` (true/false), `ask_budget` (true/false), `idle_behavior` (wait/discover).

#### Phase 4 — Recommended plugins (AskUserQuestion batch, 3 questions)

```
questions: [
  {
    header: "Recommended plugins (installed by default)",
    question: "Install claude-code-setup? Analyzes your codebase and recommends automations (skills, hooks, MCP servers, subagents). Helps hermit learn and self-improve.",
    options: [{ label: "Yes (default)" }, { label: "No" }]
  },
  {
    question: "Install claude-md-management? Audits and improves CLAUDE.md files. Grades quality, identifies gaps, proposes targeted fixes.",
    options: [{ label: "Yes (default)" }, { label: "No" }]
  },
  {
    question: "Install skill-creator? Builds, tests, and refines new skills through structured iteration. Lets hermit act on proposals.",
    options: [{ label: "Yes (default)" }, { label: "No" }]
  }
]
```

For each plugin the operator accepts (the default), install it immediately:
`claude plugin install <plugin>@claude-plugins-official --scope project`

For each plugin the operator declines, skip silently. Note: "You can add it later with `/claude-code-hermit:hermit-settings`."

#### Phase 5 — Channels (AskUserQuestion, single question)

```
questions: [
  {
    header: "Channels",
    question: "Configure a notification channel for this project?",
    options: [{ label: "Discord (recommended)" }, { label: "Telegram" }, { label: "None — skip channel setup" }]
  }
]
```

- **If None:** record `channels: []`. **Stop — proceed directly to Phase 6. Do not ask channel follow-ups.**
- **If Discord or Telegram:** record short name in `channels` array (e.g., `["discord"]`). Boot script maps it to the full plugin identifier. Then ask follow-ups below.
- If the channel plugin isn't installed, note: "Install the channel plugin locally: `claude plugin install <plugin>@claude-plugins-official --scope local`"

**Channel follow-ups (only if Discord or Telegram was selected above — AskUserQuestion batch, 2 questions):**

```
questions: [
  {
    header: "Channel access control",
    question: "Restrict who can send commands via channels? Paste your Discord/Telegram user ID, or skip to allow everyone.",
    options: [{ label: "Skip (default)" }],
    freeform: true
  },
  {
    header: "Morning brief",
    question: "Enable morning brief delivery via channel?",
    options: [{ label: "Yes — deliver at 07:00" }, { label: "No (default)" }]
  }
]
```

- **Access control:** If user ID provided, record in `allowed_users.<channel>` as a single-element array (e.g., `"allowed_users": {"discord": ["123456789"]}`). If skip, omit `allowed_users` key (absent = accept all, backwards compatible). Note: "Add more user IDs later with `/claude-code-hermit:hermit-settings channels`. An empty array [] blocks all messages."
- **Morning brief:** If yes, record as `morning_brief: { "enabled": true, "time": "07:00", "channel": "<selected channel>" }`. If no, record `null`.

#### Phase 6 — Deployment (AskUserQuestion batch, 2 questions)

```
questions: [
  {
    header: "Permission mode",
    question: "Permission mode for Claude Code?",
    options: [
      { label: "acceptEdits — auto-approve file edits, prompt for shell commands (default)" },
      { label: "default — prompt for permission on first use of each tool" },
      { label: "plan — read-only exploration, no file modifications or shell commands" },
      { label: "dontAsk — deny all tools not in permissions.allow; requires a curated allowlist" },
      { label: "bypassPermissions — no checks at all; only for isolated containers/VMs" }
    ]
  },
  {
    header: "Daily routines",
    question: "Set up morning and evening routines? (morning brief reviews priorities, evening summarizes the day)",
    options: [{ label: "Yes (default)" }, { label: "No" }]
  }
]
```

Record: `permission_mode` (default/acceptEdits/plan/dontAsk/bypassPermissions).

For routines — if Yes: use the config defaults (`active_hours.start = 08:00`, `end = 23:00`) to derive morning = `08:30` and evening = `22:30`. Add to `routines` array:
- `{"id":"morning","time":"08:30","skill":"claude-code-hermit:brief --morning","enabled":true}`
- `{"id":"evening","time":"22:30","skill":"claude-code-hermit:brief --evening","enabled":true}`
- If no: leave `routines` as empty array

### 5. Write config.json

Write the collected preferences to `.claude-code-hermit/config.json`:

```json
{
  "_hermit_versions": {
    "claude-code-hermit": "<read from plugin.json>"
  },
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
  "idle_behavior": "discover",
  "idle_budget": "$0.50",
  "routines": [],
  "env": {
    "AGENT_HOOK_PROFILE": "standard",
    "COMPACT_THRESHOLD": "50",
    "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE": "50",
    "MAX_THINKING_TOKENS": "10000"
  },
  "heartbeat": {
    "enabled": true,
    "every": "30m",
    "show_ok": false,
    "active_hours": {
      "start": "08:00",
      "end": "23:00"
    },
    "stale_threshold": "2h",
    "_last_reflection": null
  }
}
```

Replace `{project_name}` with the actual project directory name in the template.

Read `${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json` to get the current plugin version and write it into `_hermit_versions["claude-code-hermit"]`. If a hermit was activated in step 3, also stamp its version.

If re-initializing: merge with existing config (preserve values not asked about, update values that were asked about).

If channels were configured in Phase 5, also add channel state dirs to `env` using the **absolute project path** (resolve from `pwd`):
- For discord: `"DISCORD_STATE_DIR": "<project_path>/.claude.local/channels/discord"`
- For telegram: `"TELEGRAM_STATE_DIR": "<project_path>/.claude.local/channels/telegram"`

The channel plugin writes both its token (`.env`) and access config (`access.json`) to this directory. Without `*_STATE_DIR`, the plugin defaults to `~/.claude/channels/<plugin>/` — which works on the host but is lost on Docker container restart. These env vars are written to `.claude/settings.local.json` by `hermit-start` at boot.

### 5-task. Write task list ID to settings.local.json

Set `CLAUDE_CODE_TASK_LIST_ID` in `.claude/settings.local.json` so native Claude Code Tasks are persistent and hooks can read task files.

1. Derive the task list ID: `hermit-{project_basename}` where `{project_basename}` is the current directory name (lowercase, alphanumeric + hyphens)
2. Read `.claude/settings.local.json` if it exists (may already have content from other tools)
3. Merge `CLAUDE_CODE_TASK_LIST_ID` into the `env` block (preserve all existing keys)
4. Write back to `.claude/settings.local.json`

This enables native Tasks for plan tracking. The cost-tracker hook reads task files from `~/.claude/tasks/{task_list_id}/` to generate `tasks-snapshot.md`.

### 5a. OPERATOR.md onboarding

Generate OPERATOR.md through a project scan and targeted conversation instead of asking the operator to edit it manually.

**Re-init guard:** If `operator_existed` is true (from step 2):
- Ask: "OPERATOR.md already exists — regenerate it from a fresh project scan? Your current one will be saved as OPERATOR.md.bak."
- If yes: rename existing to `.claude-code-hermit/OPERATOR.md.bak`, then proceed with phases below.
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

Write the draft to `.claude-code-hermit/OPERATOR.md`.

#### Phase 3 — Targeted questions (AskUserQuestion batch)

Questions are split into two `AskUserQuestion` calls (max 4 per call). Q1–Q4 are never skipped and always form the first call. Q5–Q7 are conditional and form a second call only if any are included.

**Call 1 — always sent (4 questions):**

| # | Header | Question | Maps to section |
|---|--------|----------|-----------------|
| 1 | Priority | "What's the current priority or goal for this project?" | Current Priority |
| 2 | Sensitive areas | "Are there fragile or sensitive areas I should avoid touching without asking?" | Sensitive Areas |
| 3 | Approval gates | "What actions require your explicit approval before I proceed?" | Constraints |
| 4 | Communication | "How do you prefer I communicate? (concise updates / detailed explanations / ask before every decision)" | Operator Preferences |

**Call 2 — only if any of Q5–Q7 apply (skip conditions below):**

| # | Header | Question | Skip if... | Maps to section |
|---|--------|----------|------------|-----------------|
| 5 | CI/CD | "Any CI/CD quirks I should know about? (flaky tests, required checks, deploy process)" | No CI config found in Phase 1 | Notes |
| 6 | Testing | "How should I handle testing? (run before commit, specific commands, coverage requirements)" | CLAUDE.md already covers testing | Notes |
| 7 | Team size | "How large is the team working on this? (solo / small team / large team)" | Skip if Q5 or Q6 is included (batch already ≥2) | Operator Preferences |

If none of Q5–Q7 apply, skip Call 2 entirely.

Tell the operator before Call 1: "I've scanned your project and drafted OPERATOR.md. A few questions to fill in what I couldn't infer:"

All questions use no `options` field (renders as free-text inputs). Accept short answers; expand into prose in Phase 4. If the operator leaves a field blank or types "skip", leave that section sparse.

**Hermit extension:** If a hermit was activated in step 3 and provides a file at `state-templates/OPERATOR-QUESTIONS.md`, read it and append those questions to Call 2 (or start a Call 3 if Call 2 is already at 4). The hermit's question file must include a "Maps to section" column for each question. In Phase 4, create or append to those sections in OPERATOR.md — if the section doesn't exist yet, add it after the core sections.

#### Phase 4 — Write final OPERATOR.md

Incorporate the operator's answers into the draft:
- Merge answers into the appropriate sections based on the "Maps to section" column
- Expand short answers into concise OPERATOR.md prose
- Strip all HTML comments from sections that have been filled in (both `<!-- Needs your input -->` and original template comments)
- Keep `<!-- Needs your input -->` markers only on sections the operator skipped
- Preserve the header comment at the top of the file (lines 1–5)
- For hermit sections that don't exist yet, create them after the core sections

Write the final version to `.claude-code-hermit/OPERATOR.md`.

#### Phase 5 — Confirm

Tell the operator: "OPERATOR.md is ready. You can review it at `.claude-code-hermit/OPERATOR.md`. Refine anytime — just tell me what changed."

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
      "Bash(bash -c 'AGENT_DIR=\".claude-code-hermit\"*)",
      "Edit(.claude-code-hermit/**)",
      "Write(.claude-code-hermit/**)"
    ]
  }
}
```

**Why each one:**
- `git diff`, `git status`, `git log` — session-diff.js hook auto-populates `## Changed` in SHELL.md
- `node */scripts/<name>.js` — Stop hooks (cost-tracker, suggest-compact, session-diff, evaluate-session), scoped to plugin scripts only
- `bash -c 'AGENT_DIR=...` — SessionStart hook that loads session context on every startup
- `Edit`, `Write` on `.claude-code-hermit/**` — heartbeat appends to SHELL.md, increments config.json tick counter, and skills update session state without prompting

**Steps:**
1. If `.claude/settings.json` exists: read it and identify which required permissions are missing from `permissions.allow`
2. If `.claude/settings.json` does not exist: all permissions are missing
3. If no permissions are missing: skip silently
4. If permissions need to be added: show the operator the list of permissions to add and ask for confirmation:
   "The plugin's hooks need these permissions in .claude/settings.json to run without prompting:
   - Bash(git diff/status/log:*) — session-diff hook
   - Bash(node */scripts/<name>.js*) — Stop hooks (cost tracker, session diff, etc.)
   - Bash(bash -c 'AGENT_DIR=...) — SessionStart context loader
   - Edit/Write(.claude-code-hermit/**) — heartbeat and session state updates
   Add these to .claude/settings.json? (yes / no) [yes]"
5. If the operator confirms: merge into the existing `permissions.allow` array (never remove existing entries), write back
6. If the operator declines: skip, and note: "You may be prompted to approve hook commands during sessions. Run `/claude-code-hermit:hermit-settings permissions` to add them later."

### 9. Generate deny patterns (AskUserQuestion, single question)

Add safety deny rules to `.claude/settings.json` `permissions.deny` to prevent destructive operations and protect OPERATOR.md from accidental modification.

```
questions: [
  {
    header: "Safety rules",
    question: "Planning always-on operation (Docker/tmux)? This determines which deny rules to apply.",
    options: [
      { label: "No — minimal deny rules (default)" },
      { label: "Yes — hardened deny rules for unattended operation" },
      { label: "Skip — no deny rules" }
    ]
  }
]
```

- If **hardened** (always-on):
  ```json
  "deny": [
    "Bash(rm -rf *)",
    "Bash(git push --force*)",
    "Bash(git reset --hard*)",
    "Bash(chmod 777*)",
    "Bash(curl * | bash*)",
    "Bash(wget * | bash*)",
    "Edit(**/.claude-code-hermit/OPERATOR.md)",
    "Write(**/.claude-code-hermit/OPERATOR.md)"
  ]
  ```
- If **minimal** (default):
  ```json
  "deny": [
    "Bash(rm -rf *)",
    "Bash(curl * | bash*)",
    "Bash(wget * | bash*)",
    "Edit(**/.claude-code-hermit/OPERATOR.md)",
    "Write(**/.claude-code-hermit/OPERATOR.md)"
  ]
  ```
- If **skip**: note: "You can add deny rules later in .claude/settings.json under permissions.deny."

Merge selected rules into existing `permissions.deny` (never remove existing entries), write back.

Do NOT include `Bash(docker *)`, `Bash(kubectl *)`, `Bash(ssh *)` — these are valid in devops contexts.

### 10. Report results

Print a summary:

```
Autonomous agent initialized!

Created:
  .claude-code-hermit/sessions/
  .claude-code-hermit/proposals/
  .claude-code-hermit/templates/ (3 templates)
  .claude-code-hermit/OPERATOR.md (onboarded)
  .claude-code-hermit/HEARTBEAT.md
  .claude-code-hermit/bin/ (hermit-start, hermit-stop, hermit-status)
  .claude-code-hermit/config.json

Identity:
  Agent name:      Atlas
  Language:        pt (auto-detected)
  Timezone:        Europe/Lisbon (auto-detected)
  Escalation:      balanced
  Sign-off:        Atlas out.

Config:
  Plugins:         claude-code-setup, claude-md-management, skill-creator
  Channels:        none
  Budget prompts:  enabled
  Morning brief:   disabled
  Heartbeat:       disabled
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
  4. For always-on operation: /claude-code-hermit:docker-setup or .claude-code-hermit/bin/hermit-start
  5. After plugin updates, run /claude-code-hermit:hermit-upgrade
```
