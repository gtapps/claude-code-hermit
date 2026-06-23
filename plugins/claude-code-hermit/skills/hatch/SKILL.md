---
name: hatch
description: Initializes the autonomous agent in the current project. Creates the state directory, templates, OPERATOR.md, and config.json. Appends session discipline to CLAUDE.md. Detects installed hermits. Run once per project, like git init.
---

# Initialize Autonomous Agent

Set up the autonomous agent for this project. This creates the per-project state directory, configures the project for session-based work, and optionally activates hermits.

## Plan

### 1. Check if already initialized

Check whether `.claude-code-hermit/config.json` exists in the current project. That file (written at Step 5) is the authoritative "already initialized" signal — not the bare presence of the `.claude-code-hermit/` directory. A lone `state/hatch-resume.json` marker (written by a domain hatch before it delegates here), an empty `state/` tree, or a half-written tree left by an aborted prior run all count as **not** initialized.

- If `.claude-code-hermit/config.json` exists: inform the operator that the agent is already initialized. Ask if they want to reinitialize (which resets templates but preserves sessions, proposals, config, and OPERATOR.md). Record the choice as `is_reinit` (true if operator opted to reinitialize).
- Otherwise: `is_reinit = false`, proceed with initialization.

### 1.5. Pre-flight (silent — no operator interaction)

Before the setup-mode gate or any file writes, gather context silently. Run all commands in parallel where possible:

1. **Auto-detect language and timezone**:
   - Language: `echo $LANG | cut -d_ -f1` (fallback: `en`)
   - Timezone: `cat /etc/timezone 2>/dev/null || timedatectl show -p Timezone --value 2>/dev/null || date +%Z` (fallback: `UTC`)

