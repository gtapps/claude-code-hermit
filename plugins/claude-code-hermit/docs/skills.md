# Skills Reference

Skills are Hermit's built-in workflows — invoke them with `/claude-code-hermit:` or let some auto-trigger from natural language.

---

## Focus Lifecycle

| Skill   | What it does                                                                                                                                                          | Auto-triggers                                                                              |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `steer` | Loads operator context, runs dirty-shutdown recovery if needed, sets `## Focus` from a positional `<focus text>` argument, or asks what to work on.                   | "let's start", "good morning", "what's on deck", "let's tackle X", "I'm starting on X"     |
| `done`  | Clears the current focus, appends a one-line entry to `## Recent Activity`, compacts persistent SHELL.md sections. `/done --shutdown` signals a graceful daemon stop. | "I'm done", "wrap it up", "that's it for now", "ready for next", "close the session"      |

`/session-start`, `/session`, `/session-close` are v1.1.0 backwards-compat alias shims that forward to `/steer` / `/done` with a one-line deprecation note. They retire in v1.2.0.

## Status & Reporting

| Skill   | What it does                                                                                                 | Auto-triggers                                                     |
| ------- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| `pulse` | Compact session summary, under 10 lines. Channel-friendly. Pass `--full` to append infrastructure health (proposals, routines, last activity, knowledge counts). | "status", "progress", "what are you working on", "how's it going" |
| `brief` | 5-line executive summary. Checks active session, falls back to latest report. Also supports daily summaries. | "brief", "what happened", "morning update", "overnight summary"   |
| `knowledge` | Read-only lint of `raw/` and `compiled/` — flags stale, unreferenced, missing-type, and oversized artifacts. | "check knowledge", "lint knowledge", "knowledge health" |

## Monitoring

| Skill       | What it does                                                                                                                                                                                                                     | Auto-triggers |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| `watch`     | Background event watchers via the CC Monitor tool. Each stdout line becomes a conversation notification — zero token cost when quiet. Supports config-defined watches (auto-registered at session start) and ad-hoc operator watches. Subcommands: `watch <instruction>`, `start`, `stop [id]`, `stop --all`, `status`. | --            |
| `heartbeat` | Background health checker with idle agency. Evaluates HEARTBEAT.md checklist and picks up autonomous work during idle. Subcommands: `run`, `start`, `stop`, `status`, `edit`. | --            |

**Heartbeat vs Watch:**

|              | Heartbeat                                                                     | Watch                              |
| ------------ | ----------------------------------------------------------------------------- | ---------------------------------- |
| Runs         | Persistent across tasks (guaranteed in always-on, best-effort in interactive) | Session-scoped, cleared on start   |
| Checklist    | HEARTBEAT.md (you edit it)                                                    | Inline command or config `monitors`|
| Quiet mode   | Suppresses OK by default                                                      | Silent until stdout fires          |
| Active hours | Yes (default 08:00-23:00)                                                     | No                                 |
| Token cost   | LLM evaluation per tick                                                       | Zero when quiet                    |

**Checklist weight:** Keep the heartbeat checklist under 10 items. Items that need checking on a schedule (daily, weekly) rather than every tick belong in routines. The self-evaluation will flag overgrown checklists.

## Routines

| Skill             | What it does                                                                                                                                                  | Auto-triggers |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| `hermit-routines` | Registers each enabled `config.json` routine as a per-session `CronCreate` job. Subcommands: `load`, `list`, `status`, `stop`. Auto-registered on always-on launch. | --            |

Routines are scheduled skills fired by cron schedule instead of relying on heartbeat ticks. Each routine is idle-gated (never interrupts mid-task) and zero token cost until fire.

Each routine has an `id`, a `schedule` (5-field cron: `minute hour dom month dow`), and a `skill` to invoke. Default routines are `morning` (brief with forward-looking framing) and `evening` (brief with backward-looking framing).

**Managing routines:**

- View and edit: `/claude-code-hermit:hermit-settings routines`
- Morning brief variant: `/claude-code-hermit:brief --morning` (emphasizes priorities, proposals, forward-looking content)
- Evening brief variant: `/claude-code-hermit:brief --evening` (emphasizes completed work, cost, findings)

Routines replace the old `heartbeat.morning_routine` / `heartbeat.evening_routine` config. Existing config is migrated automatically on upgrade.

## Idle Tasks (IDLE-TASKS.md)

`.claude-code-hermit/IDLE-TASKS.md` is an operator-editable checklist of low-priority tasks the hermit works through during downtime. Only active when `idle_behavior` is `"discover"`. Tasks are picked sequentially (top-to-bottom), each capped by `idle_budget`. The hermit marks items `[x]` on completion.

## Proposals & Learning

