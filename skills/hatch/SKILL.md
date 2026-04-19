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
├── state/
│   ├── alert-state.json
│   ├── reflection-state.json
│   ├── routine-metrics.jsonl
│   ├── proposal-metrics.jsonl
│   └── micro-proposals.json
├── raw/
│   └── .archive/
├── compiled/
├── bin/
│   ├── hermit-docker
│   ├── hermit-run
│   ├── hermit-start
│   ├── hermit-stop
│   └── hermit-status
├── OPERATOR.md
├── IDLE-TASKS.md
└── knowledge-schema.md
```

Initialize state files (inline — shape-insensitive or append-only):

- `.claude-code-hermit/state/reflection-state.json`: initialize with the schema below. Use the current ISO timestamp (with offset) for `counters.since`.
  ```json
  {
    "last_reflection": null,
    "counters": {
      "total_runs": 0,
      "empty_runs": 0,
      "runs_with_candidates": 0,
      "judge_accept": 0,
      "judge_downgrade": 0,
      "judge_suppress": 0,
      "proposals_created": 0,
      "micro_proposals_queued": 0,
      "last_run_at": null,
      "last_output_at": null,
      "since": "<current-iso-timestamp>"
    }
  }
  ```
- `.claude-code-hermit/state/proposal-metrics.jsonl`: empty file — append-only, not schema-sensitive JSON state
- `.claude-code-hermit/state/routine-metrics.jsonl`: empty file — append-only routine fire log (`fired` events written by `scripts/log-routine-event.sh` from CronCreate prompts)

- Read the template files from `${CLAUDE_SKILL_DIR}/../../state-templates/`
- Copy `alert-state.json.template` → `.claude-code-hermit/state/alert-state.json`
- Copy `micro-proposals.json.template` → `.claude-code-hermit/state/micro-proposals.json`
- Copy `SHELL.md.template`, `SESSION-REPORT.md.template`, `PROPOSAL.md.template` into `templates/`
- **OPERATOR.md guard:** If `.claude-code-hermit/OPERATOR.md` already exists, do NOT copy the template over it. Remember this fact as `operator_existed = true` for use in step 5a. If it does not exist, copy `OPERATOR.md` from the templates into the state directory root.
- Copy `HEARTBEAT.md.template` → `.claude-code-hermit/HEARTBEAT.md` (the operator's editable checklist)
- Copy `IDLE-TASKS.md.template` → `.claude-code-hermit/IDLE-TASKS.md` (the operator's idle task list)
- Copy `bin/hermit-docker`, `bin/hermit-run`, `bin/hermit-start`, `bin/hermit-stop`, and `bin/hermit-status` from `${CLAUDE_SKILL_DIR}/../../state-templates/bin/` into `.claude-code-hermit/bin/`. Ensure they are executable (`chmod +x`).
- Copy `knowledge-schema.md.template` → `.claude-code-hermit/knowledge-schema.md` (the operator's behavioral schema for domain outputs).

### 3. Detect hermits

Look for sibling plugin directories that extend Hermit:

- Use Glob on `${CLAUDE_PLUGIN_ROOT}/../*/.claude-plugin/plugin.json`
- Read each found `plugin.json` and check if the `name` field contains "hermit" but is NOT "claude-code-hermit"
  If hermits are found:
- List them and ask: "Activate a hermit for this project?"
- If the operator selects one: read that hermit's `state-templates/CLAUDE-APPEND.md` and append it to the target project's CLAUDE.md (after the core append in step 5)
- If none found or operator declines: skip

### 4. Setup wizard

Collect project preferences in 4–5 interactions. Use `AskUserQuestion` for all questions. Every question requires 2-4 `options` — users can always type free text via the auto-provided "Other" option.

#### Phase 1 — Auto-detect (silent, parallel)

Run both Bash commands in a single turn before asking anything:

- Language: `echo $LANG | cut -d_ -f1` (fallback: `en`)
- Timezone: `cat /etc/timezone 2>/dev/null || timedatectl show -p Timezone --value 2>/dev/null || date +%Z` (fallback: `UTC`)

#### Phase 2 — Identity

**4a. Agent name** — ask with `AskUserQuestion` (header: "Agent name"). Options: **Atlas** / **Hermit** / **Skip** — plus Other for a custom name.

- If "Skip" or Other left blank: record as `agent_name: null`
- Otherwise: record the selected or typed value as `agent_name`

**4b+4c. Language + Timezone** — batch both in one `AskUserQuestion` call (header: "Language" / "Timezone"). For each, offer the auto-detected value as the first option and one common alternative (e.g., "en" / "UTC"). If auto-detected already matches the alternative, swap in a different one to avoid duplicates.

- Record selected label or Other free-text as the value

**4d. Sign-off style** (only if agent_name was provided in 4a) — ask with `AskUserQuestion` (header: "Sign-off"). Options: **{name} out.** / **-- {initial}.** / **Skip** — plus Other for custom phrasing. Replace `{name}` and `{initial}` from the agent name.

- If "Skip": record as `sign_off: null`
- Otherwise: record selected or typed value as `sign_off`

#### Phase 3 — Behavior (AskUserQuestion batch, 4 questions)

Ask all four in a single `AskUserQuestion` call:

```
questions: [
  {
    header: "Autonomy",
    question: "How autonomous should your assistant be?",
    options: [
      { label: "Balanced", description: "Act on routine tasks, escalate significant changes (default)" },
      { label: "Conservative", description: "Ask before most non-trivial actions" },
      { label: "Autonomous", description: "Proceed unless blocked, minimize interruptions" }
    ]
  },
  {
    header: "Remote ctrl",
    question: "Enable remote control via claude.ai/code?",
    options: [
      { label: "Yes", description: "Connect from claude.ai/code or phone (default)" },
      { label: "No", description: "Local terminal only" }
    ]
  },
  {
    header: "Budget",
    question: "Ask for a cost budget at session start?",
    options: [
      { label: "Never", description: "No cost prompts at session start (default)" },
      { label: "Always", description: "Ask for a dollar cap each session" }
    ]
  },
  {
    header: "Idle",
    question: "What should hermit do when idle between tasks?",
    options: [
      { label: "Discover", description: "Maintenance, reflection, and idle tasks (default)" },
      { label: "Wait", description: "Passive — only check for new tasks and messages" }
    ]
  }
]
```

Record: `escalation` (conservative/balanced/autonomous), `remote` (true/false), `ask_budget` (true/false), `idle_behavior` (wait/discover).

#### Phase 4 — Recommended plugins (AskUserQuestion, single multiSelect question)

<!-- Compatible-plugin list is mirrored in hatch Phase 4 options, Phase 4b eligibility, and session-start step 5b. Update all three when adding. -->

```
questions: [
  {
    header: "Plugins",
    question: "Which recommended plugins should be installed? All are from claude-plugins-official.",
    options: [
      { label: "claude-code-setup", description: "Analyzes codebase, recommends automations (skills, hooks, MCP servers, subagents)" },
      { label: "claude-md-management", description: "Audits and improves CLAUDE.md files — grades quality, proposes fixes" },
      { label: "skill-creator", description: "Builds and refines new skills from proposals" },
      { label: "None", description: "Skip all — add later via hermit-settings" }
    ],
    multiSelect: true
  }
]
```

Note: `multiSelect: true` is intentional — all three plugins can be selected at once.

- All plugins are selected by default — deselect to skip
- If "None" is selected, skip all plugin installs
- For each selected plugin (not "None"), install it immediately:
  `claude plugin install <plugin>@claude-plugins-official --scope project`

For each accepted plugin, also add the corresponding `plugin_checks` entries to config.json:

- `claude-code-setup` → `{"id":"automation-recommender","plugin":"claude-code-setup","skill":"/claude-code-setup:claude-automation-recommender","enabled":true,"trigger":"interval","interval_days":7}`
- `claude-md-management` → two entries:
  - `{"id":"md-audit","plugin":"claude-md-management","skill":"/claude-md-management:claude-md-improver","enabled":true,"trigger":"interval","interval_days":7}`
  - `{"id":"md-revise","plugin":"claude-md-management","skill":"/claude-md-management:revise-claude-md","enabled":true,"trigger":"session"}`
- `skill-creator` → no entry (event-driven via proposal-act, not scheduled)

For each plugin the operator declines, skip silently. Note: "You can add it later with `/claude-code-hermit:hermit-settings`."

#### Phase 4b — Baseline audit marker (conditional)

<!-- Compatible-plugin list is mirrored in hatch Phase 4 options, Phase 4b eligibility, and session-start step 5b. Update all three when adding. -->

Create `.claude-code-hermit/.baseline-pending` (empty file) ONLY if **all three** are true:

1. This is a **fresh init**, not a re-init. (Step 1 of hatch branches on an existing `.claude-code-hermit/`; skip this phase on re-init.)
2. Phase 4 accepted **either** `claude-md-management` **or** `claude-code-setup`.
3. The project is an **existing codebase** — at least one of the following files exists at the project root:
   - `package.json`, `requirements.txt`, `pyproject.toml`, `Cargo.toml`, `go.mod`, `Gemfile`, `composer.json`, `pom.xml`, `build.gradle`

`README.md` and `CLAUDE.md` alone do NOT qualify. If none of the eligibility conditions hold, skip silently — no operator prompt here.

The marker's existence is the entire state model. No JSON, no timestamp, no content.

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

- **If None:** record `channels: {}`. **Stop — proceed directly to Phase 6. Do not ask channel follow-ups.**
- **If Discord or Telegram:** create a channel entry under the `channels` object (e.g., `channels.discord`). Boot script maps the key to the full plugin identifier. Then ask follow-ups below.
- Channel plugins require Bun and manual setup (bot creation, token, pairing). After saving the preference to `config.json`, note:

  > **Channel preference saved.**
  >
  > - Local/tmux: run `/claude-code-hermit:channel-setup` to activate it (installs plugin, configures token, guides pairing).
  > - Docker: `/claude-code-hermit:docker-setup` handles channels automatically.
  > - Full guide: https://code.claude.com/docs/en/channels

**Channel follow-ups (only if Discord or Telegram was selected above — AskUserQuestion batch, 2 questions):**

```
questions: [
  {
    header: "Access ctrl",
    question: "Restrict who can send commands via this channel?",
    options: [
      { label: "Allow everyone", description: "No restrictions on who can message (default)" },
      { label: "Restrict", description: "Type your Discord/Telegram user ID via Other" }
    ]
  },
  {
    header: "Brief",
    question: "Enable morning brief delivery via channel?",
    options: [
      { label: "Yes — 07:00", description: "Daily summary delivered each morning" },
      { label: "No", description: "No automated brief delivery (default)" }
    ]
  }
]
```

- **Access control:** If "Restrict" and a numeric ID was typed via Other, record in `channels.<channel>.allowed_users` as `["<id>"]`. If "Allow everyone" or no ID provided, omit the key (absent = accept all). Note: "Add more user IDs later with `/claude-code-hermit:hermit-settings channels`. An empty array [] blocks all messages."
- **Morning brief:** If "Yes — 07:00", record as `channels.<channel>.morning_brief: { "enabled": true, "time": "07:00" }`. If "No", omit the key (or set to `null`).

#### Phase 6 — Deployment (AskUserQuestion batch, 3 questions)

```
questions: [
  {
    header: "Permissions",
    question: "Permission mode for Claude Code?",
    options: [
      { label: "bypassPermissions", description: "No permission prompts. Best for true always-on use in isolated, trusted environments (Docker)" },
      { label: "acceptEdits", description: "Auto-approve file edits, prompt for shell commands. Good balance for semi-autonomous use." },
      { label: "default", description: "Prompt for permission on first use of each tool" },
      { label: "dontAsk", description: "Deny all tools not in permissions.allow — requires curated allowlist" }
    ]
  },
  {
    header: "Routines",
    question: "Set up morning and evening routines? (morning brief reviews priorities, evening summarizes the day)",
    options: [
      { label: "Yes", description: "Morning at 08:30, evening at 22:30 (default)" },
      { label: "No", description: "No scheduled routines" }
    ]
  },
  {
    header: "Git scope",
    question: "Track hermit history in git? Sessions, proposals, config become versioned — migration is just git clone.",
    options: [
      { label: "Local", description: "Gitignore hermit state — recommended for teams (default)" },
      { label: "Project", description: "Track hermit state in git — recommended for solo projects. Run /migrate first to catch credentials" }
    ]
  }
]
```

Record: `permission_mode` (default/acceptEdits/plan/dontAsk/bypassPermissions), `scope` (`"local"` or `"project"`). `plan` mode can be typed via Other if needed.

For routines — if Yes: use the config defaults (`active_hours.start = 08:00`, `end = 23:00`) to derive morning = `08:30` and evening = `22:30`. Add to `routines` array:

- `{"id":"morning","schedule":"30 8 * * *","skill":"claude-code-hermit:brief --morning","enabled":true,"run_during_waiting":true}`
- `{"id":"evening","schedule":"30 22 * * *","skill":"claude-code-hermit:brief --evening","enabled":true,"run_during_waiting":true}`
- Always add (regardless of routine choice): `{"id":"heartbeat-restart","schedule":"0 4 * * *","skill":"claude-code-hermit:heartbeat start","run_during_waiting":true,"enabled":true}`
- If no routines: still add heartbeat-restart to the `routines` array (it's infrastructure, not a user routine)
- **Routines auto-register only on always-on launches via `hermit-start.py`.** Interactive `/session` users who want routines active in interactive mode must run `/claude-code-hermit:routines load` themselves. Mention this once at the end of hatch if the operator is running interactively.

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
  "channels": {},
  "remote": true,
  "permission_mode": "acceptEdits",
  "tmux_session_name": "hermit-{project_name}",
  "scope": "local",
  "auto_session": true,
  "ask_budget": false,
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

If channels were configured in Phase 5, populate each channel's entry in the `channels` object using a **relative path** (relative to the project root):

```json
"channels": {
  "discord": {
    "enabled": true,
    "allowed_users": ["<user-id-if-provided>"],
    "dm_channel_id": null,
    "state_dir": ".claude.local/channels/discord",
    "morning_brief": { "enabled": true, "time": "07:00" }
  }
}
```

Omit `allowed_users` if the operator skipped access control. Omit `morning_brief` (or set to `null`) if the operator declined. `dm_channel_id` always starts as `null` — it is learned from the first inbound message.

`state_dir` is the path (relative to project root, or absolute) where the channel plugin writes its token (`.env`) and access config (`access.json`). `hermit-start` resolves relative paths against `cwd` and derives the `*_STATE_DIR` env var from this field at boot — no need to duplicate it in `env`. Without `state_dir`, the plugin defaults to `~/.claude/channels/<plugin>/`, which is lost on Docker container restart.

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

| File                 | Read scope                                   |
| -------------------- | -------------------------------------------- |
| `CLAUDE.md`          | Full file                                    |
| `README.md`          | First 200 lines                              |
| `package.json`       | Full file                                    |
| `requirements.txt`   | Full file                                    |
| `pyproject.toml`     | Full file                                    |
| `Cargo.toml`         | Full file                                    |
| `go.mod`             | Full file                                    |
| `docker-compose.yml` | Full file                                    |
| `.github/workflows/` | List filenames; read the first workflow file |
| `.gitlab-ci.yml`     | First 100 lines                              |
| `Makefile`           | First 50 lines                               |

Also get the directory structure (2 levels deep) to understand the project layout.

Collect findings silently. Do NOT print scan results to the operator.

#### Phase 2 — Draft OPERATOR.md

Using the scan results, write a concise context document. Follow these rules:

1. **Never duplicate CLAUDE.md content.** If CLAUDE.md already covers a topic (testing, conventions, build commands), don't repeat it.
2. **Only include high-confidence inferences.** If the scan clearly reveals something (e.g., package.json shows Node.js, README describes the project), include it. If uncertain, leave it for Phase 3 questions.
3. **Keep it under 50 lines.** OPERATOR.md is loaded every session-start — bloat costs tokens. Write concise prose, not documentation.
4. **No rigid sections required.** Use headers if they help organize, but don't create empty sections. The goal is a useful context document, not a filled-in form.

Write the draft to `.claude-code-hermit/OPERATOR.md`.

#### Phase 3 — Targeted questions (AskUserQuestion batch)

Questions are split into two `AskUserQuestion` calls (max 4 per call). Q1–Q4 are never skipped and always form the first call. Q5–Q7 are conditional and form a second call only if any are included.

**Call 1 — always sent (4 questions):**

| #   | Header      | Question                                                                | Options (+ Other for free text)                  |
| --- | ----------- | ----------------------------------------------------------------------- | ------------------------------------------------ |
| 1   | Focus       | "What should I focus on in this project?"                               | Active development / Stabilization / Exploration |
| 2   | Constraints | "Are there hard rules or areas I should avoid touching without asking?" | None / Config files                              |
| 3   | Approval    | "What actions require your explicit approval before I proceed?"         | Deploys only / Breaking changes / Nothing extra  |
| 4   | Comms style | "How do you prefer I communicate?"                                      | Concise / Detailed / Ask first                   |

Accept any answer including free-text via Other. Expand into OPERATOR.md prose in Phase 4 — don't take options too literally.

**Call 2 — only if any of Q5–Q7 apply (skip conditions below):**

| #   | Header  | Question                                                                                     | Options                                   | Skip if...                                      |
| --- | ------- | -------------------------------------------------------------------------------------------- | ----------------------------------------- | ----------------------------------------------- |
| 5   | CI/CD   | "Any CI/CD quirks I should know about? (flaky tests, required checks, deploy process)"       | Standard / Has quirks                     | No CI config found in Phase 1                   |
| 6   | Testing | "How should I handle testing? (run before commit, specific commands, coverage requirements)" | Before commit / CI handles it / As needed | CLAUDE.md already covers testing                |
| 7   | Team    | "Who's working on this? (solo / small team / large team — and any ownership boundaries)"     | Solo / Small team / Large team            | Skip if Q5 or Q6 is included (batch already ≥2) |

If none of Q5–Q7 apply, skip Call 2 entirely.

Tell the operator before Call 1: "I've scanned your project and drafted OPERATOR.md. A few questions to fill in what I couldn't infer:"

All questions use the `AskUserQuestion` structures defined above. Accept short answers or free-text via Other; expand into prose in Phase 4. If the operator selects "Skip", leaves Other blank, or gives a minimal answer, don't include that topic in OPERATOR.md.

**Hermit extension:** If a hermit was activated in step 3 and provides a file at `state-templates/OPERATOR-QUESTIONS.md`, read it and append those questions to Call 2 (or start a Call 3 if Call 2 is already at 4).

#### Phase 4 — Write final OPERATOR.md

Incorporate the operator's answers into the draft:

- Weave answers into the document as concise prose
- Use headers only where they add clarity — don't force a section for every answer
- Strip the HTML comment from the template (replace with actual content)
- Keep the document under 50 lines total
- For hermit-specific context, append after the core content

Write the final version to `.claude-code-hermit/OPERATOR.md`.

#### Phase 5 — Confirm

Tell the operator: "OPERATOR.md is ready. You can review it at `.claude-code-hermit/OPERATOR.md`. Refine anytime — just tell me what changed."

### 6. Append session discipline to CLAUDE.md

- Check if `CLAUDE.md` exists at the project root
- If it exists: check if it already contains `claude-code-hermit: Session Discipline`
  - If yes: ask with `AskUserQuestion` (header: "CLAUDE.md") — options: **Yes — replace** (update to latest) / **No — keep** (preserve current, default)
    - If "Yes — replace": remove everything between `<!-- claude-code-hermit: Session Discipline -->` and `<!-- /claude-code-hermit: Session Discipline -->` (inclusive), then append the fresh contents of `${CLAUDE_SKILL_DIR}/../../state-templates/CLAUDE-APPEND.md`
    - If "No — keep": skip
  - If no: read `${CLAUDE_SKILL_DIR}/../../state-templates/CLAUDE-APPEND.md` and append its contents to the end of CLAUDE.md
- If CLAUDE.md doesn't exist: create it with the append block as the initial content

If a hermit was activated in step 3, also append its CLAUDE-APPEND.md here (using the same skip/overwrite logic if its marker already exists).

### 7. Update .gitignore

Use the `scope` value recorded in Phase 6:

- `"project"` → use `${CLAUDE_SKILL_DIR}/../../state-templates/GITIGNORE-APPEND-PROJECT.txt`
- `"local"` (default) → use `${CLAUDE_SKILL_DIR}/../../state-templates/GITIGNORE-APPEND.txt`

Select the appropriate template, then:

- If `.gitignore` exists: check if it already contains `.claude/cost-log.jsonl` (local template) or `.env` (project template)
  - If the marker is already present: skip
  - If not: append the template contents
- If `.gitignore` doesn't exist: create it with the template contents

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
      "Bash(node */scripts/append-metrics.js*)",
      "Bash(node */scripts/generate-summary.js*)",
      "Bash(node */scripts/update-reflection-state.js*)",
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
4. If permissions need to be added: show the operator the list of permissions to add and ask with `AskUserQuestion` (header: "Hook perms") — options: **Yes — add** (merge so hooks run without prompting, default) / **No — skip** (you'll be prompted during sessions).
5. If the operator confirms: merge into the existing `permissions.allow` array (never remove existing entries), write back
6. If the operator declines: skip, and note: "You may be prompted to approve hook commands during sessions. Run `/claude-code-hermit:hermit-settings permissions` to add them later."

### 9. Generate deny patterns (AskUserQuestion, single question)

Add safety deny rules to `.claude/settings.json` `permissions.deny` to prevent destructive operations.

```
questions: [
  {
    header: "Safety rules",
    question: "Planning always-on operation (Docker/tmux)? This determines which deny rules to apply.",
    options: [
      { label: "Yes — hardened", description: "Adds git push, npm publish, and unattended-operation protections" },
      { label: "No — minimal", description: "Blocks destructive commands and credential exposure (default)" },
      { label: "Skip", description: "No deny rules — add later in settings.json" }
    ]
  }
]
```

- If **hardened** (always-on): default + always-on additions (excluding docker/kubectl/ssh — valid in devops contexts on host). Canonical source: `state-templates/deny-patterns.json`.
  ```json
  "deny": [
    "Bash(rm -rf *)",
    "Bash(chmod 777*)",
    "Bash(*sudo *)",
    "Bash(*> /etc/*)",
    "Bash(curl * | bash*)",
    "Bash(wget * | bash*)",
    "Bash(env)",
    "Bash(printenv)",
    "Bash(cat .env*)",
    "Bash(cat */.env*)",
    "Bash(cat ~/.ssh/*)",
    "Bash(cat ~/.aws/*)",
    "Bash(*API_KEY*)",
    "Bash(*SECRET*)",
    "Bash(*TOKEN*)",
    "Bash(npm publish*)",
    "Bash(git push --force*)",
    "Bash(git push origin main*)",
    "Bash(git reset --hard*)",
    "Bash(*--no-verify*)"
  ]
  ```
- If **minimal** (default): default set only.
  ```json
  "deny": [
    "Bash(rm -rf *)",
    "Bash(chmod 777*)",
    "Bash(*sudo *)",
    "Bash(*> /etc/*)",
    "Bash(curl * | bash*)",
    "Bash(wget * | bash*)",
    "Bash(env)",
    "Bash(printenv)",
    "Bash(cat .env*)",
    "Bash(cat */.env*)",
    "Bash(cat ~/.ssh/*)",
    "Bash(cat ~/.aws/*)",
    "Bash(*API_KEY*)",
    "Bash(*SECRET*)",
    "Bash(*TOKEN*)"
  ]
  ```
- If **skip**: note: "You can add deny rules later in .claude/settings.json under permissions.deny."

Merge selected rules into existing `permissions.deny` (never remove existing entries), write back.

Do NOT include `Bash(docker *)`, `Bash(kubectl *)`, `Bash(ssh *)` in hatch — these are valid in devops contexts on the host. Docker-setup includes them because the container should not spawn child containers or SSH out.

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
  1. Run /reload-plugins to pick up newly installed plugins in this session
  2. For always-on mode: /claude-code-hermit:docker-setup (Recommended) or .claude-code-hermit/bin/hermit-start (requires tmux)
  3. If you just want to try it out: /claude-code-hermit:session
  4. Refine OPERATOR.md anytime — just tell me what changed
  5. Change settings with /claude-code-hermit:hermit-settings
  6. For an Obsidian dashboard: /claude-code-hermit:obsidian-setup

  7. After plugin updates: /claude-code-hermit:hermit-evolve
  8. (If a channel was configured and you are not running via docker) Activate it: /claude-code-hermit:channel-setup
  9. To troubleshoot any setup issues run /claude-code-hermit:smoke-test

```