2. **Silent hermit detection + core scope detection** (split out so it's available before the mode gate without an operator prompt):
   - Run: `claude plugin list --json`
   - **Core scope detection:** From the full output, find all entries where the plugin name (substring of `id` left of `@`) is exactly `claude-code-hermit`, `enabled == true`, and `projectPath` equals the current project root. Apply precedence: if any has `scope == "local"` → `core_install_scope = "local"`; else if any has `scope == "project"` → `core_install_scope = "project"`; else if a user-scope entry exists for this plugin (any `projectPath`) → `core_install_scope = "user"`; else → `core_install_scope = null`. Map to `hatch_target`:
     - `core_install_scope == "project"` → `hatch_target = "committed"`
     - `core_install_scope == "local"` → `hatch_target = "local"`
     - `core_install_scope == "user"` or `null` → `hatch_target = "local"` (safer default; operator can override in Advanced)
   - **Sibling hermit detection:** Apply the **project-or-local + enabled filter**:
     - Keep `enabled == true` AND (`scope == "project"` OR `scope == "local"`) AND `projectPath` equals the current project root.
     - Drop user-scope, managed-scope, disabled, and cross-project entries.
   - For each surviving sibling entry, parse the plugin name from `id` (substring left of `@`). Keep entries whose plugin name contains "hermit" but is NOT "claude-code-hermit".
   - Stash the resulting list as `detected_hermits`. Each entry must carry: `plugin` (id left of `@`), `id` (full JSON field), `marketplace_name` (id right of `@`), `installPath` (JSON `installPath` field — Step 3 reads `state-templates/CLAUDE-APPEND.md` and `plugin.json` from this path directly).
   - Note: sibling detection is intentionally restrictive. A hermit installed at user scope does NOT auto-detect — operator can install it at project scope and re-run, or activate via `/hermit-settings`.

3. **Detect git-init eligibility** — run in parallel with items 1–2. Set `git_init_eligible = true` if and only if all three hold:
   - `is_reinit == false`.
   - `git rev-parse --is-inside-work-tree 2>/dev/null` is falsy (not already under version control).
   - `ls -A` of the project root yields only names from this **explicit allowed set**: `.claude-code-hermit`, `.claude`, `.gitignore`, `.worktreeinclude`, `.bash_profile`, `.bashrc`, `.zshrc`, `.zprofile`, `.profile`, `.gitconfig`, `.ripgreprc`. The dotfile entries (`.bash_profile` through `.ripgreprc`) come from the sandbox-dotfile block at the bottom of `state-templates/GITIGNORE-APPEND.txt` — keep those in sync if that block changes.

4. **Print one summary line** so the operator sees what was detected:

   > Initializing hermit in `<project-name>`. Detected: language=<lang>, timezone=<tz>, scope=<project|local|user>, target=<committed|local>, hermit candidates=<N> (<comma-separated names or "none">), git=<fresh|existing|n/a>.

### 1.6. Setup mode gate

**If `is_reinit == true`: skip this gate entirely and run Advanced** — Quick is for first-time install. Re-init operators have existing customizations to preserve, and Advanced's merge logic is the right tool. Quick re-running on an existing config would risk destructive overwrites of operator-tuned fields.

Otherwise, ask:

```
questions: [
  {
    header: "Setup mode",
    question: "How would you like to configure hermit?",
    options: [
      { label: "Quick", description: "Sensible defaults, ~4 questions, ~3 min. Tweak via /hermit-settings later." },
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
│   ├── observations.jsonl
│   ├── update-history.jsonl
│   ├── channel-replies.jsonl
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
└── knowledge-schema.md
```

Run the scaffold script once — it builds the directory tree above and seeds every static file deterministically (this is pure mechanical I/O; the *reasoned* artifacts are written by their own steps):

```
bun ${CLAUDE_PLUGIN_ROOT}/scripts/hatch-scaffold.ts <PROJECT_ROOT> --reinit=<is_reinit>
```

Pass `--reinit=true` only when Step 1 recorded `is_reinit = true`; otherwise `--reinit=false`. The script:

- Seeds `state/reflection-state.json` (with a live ISO `counters.since`), the empty append-only ledgers `state/routine-metrics.jsonl`, `state/proposal-metrics.jsonl`, `state/observations.jsonl`, `state/update-history.jsonl`, `state/channel-replies.jsonl`, plus `state/alert-state.json`, `state/micro-proposals.json`, the `templates/` files, `HEARTBEAT.md`, `knowledge-schema.md`, `OPERATOR.md`, and copies + `chmod +x` every file under `state-templates/bin/` (enumerated, not hardcoded).
- **Preserves operator/state artifacts** — `OPERATOR.md`, `HEARTBEAT.md`, `knowledge-schema.md`, and every `state/*` file are created only if absent (in both modes), so re-init never clobbers accumulated learning/proposal state or operator edits. `--reinit=true` only refreshes the hermit-owned pristine files (`templates/*`, `bin/*`).
- Never creates `state/pending-close.json` (lazily created by `daily-auto-close` when the midnight routine fires while the operator is active).

Parse the JSON it prints — `{ created, overwritten, preserved, operator_existed }` — and **remember `operator_existed` for Step 5a** (the OPERATOR.md guard).

The reasoned artifacts are NOT scaffolded here: `config.json` (Step 5), the OPERATOR.md *content* draft (Step 5a), and the CLAUDE.local.md / CLAUDE.md block (Step 6) keep their own steps.

- **Seed `state/template-manifest.json`** via `manifest-seed.ts` — records the sha256 pristine-baseline the `hermit-evolve` drift signals depend on. **Deferred to the end of Step 8** (see the seeding sub-step there): the call needs the `bun */scripts/manifest-seed.ts*` permission that Step 8 merges. The source template files are stable, so running it after the permission merge records the same hashes it would record now. Do not run it here.

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

#### Phase 3 — Behavior (AskUserQuestion batch, 3 questions)

Ask all three in a single `AskUserQuestion` call (the option marked `(default)` is the Recommended pre-selection):

| Header | Question | Options (`label`: description) |
|---|---|---|
| Autonomy | How autonomous should your assistant be? | `Balanced`: act on routine tasks, escalate significant changes (default) / `Conservative`: ask before most non-trivial actions / `Autonomous`: proceed unless blocked, minimize interruptions |
| Remote ctrl | Enable remote control via claude.ai/code? | `Yes`: connect from claude.ai/code or phone (default) / `No`: local terminal only |
| Idle | What should hermit do when idle between tasks? | `Discover`: maintenance and reflection (default) / `Wait`: passive, only check for new tasks and messages |

Record: `escalation` (conservative/balanced/autonomous), `remote` (true/false), `idle_behavior` (wait/discover).

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
- For each selected plugin, install it immediately at the hermit's scope (`core_install_scope` from Step 2; fall back to `project` when null):
  `claude plugin install <plugin>@claude-plugins-official --scope <core_install_scope>`

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

- **If None:** record `channels: {}`. Proceed to Phase 6. Do not ask channel follow-ups.
- **If Discord or Telegram:** create a channel entry under the `channels` object (e.g., `channels.discord`). Boot script maps the key to the full plugin identifier. Then ask follow-ups below.
- Channel plugins require Bun and manual setup (bot creation, token, pairing). After saving the preference to `config.json`, note:

  > **Channel preference saved.** Activation depends on how you run hermit:
  >
  > - **Docker (always-on):** `/claude-code-hermit:docker-setup` configures the token and pairing inside the container.
  > - **tmux (always-on, host):** boot with `.claude-code-hermit/bin/hermit-start` (passes `--channels` automatically), then run `/claude-code-hermit:channel-setup` to set the token and pair.
  > - **Interactive (just trying it):** run `/claude-code-hermit:channel-setup` for token + pairing, then restart with `claude --channels plugin:<channel>@claude-plugins-official` so the channel is active in your session.
  > - Full guide: https://code.claude.com/docs/en/channels

**Channel follow-ups (only if Discord or Telegram was selected above — AskUserQuestion batch, 2 questions; the option marked `(default)` is the Recommended pre-selection):**

| Header | Question | Options (`label`: description) |
|---|---|---|
| Access ctrl | Restrict who can send commands via this channel? | `Allow everyone`: no restrictions on who can message (default) / `Restrict`: type your Discord/Telegram user ID via Other |
| Brief | Enable morning brief delivery via channel? | `Yes — 07:00`: daily summary delivered each morning / `No`: no automated brief delivery (default) |

- **Access control:** If "Restrict" and a numeric ID was typed via Other, record in `channels.<channel>.allowed_users` as `["<id>"]`. If "Allow everyone" or no ID provided, omit the key (absent = accept all). Note: "Add more user IDs later with `/claude-code-hermit:hermit-settings channels`. An empty array [] blocks all messages."
- **Morning brief:** If "Yes — 07:00", record as `channels.<channel>.morning_brief: { "enabled": true, "time": "07:00" }`. If "No", omit the key (or set to `null`).

#### Phase 6 — Deployment (AskUserQuestion batch, 3 questions)

The Visibility question uses the scope-derived `hatch_target` to recommend an option. Place the recommended option at index 0 with `(recommended)` in the label so the recommendation is clear:

- If `hatch_target == "local"` (scope=local or scope=user): `.local files` is position 0 with `(recommended)`.
- If `hatch_target == "committed"` (scope=project): `Committed files` is position 0 with `(recommended)`.

```
questions: [
  {
    header: "Permissions",
    question: "Permission mode for Claude Code?",
    options: [
      { label: "auto", description: "**Default.** Classifier-reviewed autonomy — each action reviewed before it runs. Available on Max/Team/Enterprise/API plans with Sonnet 4.6 or Opus 4.6/4.7 (Max → Opus 4.7 only). Not on Pro or Haiku — choose acceptEdits if unsure." },
      { label: "acceptEdits", description: "Auto-approve file edits, prompt for shell commands. Good balance if auto is unavailable on your plan." },
      { label: "default", description: "Prompt for permission on first use of each tool" },
      { label: "dontAsk", description: "Deny all tools not in permissions.allow — requires curated allowlist" },
      { label: "bypassPermissions", description: "No permission prompts. Opt-in for fully unattended Docker-isolated hermits that cannot tolerate any pause." }
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
    header: "Visibility",
    question: "Where should hermit-personal hatch outputs live? (CLAUDE.md block, hook permissions, deny patterns)",
    // Build options with recommended at index 0 based on hatch_target:
    // When hatch_target == "local":
    //   options: [
    //     { label: ".local files (recommended)", description: "Gitignored — operator-personal. Plugin installed at <scope> scope." },
    //     { label: "Committed files", description: "Shared with teammates. Override scope-derived default." }
    //   ]
    // When hatch_target == "committed":
    //   options: [
    //     { label: "Committed files (recommended)", description: "Shared with teammates. Plugin installed at project scope." },
    //     { label: ".local files", description: "Gitignored — operator-personal. Override scope-derived default." }
    //   ]
  }
]
```

The recommended option is always at index 0 with `(recommended)` in the label. When `hatch_target == "local"`, `.local files` is index 0; when `hatch_target == "committed"`, `Committed files` is index 0. Substitute `<scope>` with the actual `core_install_scope` value.

Record the operator's Visibility choice as `hatch_target` (overrides scope-derived default if different).

Record: `permission_mode` (auto/acceptEdits/default/dontAsk/bypassPermissions/plan). `plan` mode can be typed via Other if needed.

For routines — if Yes: use the config defaults (`active_hours.start = 08:00`, `end = 23:00`) to derive morning = `08:30` and evening = `22:30`. Add to `routines` array:

- `{"id":"morning","schedule":"30 8 * * *","skill":"claude-code-hermit:brief --morning","enabled":true,"run_during_waiting":true}`
- `{"id":"evening","schedule":"30 22 * * *","skill":"claude-code-hermit:brief --evening","enabled":true,"run_during_waiting":true}`
- Always add (regardless of routine choice): `{"id":"heartbeat-restart","schedule":"0 4 * * *","skill":"claude-code-hermit:heartbeat start","run_during_waiting":true,"enabled":true}`
- If no routines: still add heartbeat-restart to the `routines` array (it's infrastructure, not a user routine)
- **Routines auto-register only on always-on launches via `hermit-start.ts`.** Interactive `/session` users who want routines active in interactive mode must run `/claude-code-hermit:hermit-routines load` themselves. Mention this once at the end of hatch if the operator is running interactively.

### 5. Write config.json

**Source of truth: `${CLAUDE_SKILL_DIR}/../../state-templates/config.json.template`.** Read this file as the base — it encodes every default field shipped by the current plugin version (including `model`, `always_on`, `chrome`, `monitors`, `compact`, `knowledge`, etc.). Do NOT maintain a parallel inline default object here — anything written inline in this skill drifts the moment a field is added to the template.

**Algorithm:**

1. **Read the template** at `state-templates/config.json.template`.
2. **Substitute scaffold variables**: replace `{project_name}` in `tmux_session_name` with the actual project directory name (e.g. `hermit-my-project`).
3. **Stamp `_hermit_versions`**: read `${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json` for the core version and write it to `_hermit_versions["claude-code-hermit"]`. If a hermit was activated in step 3, also stamp its version under its slug.
4. **Set `boot_skill`**: if a hermit was activated and declared `hermit.boot_skill` in its `plugin.json`, write that value here. Otherwise leave as `null`.
   **Set `shutdown_skill`**: leave as `null` — operator sets it via config edit if they run always-on services that need stopping on full close.
5. **Overlay operator choices** from the wizard:
   - From Phase 2: `agent_name`, `language`, `timezone`, `sign_off`.
   - From Phase 3: `escalation`, `remote`, `idle_behavior`.
   - From Phase 5: `channels.<name>` populated per Phase 5 rules (state_dir, allowed_users, morning_brief). Do **not** derive `push_notifications` from the channel choice — leave it at the template default (`true`) on fresh hatch. The runtime channel-first/push-fallback guard in CLAUDE-APPEND.md already prevents double-notification (push only fires when a channel is unreachable or absent). On re-init (`is_reinit == true`), leave the existing `push_notifications` value untouched, same as any field the wizard didn't ask about, preserving a manual `/hermit-settings push-notifications` toggle across re-inits.
   - From Phase 6: `permission_mode`; append routines (morning, evening) if enabled — heartbeat-restart is already in the template.
   - From Phase 4: append `scheduled_checks` entries per the per-plugin mapping in Phase 4 (only `claude-code-setup` and `claude-md-management` contribute — 3 entries total when both selected; `skill-creator` and `feature-dev` add zero entries).
6. **Write merged object** as `.claude-code-hermit/config.json`.

**Re-initialization merge**: read the existing `.claude-code-hermit/config.json`, then overlay only the fields the wizard asked about. Never strip unknown keys (operators may have added custom fields). Don't re-default fields the operator didn't touch this run.

**Template-only fields** (the wizard never asks about these — they come straight from `config.json.template` and the operator can tune them via `/hermit-settings` later): `model`, `auto_session`, `always_on`, `chrome`, `monitors`, `compact`, `heartbeat`, `knowledge`, `env`, `quality_gate`, `watchdog`, `reflection`, `post_close_clear`. The Quick branch and Advanced wizard both leave these at template defaults.

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
2. Run: `bun ${CLAUDE_PLUGIN_ROOT}/scripts/apply-settings.ts .claude/settings.local.json task-id hermit-{project_basename}`
   (Creates the file if absent; merges the value into `env`, preserving all other keys.)

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
2. **Never duplicate `config.json` fields.** `routines`, `channels` (including Discord/Telegram user IDs and `morning_brief`), `permission_mode`, `agent_name`, `sign_off`, `escalation`, `idle_behavior`, `boot_skill`, `shutdown_skill`, and `_hermit_versions` are already loaded structurally — do not restate them as prose. OPERATOR.md is for context the model can't infer from config (project focus, constraints, approval gates, comms style, project rationale).
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

**Before writing, scrub the draft for `config.json` mirroring.** Re-scan and remove any sentence that restates a `config.json` field (routine schedules, Discord/Telegram user IDs, `morning_brief` time, `permission_mode`, `agent_name`, `sign_off`, `escalation`, `idle_behavior`, `boot_skill`, `shutdown_skill`). If removing a sentence leaves a paragraph hollow, drop the paragraph. Those facts are already loaded from config.json on every session-start — duplicating them in OPERATOR.md is pure token tax and drifts when config changes.

Write the final version to `.claude-code-hermit/OPERATOR.md`.

#### Phase 5 — Confirm

Tell the operator: "OPERATOR.md is ready. You can review it at `.claude-code-hermit/OPERATOR.md`. Refine anytime — just tell me what changed."

### 6. Append session discipline to CLAUDE.md or CLAUDE.local.md

The target file is determined by `hatch_target` (computed in Step 1.5):
- `hatch_target == "local"` → write to `CLAUDE.local.md` (gitignored, operator-personal)
- `hatch_target == "committed"` → write to `CLAUDE.md` (committed, current behavior)

Perform the idempotency check across both files first: if the marker `claude-code-hermit: Session Discipline` exists in the non-target file, surface a conflict — ask operator: **Move to target file** (diff-and-confirm) / **Keep both** (warn that both load) / **Skip conflict**. Never silently leave duplicate markers.

For the target file (the block is static — **copy it with `cat`, never regenerate it by hand**):
- If it exists: check if it already contains `claude-code-hermit: Session Discipline`
  - If yes: ask with `AskUserQuestion` (header: "CLAUDE block") — options: **Yes — replace** (update to latest) / **No — keep** (preserve current, default)
    - If "Yes — replace": remove the existing hermit block (from its `<!-- claude-code-hermit: Session Discipline -->` marker — and any blank line / `---` separator immediately above it — through the end of that block; the template carries no closing marker, so identify the block end by content), then re-append the fresh template: `cat "${CLAUDE_SKILL_DIR}/../../state-templates/CLAUDE-APPEND.md" >> <target>`
    - If "No — keep": skip
  - If no: `cat "${CLAUDE_SKILL_DIR}/../../state-templates/CLAUDE-APPEND.md" >> <target>`
- If the target file doesn't exist: `cat "${CLAUDE_SKILL_DIR}/../../state-templates/CLAUDE-APPEND.md" > <target>`

If a hermit was activated in step 3, also append `<activated_hermit.installPath>/state-templates/CLAUDE-APPEND.md` to the same target file (using the same skip/overwrite logic if its marker already exists).

### 7. Update .gitignore

Use `${CLAUDE_SKILL_DIR}/../../state-templates/GITIGNORE-APPEND.txt`.

Read the template. Determine which lines are missing from the project's `.gitignore` (per-line idempotent check — do not re-add lines already present). Only the missing lines are candidates to append.

- If `.gitignore` exists and candidate lines are non-empty: show the operator only the missing lines that will be appended, and ask with `AskUserQuestion` (header: "Update .gitignore") — options: **Yes — append** (add missing entries, default) / **No — skip** (you'll manage .gitignore manually). Append only if confirmed.
- If `.gitignore` exists and no lines are missing: skip silently.
- If `.gitignore` doesn't exist: show the operator the full template that will be written, and ask with `AskUserQuestion` (header: "Create .gitignore") — options: **Yes — create** (default) / **No — skip**. Create only if confirmed.

### 7a. Update .worktreeinclude

Use `${CLAUDE_SKILL_DIR}/../../state-templates/WORKTREEINCLUDE-APPEND.txt`.

The file contains a managed block bounded by marker comments (`# >>> claude-code-hermit ...` / `# <<< claude-code-hermit >>>`). This block carries read-only hermit context (OPERATOR.md, compiled/) into `claude --worktree` worktrees. **Write it unconditionally — no git-repo gate.** A `.worktreeinclude` in a non-git project is harmless and ready when the operator later runs `git init`.

- If `.worktreeinclude` is absent: show the operator the template that will be written, and ask with `AskUserQuestion` (header: "Create .worktreeinclude") — options: **Yes — create** (default) / **No — skip**. Create only if confirmed.
- If `.worktreeinclude` exists and the `# >>> claude-code-hermit` marker is already present: skip silently.
- If `.worktreeinclude` exists and the marker is absent: append the managed block (preceded by a blank line) — ask with `AskUserQuestion` (header: "Update .worktreeinclude") — options: **Yes — append** (default) / **No — skip**. Append only if confirmed.

### 7.5. Initialize git repo (fresh dirs only)

**Skip this step entirely if `git_init_eligible` is false.** Skip silently with no operator interaction.

If `git_init_eligible`:

- **Advanced branch:** ask with `AskUserQuestion` (header: "Git init") — "Initialize a local git repo here? The hermit's build output will be tracked; its internal churn (sessions, proposals, state) stays gitignored." — options: **Yes** (default) / **No**. Run `git init` only on Yes.
- **Quick branch:** announced in the Quick Turn 5 confirm bundle and run as part of the shared steps only after the operator confirms (see "Quick — silent defaults applied to shared steps" table — Step 7.5 row). Never auto-runs before confirmation.

When run, `git init` creates the repo at the project root. The `.gitignore` written in Step 7 is immediately in effect.

### 8. Ensure plugin permissions in settings file

The plugin's hooks and boot scripts require specific Bash permissions to run without prompting. The target settings file is determined by `hatch_target`:
- `hatch_target == "local"` → merge into `.claude/settings.local.json` (gitignored)
- `hatch_target == "committed"` → merge into `.claude/settings.json` (committed, current behavior)

Merge these into the target file:

**Required permissions:**

```json
{
  "permissions": {
    "allow": [
      "Bash(git diff:*)",
      "Bash(git status:*)",
      "Bash(git log:*)",
      "Bash(bun */scripts/cost-tracker.ts*)",
      "Bash(bun */scripts/suggest-compact.ts*)",
      "Bash(bun */scripts/heartbeat-precheck.ts*)",
      "Bash(bun */scripts/reflect-precheck.ts*)",
      "Bash(bun */scripts/archive-shell.ts*)",
      "Bash(bun */scripts/run-with-profile.ts*)",
      "Bash(bun */scripts/evaluate-session.ts*)",
      "Bash(bun */scripts/append-metrics.ts*)",
      "Bash(bun */scripts/generate-summary.ts*)",
      "Bash(bun */scripts/update-reflection-state.ts*)",
      "Bash(bun */scripts/cron-tz-shift.ts*)",
      "Bash(bun */scripts/evolve-plan.ts*)",
      "Bash(bun */scripts/evolve-finalize.ts*)",
      "Bash(bun */scripts/manifest-seed.ts*)",
      "Bash(bun */scripts/apply-settings.ts*)",
      "Bash(bash -c 'AGENT_DIR=\".claude-code-hermit\"*)",
      "Edit(.claude-code-hermit/**)",
      "Write(.claude-code-hermit/**)"
    ]
  }
}
```

**Why each one:**

- `git diff`, `git status`, `git log` — session-diff.ts hook auto-populates `## Changed` in SHELL.md
- `bun */scripts/<name>.ts` — Stop hooks (cost-tracker, suggest-compact, session-diff, evaluate-session) and precheck scripts (heartbeat-precheck, reflect-precheck), scoped to plugin scripts only. Includes `manifest-seed.ts`, which the seeding sub-step below runs to write the template-manifest baseline (deferred from Step 2 so the permission is in place first)
- `bash -c 'AGENT_DIR=...` — SessionStart hook that loads session context on every startup
- `Edit`, `Write` on `.claude-code-hermit/**` — heartbeat appends to SHELL.md, increments config.json tick counter, and skills update session state without prompting

**Steps:**

1. If the target settings file exists: read it and identify which required permissions are missing from `permissions.allow`
2. If the target settings file does not exist: all permissions are missing
3. If no permissions are missing: skip silently
4. If permissions need to be added: show the operator the list of permissions to add and ask with `AskUserQuestion` (header: "Hook perms") — options: **Yes — add** (merge so hooks run without prompting, default) / **No — skip** (you'll be prompted during sessions).
5. If the operator confirms: run `bun ${CLAUDE_PLUGIN_ROOT}/scripts/apply-settings.ts <resolved-settings-file> allow`
   (Merges the full allow-list additively; never removes existing entries.)
6. If the operator declines: skip, and note: "You may be prompted to approve hook commands during sessions. Run `/claude-code-hermit:hermit-settings permissions` to add them later."

**Seed `state/template-manifest.json`** (deferred from Step 2 — now that the `bun */scripts/manifest-seed.ts*` permission is in place). It records the sha256 pristine-baseline that the `hermit-evolve` drift signals depend on. **Do not hand-compute the hashes** (an LLM cannot sha256 reliably; the script makes them correct by construction). Read the current plugin version from `${CLAUDE_SKILL_DIR}/../../.claude-plugin/plugin.json`, then run `bun ${CLAUDE_PLUGIN_ROOT}/scripts/manifest-seed.ts .claude-code-hermit` with this JSON on stdin:

```json
{
  "pluginVersion": "<version>",
  "entries": [
    { "key": "templates/SHELL.md.template", "file": "${CLAUDE_PLUGIN_ROOT}/state-templates/SHELL.md.template" },
    { "key": "templates/SESSION-REPORT.md.template", "file": "${CLAUDE_PLUGIN_ROOT}/state-templates/SESSION-REPORT.md.template" },
    { "key": "templates/PROPOSAL.md.template", "file": "${CLAUDE_PLUGIN_ROOT}/state-templates/PROPOSAL.md.template" },
    { "keyPrefix": "bin", "dir": "${CLAUDE_PLUGIN_ROOT}/state-templates/bin" }
  ]
}
```

The `bin` entry enumerates the **source** `state-templates/bin/` (the authoritative core set), never the project's `.claude-code-hermit/bin/` (which can hold operator/add-on files). The script writes `{ "version": 1, "files": { ... } }` and on re-init preserves foreign keys (add-on hermit entries) while overwriting only the keys it re-seeds; it refuses to overwrite a present-but-corrupt manifest. The source files it hashes are stable, so seeding here does not change the recorded hashes.

The bare `.claude-code-hermit` argv is cwd-relative, which is safe here: `hatch` runs from the project root and never invokes `docker compose` or `tmux`, so cwd does not drift (unlike `/docker-setup` Step 7b.6, which anchors to an absolute `<PROJECT_ROOT>` for that reason).

### 9. Generate deny patterns (AskUserQuestion, single question)

Add safety deny rules to the target settings file's `permissions.deny` to prevent destructive operations. The target file is the same as Step 8 (`hatch_target == "local"` → `.claude/settings.local.json`; else → `.claude/settings.json`).

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

Run `bun ${CLAUDE_PLUGIN_ROOT}/scripts/apply-settings.ts <resolved-settings-file> deny <minimal|hardened>` to merge selected rules (never removes existing entries). The script reads the canonical deny list from `state-templates/deny-patterns.json`.

Do NOT include `Bash(docker *)`, `Bash(kubectl *)`, `Bash(ssh *)` in hatch — these are valid in devops contexts on the host. Docker-setup includes them because the container should not spawn child containers or SSH out.

### 9a. Sandbox profile (silent auto-apply, no question)

Configure the Claude Code bash sandbox for this hermit when the system supports it. The sandbox isolates bash tool calls at the OS level (`bwrap` on Linux/WSL2, `sandbox-exec` on macOS), adding defense in depth on top of the `permissions.deny` rules from Step 9. This step asks the operator no questions — silent secure default when deps are present, silent skip when they're not.

**Step:**

1. **Resolve target settings file** using `hatch_target` (`local` → `.claude/settings.local.json`; `committed` → `.claude/settings.json`).

2. **Skip if operator already has sandbox config.** Check if the target settings file already has any of these *operator-intent* keys under `sandbox`: `enabled`, `filesystem`, `network`, `failIfUnavailable`, `autoAllowBashIfSandboxed`, `allowUnsandboxedCommands`. If any are present, skip silently — tell the operator once: "Existing sandbox config preserved." Continue to Step 9b.

   **Important:** `sandbox.enableWeakerNestedSandbox` does NOT count as operator config — it's hermit-managed (auto-written by `hermit-start` inside Docker). Ignore it when deciding whether to skip.

3. **Probe capability**:
   ```bash
   bun ${CLAUDE_PLUGIN_ROOT}/scripts/sandbox-probe.ts
   ```
   Parse the JSON `status` field.

4. **Branch on probe status:**
   - `"pass"`: run `bun ${CLAUDE_PLUGIN_ROOT}/scripts/apply-settings.ts <resolved-settings-file> sandbox standard` (reads `state-templates/sandbox-profiles.json` `standard` entry and merges `sandbox.filesystem.denyRead` from `deny-patterns.json`). One-line note to the operator: "Sandbox enabled (standard profile, written to {file})."
   - `"warn"`: surface the probe `message` verbatim to the operator first (e.g., "user-namespaces appear disabled — sandbox may not start"), then run the same command as `pass`. One-line note: "Sandbox configured (standard profile, may degrade silently per warning above; written to {file})."
   - `"fail"`: do NOT write any sandbox block. Print a single line with the install hint from the probe result: "Sandbox unavailable: {message} — run `{install_hint}` to enable later, then re-run `/claude-code-hermit:hermit-evolve`." Continue.

No `AskUserQuestion`. Operators who want the sandbox off can set `sandbox.enabled: false` in their settings file at any time — documented in `docs/faq.md`.

### 9b. Persist hatch options

After Steps 6–9 complete, write `.claude-code-hermit/state/hatch-options.json`.

**If the file does not exist**, write:

```json
{
  "target": "<local|committed>",
  "core_install_scope": "<project|local|user|null>",
  "stamped_at": "<current ISO 8601 timestamp with timezone offset>",
  "stamped_by": "claude-code-hermit:hatch",
  "version": "<current plugin version from ${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json>"
}
```

**If the file already exists** (e.g. `claude-code-dev-hermit:hatch` stamped it first), preserve the original `stamped_by` and `stamped_at` and update the rest:

```json
{
  "target": "<local|committed>",
  "core_install_scope": "<project|local|user|null>",
  "stamped_at": "<original value — do not overwrite>",
  "stamped_by": "<original value — do not overwrite>",
  "last_updated_at": "<current ISO 8601 timestamp with timezone offset>",
  "last_updated_by": "claude-code-hermit:hatch",
  "version": "<current plugin version from ${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json>"
}
```

This file is read by `hermit-evolve`, `docker-setup`, and `claude-code-dev-hermit:hatch` to inherit the operator's target choice without re-running scope detection.

---

### Domain hatch continuation protocol

When a domain plugin's hatch detects that core is not yet set up, it uses this protocol to resume automatically after core's terminus:

**Writer (domain hatch, "yes" branch):**
1. Write `.claude-code-hermit/state/hatch-resume.json` with `{ "skill": "<domain-slug>:hatch" }`.
2. Print one fallback line: "(If setup doesn't continue automatically when core finishes, re-run `/<domain>:hatch`.)"
3. Invoke `/claude-code-hermit:hatch` **via the Skill tool** — terminal action, stop after the call.

**Consumer (core terminus — "Resume pending domain hatch" at end of this skill):**
Read, immediately delete, then invoke the named skill via the Skill tool.

**Idempotency and fail-open:** The marker is self-consuming (delete-before-invoke). Core's Step 1 keys "already initialized" on `config.json`, never on the marker, so writing the marker before delegating here cannot trip the reinit prompt. The domain hatch's Step 1/2 re-checks `_hermit_versions` independently, so a plain manual re-run is always the fallback. Every failure mode (Esc mid-core, core error, un-bumped core) degrades to today's manual behavior. One residual edge: if core is aborted before its terminus, the marker persists and the *next* core hatch consumes it — surfacing one domain-hatch re-prompt the operator didn't explicitly ask for. That re-prompt is itself idempotent (the domain hatch re-checks state) and Esc-able, so it's a benign annoyance, not a failure — which is why no staleness timestamp is tracked.

**5th-domain authors:** follow this pattern exactly. Core's terminus handles the return hop.

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

### Quick Turn 3 — Sign-off + Deployment + Channel + Idle batch

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
  },
  {
    header: "Idle",
    question: "What should hermit do when idle between tasks?",
    options: [
      { label: "Discover", description: "Maintenance and reflection (default)" },
      { label: "Wait", description: "Passive — only check for new tasks and messages" }
    ]
  }
]
```

Record `sign_off`, `deployment` (one of `docker` / `tmux` / `interactive`), `channel` (one of `none` / `discord` / `telegram`), `idle_behavior` (one of `discover` / `wait`).

`push_notifications` is left at the template default (`true`) — no follow-up question. Push is dormant whenever a channel is reachable (the runtime guard in CLAUDE-APPEND.md sends channel-first) and fires only as fallback when a channel is unreachable or absent.

**Derived values from this turn (used in the confirm bundle and Step 5 overlay):**
- `permission_mode`: `auto` (same default for both Docker and non-Docker deployments). Requires CC 2.1.148+ and Max/Team/Enterprise/API plan — not on Pro or Haiku. If the operator is on an ineligible plan, they'll see an "unavailable" error at launch and should run `/hermit-settings permissions` to switch to `acceptEdits`.
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
  Behavior:    escalation=balanced, idle={idle_behavior}, remote=on
  Deployment:  {deployment}, permission={derived}, deny={derived hardened|minimal}
  Plugins:     all 4 installed
  Routines:    morning 08:30, evening 22:30, heartbeat 04:00
  Channel:     {channel or None} (allow-everyone; token + pairing later)
  Push notifications: enabled
  Hermit ext:  {activated or none}
  Visibility:  {.local — plugin installed at <scope> scope | committed — plugin installed at project scope}
  Git:         {initialize local repo (tracks build output; hermit internals gitignored) | not applicable}
  Files:       {CLAUDE.local.md | CLAUDE.md}, .gitignore, .worktreeinclude, {.claude/settings.local.json | .claude/settings.json}
  OPERATOR.md: drafted from scan + your answers (written below)

Customize restarts the wizard from scratch; your Quick answers won't carry over.
```

The `Visibility:` and `Files:` lines are dynamic based on `hatch_target`. The `Push notifications:` line is always shown as `enabled` (template default; push acts as fallback when a channel is unreachable — the runtime guard in CLAUDE-APPEND.md prevents double-notification).

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
| Advanced Phase 3 equivalent | escalation, remote | template defaults (balanced, true) — don't override |
| Advanced Phase 4 equivalent | plugins + scheduled_checks | install all 4; write 3 scheduled_checks entries per Phase 4 mapping |
| Advanced Phase 4b equivalent | `.baseline-pending` marker | same eligibility check as Advanced |
| Advanced Phase 5 equivalent | channels.<name>.* | state_dir + enabled + dm_channel_id=null; omit allowed_users + morning_brief |
| Quick Turn 3 idle choice | idle_behavior | set to answer (`discover` / `wait`) |
| Quick Turn 3 channel choice | push_notifications | template default (true) — don't override |
| Advanced Phase 6 equivalent | permission_mode, routines | permission_mode = `auto`; routines = morning 08:30 + evening 22:30 + (template) heartbeat 04:00 |
| Step 6 | CLAUDE.md / CLAUDE.local.md append | apply silently to `hatch_target` file (default "keep" if marker already present) |
| Step 7 | .gitignore append | apply silently (per-line idempotent) |
| Step 7a | .worktreeinclude managed block | apply silently (marker-block idempotent — skip if marker already present) |
| Step 7.5 | git init (fresh dirs only) | run `git init` if `git_init_eligible`; omit otherwise |
| Step 8 | plugin permissions (target settings file) | merge silently into `hatch_target` settings file |
| Step 9 | deny patterns (target settings file) | derived profile silently (Docker → hardened, else → minimal); write to `hatch_target` settings file |

### Quick — auto-chain at end of Step 10

**Skip this entire auto-chain if `.claude-code-hermit/state/hatch-resume.json` exists.** A domain hatch is pending, and the "Resume pending domain hatch" terminus below will drive continuation instead — the two continuations must never both fire (whichever runs first drops the other). When a marker is present, emit no auto-chain slash command and fall straight through to the terminus.

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
  .claude-code-hermit/bin/ (hermit-attach, hermit-docker, hermit-run, hermit-start, hermit-status, hermit-stop, hermit-update, hermit-watchdog)
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
  Push notifications: {enabled | disabled}
  Morning brief:   disabled
  Heartbeat:       disabled
  Unattended mode: off

Hermits: (none activated)

Visibility:
  Target: {.local (plugin installed at <scope> scope) | committed (plugin installed at project scope)}

Updated:
  {CLAUDE.local.md | CLAUDE.md} — session discipline block appended
  .gitignore — hermit entries added
  .worktreeinclude — git worktree include entries added   ← omit if skipped
  {.claude/settings.local.json | .claude/settings.json} — plugin permissions added
  .claude-code-hermit/state/hatch-options.json — target stamped
  .git/ — initialized (tracks build output; hermit internals gitignored)   ← omit if git init was skipped or declined

  Flip target by re-running /hatch (Advanced) and choosing the other Visibility option.

Next steps:

  Pick how you'll run hermit:
    A. Docker always-on (recommended)   /claude-code-hermit:docker-setup
    B. tmux always-on (host)            .claude-code-hermit/bin/hermit-start
    C. Interactive — try it now         /claude-code-hermit:session

  After picking:
    - /reload-plugins                       load newly installed plugins in this session
    - /claude-code-hermit:channel-setup     if a channel was configured AND you chose B or C
                                              (A handles channels inside docker-setup)

  Anytime:
    - /claude-code-hermit:hermit-settings   change settings
    - /claude-code-hermit:hermit-evolve     after plugin updates
    - /claude-code-hermit:smoke-test        troubleshoot setup
    - Refine OPERATOR.md — just tell me what changed

```

**Quick-mode report adjustment**: collapse "Pick how you'll run hermit" to one line confirming Turn 3's deployment + channel, then emit the auto-chain slash command(s) per the mapping in "Quick — auto-chain at end of Step 10". Keep the "Anytime:" block unchanged.

---

### Resume pending domain hatch

Applies on **both** Quick and Advanced paths and is the **last** action of the skill. On Quick, when a marker is present the Step-10 auto-chain is skipped (see above), so this terminus is the sole continuation — the two never both fire.

1. Attempt to read `.claude-code-hermit/state/hatch-resume.json`. If the file does not exist or is empty, stop — no domain hatch is pending.
2. Read the `skill` field (e.g. `"laravel-forge-hermit:hatch"`).
3. **Immediately delete** `.claude-code-hermit/state/hatch-resume.json`.
4. Invoke the named skill **via the Skill tool** to complete domain setup — terminal action, stop after the call.