| Skill             | What it does                                                                                                                                                                             | Auto-triggers                                                |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `proposal-create` | Capture a high-leverage improvement found during work. Skip trivial fixes (just fix them) and style preferences (put in OPERATOR.md).                                                    | --                                                           |
| `proposal-list`   | All proposals with status, source, and age. Auto-detected proposals listed first. Stale proposals (10+ sessions) get flagged.                                                            | "what have you noticed", "any improvements", "any proposals" |
| `proposal-act`    | Accept, defer, or dismiss. Accepting creates a NEXT-TASK.md for the next idle pickup.                                                                                                    | "accept PROP-", "dismiss PROP-", "defer PROP-"               |
| `reflect`         | Reflects on accumulated experience to surface recurring patterns. Uses memory as primary input — no report prerequisite. Runs at task boundaries, heartbeat idle checks, and end of day. | --                                                           |
| `reflect-scheduled-checks` | Standalone routine skill. Runs one due interval-triggered scheduled check, gates findings through reflection-judge + proposal-triage, applies state, and logs. Runs as a daily routine, not called by `reflect`. | -- |
| `capability-brainstorm` | On-demand hermit-voice brainstorm: synthesizes memory, available capabilities, recent compiled artifacts, and codebase shape into at most 2 capability ideas, each gated by proposal-triage. | "brainstorm capabilities", "what could you be doing for me?", "any capability ideas?" |

## Configuration

| Skill             | What it does                                                                                                                                                                                                                                                | Auto-triggers |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| `hermit-settings` | View or change project config. Subcommands: `name`, `language`, `timezone`, `escalation`, `sign-off`, `channels`, `remote`, `model`, `budget`, `brief`, `permissions`, `heartbeat`, `routines`, `idle-agency`, `env`, `compact`, `docker`, `scheduled-checks`, `quality-gate`. | --            |
| `hatch`           | One-time project setup. Creates state directory, runs the wizard, scans your project, writes OPERATOR.md, and configures scheduled checks for accepted plugins.                                                                                                | --            |
| `hermit-evolve`   | Run after updating the plugin. Detects version gaps, refreshes templates, prompts for new settings.                                                                                                                                                         | --            |

## Docker & Takeover

| Skill              | What it does                                                                                                                                                                                                                                    | Auto-triggers |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| `docker-setup`     | Generates hermit-namespaced Docker files (`Dockerfile.hermit`, `docker-compose.hermit.yml`, etc.) and walks through the full deployment — token, build, start, MCP plugins, workspace trust, verify. Won't conflict with your own Docker setup. | --            |
| `docker-security`  | Opt-in advanced hardening wizard beyond the v1.0.26 baseline. Adds LAN containment, resource bounds, and a plugin install audit log via a reversible `docker-compose.security.yml` overlay. Run after `docker-setup`. | --            |
| `hermit-takeover`  | Stops the Docker container, marks session as `operator_takeover`, loads full hermit context (OPERATOR.md, SHELL.md, latest report), presents a summary. Run locally to drive interactively.                                                     | --            |
| `hermit-hand-back` | Summarizes operator activity via `git log`, optionally queues instructions in NEXT-TASK.md, updates SHELL.md, restarts the Docker container.                                                                                                    | --            |

## Migration

| Skill            | What it does                                                                                                                                      | Auto-triggers |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| `migrate` | Audits a hermit-backed repo for safe migration to another machine. Classifies ignored files, assesses hermit state, and produces a `migration-manifest.txt` and verification checklist. Git-first, read-only by default. | --            |

## Cortex (Obsidian)

| Skill            | What it does                                                                                                                                                                                                                                          | Auto-triggers   |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| `obsidian-setup` | One-time Cortex setup. Creates the `obsidian/` vault surface with Brain, Cortex, Evolution, System Health, Connections, and Cortex Portal pages. Configures `cortex-manifest.json` for artifact indexing and adds the nightly cortex-refresh routine. | --              |
| `cortex-refresh` | Regenerates `obsidian/Connections.md` and `obsidian/Cortex Portal.md` from current session, proposal, and artifact data. Runs nightly at 23:30 via routine. Safe to invoke manually.                                                                  | Nightly routine |
| `cortex-sync`    | Enriches existing content with frontmatter and tags. Scans sessions, proposals, and artifact paths for missing fields, clusters similar files for batch confirmation, then rebuilds Connections.md if the Cortex is set up.                           | --              |
| `weekly-review`  | Generates a weekly review report at `.claude-code-hermit/compiled/review-weekly-YYYY-Www.md` (type: `review`) summarising sessions, proposals, costs, open loops, and **knowledge health** (stale artifacts, working set growth, raw expiry candidates). **Archives expired raw artifacts** to `raw/.archive/` after the report. | --              |

## Communication

| Skill               | What it does                                                                                                                                                                                | Auto-triggers  |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| `channel-setup`     | Guided channel activation for local/tmux users — installs the plugin, configures the bot token in the project-local state dir, and walks through pairing. Run after hatch or hermit-settings when not using Docker. | -- |
| `channel-responder` | Handles inbound messages from [Channels](https://code.claude.com/docs/en/channels). Classifies as status request, new instruction, question, or emergency. Responds in one short paragraph. | Message-driven |

## Testing

| Skill        | What it does                                                                                                                                                | Auto-triggers |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| `smoke-test`    | Post-hatch validation — checks config structure, OPERATOR.md, routine schema, plugin references, and optionally sends a channel test message. Run after hatch to verify setup. | --            |
| `hermit-doctor` | Eight-check installation health report — config validity, hook registration, state file integrity, cost budget, proposal health, sibling dependency ranges, file permissions, docker-security posture. Use when diagnosing an install, before a release, or after suspicious behavior. | --            |
| `test-run`      | Runs the full hermit test suite (`run-contracts.py`, `run-hooks.sh`, `validate-frontmatter.js`) and reports pass/fail. Use before releasing changes.       | --            |
