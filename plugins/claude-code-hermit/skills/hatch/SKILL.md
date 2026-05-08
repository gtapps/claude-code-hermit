---
name: hatch
description: Initializes the autonomous agent in the current project. Creates the state directory, templates, OPERATOR.md, and config.json. Appends session discipline to CLAUDE.md. Detects installed hermits. Run once per project, like git init.
---

# Initialize Autonomous Agent

Set up the autonomous agent for this project. This creates the per-project state directory, configures the project for session-based work, and optionally activates hermits.

## Plan

### 1. Check if already initialized

Check if `.claude-code-hermit/` exists in the current project.

- If it exists and has content: inform the operator that the agent is already initialized. Ask if they want to reinitialize (which resets templates but preserves sessions, proposals, config, and OPERATOR.md). Record the choice as `is_reinit` (true if operator opted to reinitialize).
- If it doesn't exist: `is_reinit = false`, proceed with initialization.

### 1.5. Pre-flight (silent — no operator interaction)

Before the setup-mode gate or any file writes, gather context silently. Run all commands in parallel where possible:

1. **Auto-detect language and timezone**:
   - Language: `echo $LANG | cut -d_ -f1` (fallback: `en`)
   - Timezone: `cat /etc/timezone 2>/dev/null || timedatectl show -p Timezone --value 2>/dev/null || date +%Z` (fallback: `UTC`)

2. **Silent hermit detection** (the silent half of Step 3 — split out so it's available before the mode gate without an operator prompt):
   - Run: `claude plugin list --json`
   - Apply the **project-or-local + enabled filter**:
     - Keep `enabled == true` AND (`scope == "project"` OR `scope == "local"`) AND `projectPath` equals the current project root.
     - Drop user-scope, managed-scope, disabled, and cross-project entries.
   - For each surviving entry, parse the plugin name from `id` (substring left of `@`). Keep entries whose plugin name contains "hermit" but is NOT "claude-code-hermit".
   - Stash the resulting list as `detected_hermits`. Each entry must carry: `plugin` (id left of `@`), `id` (full JSON field), `marketplace_name` (id right of `@`), `installPath` (JSON `installPath` field — Step 3 reads `state-templates/CLAUDE-APPEND.md` and `plugin.json` from this path directly).
   - Note: this is intentionally restrictive. A hermit installed at user scope (a personal default across projects) does NOT auto-detect — operator can install it at project scope and re-run, or activate via `/hermit-settings`.

3. **Print one summary line** so the operator sees what was detected:

   > Initializing hermit in `<project-name>`. Detected: language=<lang>, timezone=<tz>, hermit candidates=<N> (<comma-separated names or "none">).

### 1.6. Setup mode gate

**If `is_reinit == true`: skip this gate entirely and run Advanced** — Quick is for first-time install. Re-init operators have existing customizations to preserve, and Advanced's merge logic is the right tool. Quick re-running on an existing config would risk destructive overwrites of operator-tuned fields.

Otherwise, ask:

```
questions: [
  {
    header: "Setup mode",
    question: "How would you like to configure hermit?",
    options: [
      { label: "Quick", description: "Sensible defaults, ~5 questions, ~3 min. Tweak via /hermit-settings later." },
      { label: "Advanced", description: "Full wizard — every option exposed (~15 questions, ~15 min)." }
    ]
  }
]
```

Branch on choice:
- **Advanced** → continue to Step 2 file writes, then Step 3 hermit activation prompt, then Step 4 setup wizard.
- **Quick** → continue to Step 2 file writes, then jump to Section "Quick Branch" (after Step 9).

Both branches share Steps 2 (file writes) and 5-9 (config write, CLAUDE.md/.gitignore/settings, deny patterns, report). Quick replaces Steps 3-4 with the Quick Branch turns described later.

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
│   ├── update-history.jsonl
│   └── micro-proposals.json
├── raw/
│   └── .archive/
├── compiled/
├── bin/
│   ├── hermit-attach
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
- `.claude-code-hermit/state/update-history.jsonl`: empty file — append-only log of `hermit-docker update` runs

- Read the template files from `${CLAUDE_SKILL_DIR}/../../state-templates/`
- Copy `alert-state.json.template` → `.claude-code-hermit/state/alert-state.json`
- Copy `micro-proposals.json.template` → `.claude-code-hermit/state/micro-proposals.json`
- Copy `SHELL.md.template`, `SESSION-REPORT.md.template`, `PROPOSAL.md.template` into `templates/`
- **OPERATOR.md guard:** If `.claude-code-hermit/OPERATOR.md` already exists, do NOT copy the template over it. Remember this fact as `operator_existed = true` for use in step 5a. If it does not exist, copy `OPERATOR.md` from the templates into the state directory root.
- Copy `HEARTBEAT.md.template` → `.claude-code-hermit/HEARTBEAT.md` (the operator's editable checklist)
- Copy `IDLE-TASKS.md.template` → `.claude-code-hermit/IDLE-TASKS.md` (the operator's idle task list)
- Copy `bin/hermit-attach`, `bin/hermit-docker`, `bin/hermit-run`, `bin/hermit-start`, `bin/hermit-stop`, and `bin/hermit-status` from `${CLAUDE_SKILL_DIR}/../../state-templates/bin/` into `.claude-code-hermit/bin/`. Ensure they are executable (`chmod +x`).
- Copy `knowledge-schema.md.template` → `.claude-code-hermit/knowledge-schema.md` (the operator's behavioral schema for domain outputs).

### 3. Hermit activation prompt (Advanced branch only)

**Quick mode handles activation in Quick Turn 1 — skip this entire step in the Quick branch.**

Use the `detected_hermits` list cached in Step 1.5 (no re-globbing).

If the list is non-empty:
- Present the candidates and ask: "Activate a hermit for this project?"
- If the operator selects one: record the full entry from `detected_hermits` as `activated_hermit` (carries `plugin`, `id`, `marketplace_name`, `installPath`).
  - Read `<activated_hermit.installPath>/state-templates/CLAUDE-APPEND.md` and append it to the target project's CLAUDE.md (after the core append in step 5).
  - Read `<activated_hermit.installPath>/.claude-plugin/plugin.json`: if it declares a `hermit.boot_skill` field (e.g. `"/claude-code-homeassistant-hermit:ha-boot"`), record it for step 5 to write as `boot_skill` in `config.json`. This replaces the default `/claude-code-hermit:session` bootstrap so the domain hermit's custom boot logic fires on every always-on launch. If the field is absent, leave `boot_skill` unset (core behavior).
- If the list is empty or the operator declines: skip.

### 4. Setup wizard

Collect project preferences in 4–5 interactions. Use `AskUserQuestion` for all questions. Every question requires 2-4 `options` — users can always type free text via the auto-provided "Other" option.

#### Phase 1 — Auto-detect (already done in Step 1.5)

Step 1.5 already ran the language/timezone detection silently. Reuse those values — do not re-run the commands.

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

Before calling `AskUserQuestion`, print this one-line preamble to the operator:

> All are official Anthropic plugins from the `claude-plugins-official` marketplace (https://claude.com/plugins).

Then ask:

```
questions: [
  {
    header: "Plugins",
    question: "Which recommended plugins should be installed?",
    options: [
      { label: "claude-code-setup", description: "Analyzes codebase, recommends automations (skills, hooks, MCP servers, subagents)" },
      { label: "claude-md-management", description: "Audits and improves CLAUDE.md files — grades quality, proposes fixes" },
      { label: "skill-creator", description: "Builds and refines new skills from proposals" },
      { label: "feature-dev", description: "Designs, explores, and reviews code for accepted-PROP implementation work" }
    ],
    multiSelect: true
  }
]
```

Note: `multiSelect: true` is intentional — all four plugins can be selected at once.

- All plugins are selected by default — deselect to skip
- If no plugins are selected, skip all plugin installs
- For each selected plugin, install it immediately:
  `claude plugin install <plugin>@claude-plugins-official --scope project`

For each accepted plugin, also add the corresponding `scheduled_checks` entries to config.json:

- `claude-code-setup` → `{"id":"automation-recommender","plugin":"claude-code-setup","skill":"/claude-code-setup:claude-automation-recommender","enabled":true,"trigger":"interval","interval_days":7}`
- `claude-md-management` → two entries:
  - `{"id":"md-audit","plugin":"claude-md-management","skill":"/claude-md-management:claude-md-improver","enabled":true,"trigger":"interval","interval_days":7}`
  - `{"id":"md-revise","plugin":"claude-md-management","skill":"/claude-md-management:revise-claude-md","enabled":true,"trigger":"session"}`
- `skill-creator` → no entry (event-driven via proposal-act, not scheduled)
- `feature-dev` → no entry (manual on-demand via /feature-dev:feature-dev, not scheduled)

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

  > **Channel preference saved.** Activation depends on how you run hermit:
  >
  > - **Docker (always-on):** `/claude-code-hermit:docker-setup` configures the token and pairing inside the container.
  > - **tmux (always-on, host):** boot with `.claude-code-hermit/bin/hermit-start` (passes `--channels` automatically), then run `/claude-code-hermit:channel-setup` to set the token and pair.
  > - **Interactive (just trying it):** run `/claude-code-hermit:channel-setup` for token + pairing, then restart with `claude --channels plugin:<channel>@claude-plugins-official` so the channel is active in your session.
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
      { label: "auto", description: "Classifier-reviewed autonomy — each action reviewed before it runs. Requires Max, Team, or Enterprise plan (not Pro/Haiku)." },
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
  }
]
```

Record: `permission_mode` (default/acceptEdits/auto/plan/dontAsk/bypassPermissions). `plan` mode can be typed via Other if needed.

For routines — if Yes: use the config defaults (`active_hours.start = 08:00`, `end = 23:00`) to derive morning = `08:30` and evening = `22:30`. Add to `routines` array:

- `{"id":"morning","schedule":"30 8 * * *","skill":"claude-code-hermit:brief --morning","enabled":true,"run_during_waiting":true}`
- `{"id":"evening","schedule":"30 22 * * *","skill":"claude-code-hermit:brief --evening","enabled":true,"run_during_waiting":true}`
- Always add (regardless of routine choice): `{"id":"heartbeat-restart","schedule":"0 4 * * *","skill":"claude-code-hermit:heartbeat start","run_during_waiting":true,"enabled":true}`
- If no routines: still add heartbeat-restart to the `routines` array (it's infrastructure, not a user routine)
- **Routines auto-register only on always-on launches via `hermit-start.py`.** Interactive `/session` users who want routines active in interactive mode must run `/claude-code-hermit:hermit-routines load` themselves. Mention this once at the end of hatch if the operator is running interactively.

### 5. Write config.json

**Source of truth: `${CLAUDE_SKILL_DIR}/../../state-templates/config.json.template`.** Read this file as the base — it encodes every default field shipped by the current plugin version (including `model`, `always_on`, `chrome`, `monitors`, `compact`, `knowledge`, etc.). Do NOT maintain a parallel inline default object here — anything written inline in this skill drifts the moment a field is added to the template.

**Algorithm:**

1. **Read the template** at `state-templates/config.json.template`.
2. **Substitute scaffold variables**: replace `{project_name}` in `tmux_session_name` with the actual project directory name (e.g. `hermit-my-project`).
3. **Stamp `_hermit_versions`**: read `${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json` for the core version and write it to `_hermit_versions["claude-code-hermit"]`. If a hermit was activated in step 3, also stamp its version under its slug.
4. **Set `boot_skill`**: if a hermit was activated and declared `hermit.boot_skill` in its `plugin.json`, write that value here. Otherwise leave as `null`.
5. **Overlay operator choices** from the wizard:
   - From Phase 2: `agent_name`, `language`, `timezone`, `sign_off`.
   - From Phase 3: `escalation`, `remote`, `ask_budget`, `idle_behavior`.
   - From Phase 5: `channels.<name>` populated per Phase 5 rules (state_dir, allowed_users, morning_brief).
   - From Phase 6: `permission_mode`; append routines (morning, evening) if enabled — heartbeat-restart is already in the template.
   - From Phase 4: append `scheduled_checks` entries per the per-plugin mapping in Phase 4 (only `claude-code-setup` and `claude-md-management` contribute — 3 entries total when both selected; `skill-creator` and `feature-dev` add zero entries).
6. **Write merged object** as `.claude-code-hermit/config.json`.

**Re-initialization merge**: read the existing `.claude-code-hermit/config.json`, then overlay only the fields the wizard asked about. Never strip unknown keys (operators may have added custom fields). Don't re-default fields the operator didn't touch this run.

**Template-only fields** (the wizard never asks about these — they come straight from `config.json.template` and the operator can tune them via `/hermit-settings` later): `model`, `auto_session`, `idle_budget`, `always_on`, `chrome`, `monitors`, `compact`, `heartbeat`, `knowledge`, `env`. The Quick branch and Advanced wizard both leave these at template defaults.

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

<!-- Intentionally NOT in this list: `.claude-code-hermit/config.json`.
     Reading config.json during the draft scan would invite the model to
     mine it for OPERATOR.md content, which is exactly the leak Phase 4's
     scrub exists to prevent. The model is config-blind during draft by
     design; the scrub catches any leakage from CLAUDE.md or Phase 3
     answers. Do not add config.json to this scan. -->

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
2. **Never duplicate `config.json` fields.** `routines`, `channels` (including Discord/Telegram user IDs and `morning_brief`), `permission_mode`, `agent_name`, `sign_off`, `escalation`, `idle_behavior`, `boot_skill`, and `_hermit_versions` are already loaded structurally — do not restate them as prose. OPERATOR.md is for context the model can't infer from config (project focus, constraints, approval gates, comms style, project rationale).
3. **Only include high-confidence inferences.** If the scan clearly reveals something (e.g., package.json shows Node.js, README describes the project), include it. If uncertain, leave it for Phase 3 questions.
4. **Keep it under 50 lines.** OPERATOR.md is loaded every session-start — bloat costs tokens. Write concise prose, not documentation.
5. **No rigid sections required.** Use headers if they help organize, but don't create empty sections. The goal is a useful context document, not a filled-in form.

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

**Hermit extension:** If a hermit was activated in step 3 and provides a file at `<activated_hermit.installPath>/state-templates/OPERATOR-QUESTIONS.md`, read it and append those questions to Call 2 (or start a Call 3 if Call 2 is already at 4).

#### Phase 4 — Write final OPERATOR.md

Incorporate the operator's answers into the draft:

- Weave answers into the document as concise prose
- Use headers only where they add clarity — don't force a section for every answer
- Strip the HTML comment from the template (replace with actual content)
- Keep the document under 50 lines total
- For hermit-specific context, append after the core content

**Before writing, scrub the draft for `config.json` mirroring.** Re-scan and remove any sentence that restates a `config.json` field (routine schedules, Discord/Telegram user IDs, `morning_brief` time, `permission_mode`, `agent_name`, `sign_off`, `escalation`, `idle_behavior`, `boot_skill`). If removing a sentence leaves a paragraph hollow, drop the paragraph. Those facts are already loaded from config.json on every session-start — duplicating them in OPERATOR.md is pure token tax and drifts when config changes.

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

If a hermit was activated in step 3, also append `<activated_hermit.installPath>/state-templates/CLAUDE-APPEND.md` here (using the same skip/overwrite logic if its marker already exists).

### 7. Update .gitignore

Use `${CLAUDE_SKILL_DIR}/../../state-templates/GITIGNORE-APPEND.txt`.

- If `.gitignore` exists: check if it already contains `.claude/cost-log.jsonl` or `.claude-code-hermit/HEARTBEAT.md`
  - If either marker is already present: skip
  - If not: read the template, show the operator the lines that will be appended, and ask with `AskUserQuestion` (header: "Update .gitignore") — options: **Yes — append** (add hermit entries, default) / **No — skip** (you'll manage .gitignore manually). Append only if confirmed.
- If `.gitignore` doesn't exist: read the template, show the operator the lines that will be written, and ask with `AskUserQuestion` (header: "Create .gitignore") — options: **Yes — create** (default) / **No — skip**. Create only if confirmed.

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
      "Bash(node */scripts/heartbeat-precheck.js*)",
      "Bash(node */scripts/reflect-precheck.js*)",
      "Bash(node */scripts/archive-shell.js*)",
      "Bash(node */scripts/run-with-profile.js*)",
      "Bash(node */scripts/evaluate-session.js*)",
      "Bash(node */scripts/append-metrics.js*)",
      "Bash(node */scripts/generate-summary.js*)",
      "Bash(node */scripts/update-reflection-state.js*)",
      "Bash(node */scripts/cron-tz-shift.js*)",
      "Bash(bash -c 'AGENT_DIR=\".claude-code-hermit\"*)",
      "Edit(.claude-code-hermit/**)",
      "Write(.claude-code-hermit/**)"
    ]
  }
}
```

**Why each one:**

- `git diff`, `git status`, `git log` — session-diff.js hook auto-populates `## Changed` in SHELL.md
- `node */scripts/<name>.js` — Stop hooks (cost-tracker, suggest-compact, session-diff, evaluate-session) and precheck scripts (heartbeat-precheck, reflect-precheck), scoped to plugin scripts only
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

---

## Quick Branch

Replaces Steps 3-4 with batched turns + confirm; resumes shared Steps 5-9 after approval. Same files written, same `config.json` fields populated, same OPERATOR.md questionnaire, same security gates, same `.baseline-pending` eligibility — Quick just defaults incidental decisions and shows the resolved bundle before any config writes.

**Entry condition:** Step 1.6 returned `Quick` AND `is_reinit` is `false` (re-init forces Advanced).

### Quick Turn 1 — Hermit activation (conditional)

Only fires if `detected_hermits` from Step 1.5 is non-empty. Same prompt shape as Step 3 of the Advanced branch — uses the cached candidate list, does not re-glob. If multiple hermits detected, list all + Skip. If none, this turn is skipped entirely.

If a hermit is selected: record the full entry from `detected_hermits` as `activated_hermit` (carries `plugin`, `id`, `marketplace_name`, `installPath`). Read `<activated_hermit.installPath>/state-templates/CLAUDE-APPEND.md` and stash for Step 6's CLAUDE.md append. Read `<activated_hermit.installPath>/.claude-plugin/plugin.json` for the `hermit.boot_skill` field and stash for Step 5's config write.

### Quick Turn 2 — Identity batch (one `AskUserQuestion`, 3 questions)

```
questions: [
  {
    header: "Agent name",
    question: "What should I be called?",
    options: [
      { label: "Atlas" },
      { label: "Hermit" },
      { label: "Skip" }
    ]
  },
  {
    header: "Language",
    question: "Primary language?",
    options: [
      { label: "<auto-detected from Step 1.5> (auto-detected)" },
      { label: "<one common alternative — e.g. en if auto = pt, otherwise pt>" }
    ]
  },
  {
    header: "Timezone",
    question: "Timezone?",
    options: [
      { label: "<auto-detected from Step 1.5> (auto-detected)" },
      { label: "UTC" }
    ]
  }
]
```

Record `agent_name` (null if Skip), `language`, `timezone`.

### Quick Turn 3 — Sign-off + Deployment + Channel batch

If a name was given in Turn 2, ask 3 questions (with sign-off). Otherwise ask 2 (drop sign-off).

```
questions: [
  // Conditional — only included if agent_name was set in Turn 2
  {
    header: "Sign-off",
    question: "How should I close messages?",
    options: [
      { label: "{name} out." },
      { label: "-- {initial}." },
      { label: "Skip" }
    ]
  },
  {
    header: "Deployment",
    question: "How will you run hermit?",
    options: [
      { label: "Docker always-on", description: "Recommended. Isolated, auto-restart, channel pairing handled by /docker-setup" },
      { label: "tmux always-on", description: "Persistent on host. Boots via .claude-code-hermit/bin/hermit-start" },
      { label: "Interactive", description: "Just trying it. /session in your terminal" }
    ]
  },
  {
    header: "Channel",
    question: "Notification channel?",
    options: [
      { label: "None" },
      { label: "Discord" },
      { label: "Telegram" }
    ]
  }
]
```

Record `sign_off`, `deployment` (one of `docker` / `tmux` / `interactive`), `channel` (one of `none` / `discord` / `telegram`).

**Derived values from this turn (used in the confirm bundle and Step 5 overlay):**
- `permission_mode`: Docker → `bypassPermissions`, else → `acceptEdits`.
- Deny pattern profile: Docker → hardened (default + always_on), else → minimal (default only). Applied at Step 9 silently.
- `auto-chain target`: see "Quick — auto-chain at end of Step 10" table.

### Quick Turn 4 — OPERATOR.md questionnaire (run "5a. OPERATOR.md onboarding" verbatim)

Run the existing "5a. OPERATOR.md onboarding" step verbatim — same scan, same draft, same Phase 3 questions (Call 1 always + Call 2 conditional per the existing skip-condition rules), same Phase 4 scrub. No changes to scan list, draft logic, or question wording. The questionnaire produces a complete OPERATOR.md before the confirm screen so the operator's answers shape the autonomous-mode context the hermit uses immediately.

### Quick Turn 5 — Confirm bundle

Print the resolved configuration so the operator sees what's about to be written, before any config writes happen:

Print a labeled summary in this shape:

```
Quick setup will apply:
  Identity:    {agent_name}, {language}, {timezone}, sign-off={sign_off}
  Behavior:    escalation=balanced, idle=discover, budget=off, remote=on
  Deployment:  {deployment}, permission={derived}, deny={derived hardened|minimal}
  Plugins:     all 4 installed
  Routines:    morning 08:30, evening 22:30, heartbeat 04:00
  Channel:     {channel or None} (allow-everyone; token + pairing later)
  Hermit ext:  {activated or none}
  Files:       CLAUDE.md, .gitignore, .claude/settings.json
  OPERATOR.md: drafted from scan + your answers (written below)

Customize restarts the wizard from scratch; your Quick answers won't carry over.
```

Ask:

```
questions: [
  {
    header: "Confirm",
    question: "Apply this configuration?",
    options: [
      { label: "Yes", description: "Apply and continue" },
      { label: "Customize", description: "Restart in Advanced (your Quick answers will not carry over)" }
    ]
  }
]
```

- **Customize**: jump to Step 3 of the Advanced branch (no prefill — Advanced restarts from scratch). Discard all Quick answers.
- **Yes**: continue to the shared steps below.

### Quick — silent defaults applied to shared steps

Quick replaces Step 4 entirely and applies these defaults silently at the shared Steps 5-9 (no prompts):

| Source | Field | Quick value |
|---|---|---|
| Advanced Phase 3 equivalent | escalation, remote, ask_budget, idle_behavior | template defaults (balanced, true, false, discover) — don't override |
| Advanced Phase 4 equivalent | plugins + scheduled_checks | install all 4; write 3 scheduled_checks entries per Phase 4 mapping |
| Advanced Phase 4b equivalent | `.baseline-pending` marker | same eligibility check as Advanced |
| Advanced Phase 5 equivalent | channels.<name>.* | state_dir + enabled + dm_channel_id=null; omit allowed_users + morning_brief |
| Advanced Phase 6 equivalent | permission_mode, routines | derived from deployment; routines = morning 08:30 + evening 22:30 + (template) heartbeat 04:00 |
| Step 6 | CLAUDE.md append | apply silently (default "keep" if marker already present) |
| Step 7 | .gitignore append | apply silently |
| Step 8 | .claude/settings.json plugin permissions | merge silently |
| Step 9 | deny patterns | derived profile silently (Docker → hardened, else → minimal) |

### Quick — auto-chain at end of Step 10

After Step 10 prints the standard report, output the next slash command on its own line so Claude Code's harness can pick it up and run it. Map from Turn 3's deployment + channel:

| Deployment | Channel | Output |
|---|---|---|
| Docker | any | `/claude-code-hermit:docker-setup quick` |
| tmux | configured | First print boot command `.claude-code-hermit/bin/hermit-start`, then `/claude-code-hermit:channel-setup` |
| tmux | none | Print boot command `.claude-code-hermit/bin/hermit-start` (no skill chain) |
| Interactive | configured | `/claude-code-hermit:channel-setup`, then `/claude-code-hermit:session` |
| Interactive | none | `/claude-code-hermit:session` |

The `quick` positional arg passed to `docker-setup` tells it to skip its setup-mode gate and run Quick directly (same `quick` arg the operator can use manually). For chained skills with no `quick` arg (channel-setup, session), they run their normal interactive flows.

**Operator can interrupt** before the chained skill executes by hitting Esc — at which point they can re-run any of the printed slash commands later.

---

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
  .claude-code-hermit/bin/ (hermit-attach, hermit-start, hermit-stop, hermit-status)
  .claude-code-hermit/config.json

Identity:
  Agent name:      Atlas
  Language:        pt (auto-detected)
  Timezone:        Europe/Lisbon (auto-detected)
  Escalation:      balanced
  Sign-off:        Atlas out.

Config:
  Plugins:         claude-code-setup, claude-md-management, skill-creator, feature-dev
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

  Pick how you'll run hermit:
    A. Docker always-on (recommended)   /claude-code-hermit:docker-setup
    B. tmux always-on (host)            .claude-code-hermit/bin/hermit-start
    C. Interactive — try it now         /claude-code-hermit:session

  After picking:
    - /reload-plugins                       load newly installed plugins in this session
    - /claude-code-hermit:channel-setup     if a channel was configured AND you chose B or C
                                              (A handles channels inside docker-setup)
    - /claude-code-hermit:obsidian-setup    optional Obsidian dashboard

  Anytime:
    - /claude-code-hermit:hermit-settings   change settings
    - /claude-code-hermit:hermit-evolve     after plugin updates
    - /claude-code-hermit:smoke-test        troubleshoot setup
    - Refine OPERATOR.md — just tell me what changed

```

**Quick-mode report adjustment**: collapse "Pick how you'll run hermit" to one line confirming Turn 3's deployment + channel, then emit the auto-chain slash command(s) per the mapping in "Quick — auto-chain at end of Step 10". Keep the "Anytime:" block unchanged.
