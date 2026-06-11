# Skills Reference

Skills are Hermit's built-in workflows — invoke them with `/claude-code-hermit:` or let some auto-trigger from natural language.

---

## Session Lifecycle

| Skill           | What it does                                                                                                                                             | Auto-triggers                                                   |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `session`       | Full workflow: start, work, close. The main entry point.                                                                                                 | --                                                              |
| `session-start` | Picks up where you left off, or starts fresh. Loads context and checks for queued work from accepted proposals.                                          | --                                                              |
| `session-close` | Finalizes the session, runs a quality checklist, archives the report. Always a full shutdown — idle transitions happen automatically when work finishes. | "I'm done", "wrap it up", "that's it for now", "done for today" |

## Status & Reporting

| Skill   | What it does                                                                                                 | Auto-triggers                                                     |
| ------- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| `pulse` | Compact session summary, under 10 lines. Channel-friendly. Flags active alerts inline with a pointer to `/hermit-health`. | "status", "progress", "what are you working on", "how's it going" |
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
| Token cost   | Zero tokens when quiet                                                        | Zero when quiet                    |

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

## Proposals & Learning

| Skill             | What it does                                                                                                                                                                             | Auto-triggers                                                |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `proposal-create` | Capture a high-leverage improvement found during work. Skip trivial fixes (just fix them) and style preferences (put in OPERATOR.md).                                                    | --                                                           |
| `proposal-list`   | All proposals with status, source, and age. Auto-detected proposals listed first. Stale proposals (10+ sessions) get flagged.                                                            | "what have you noticed", "any improvements", "any proposals" |
| `proposal-act`    | Accept, defer, or dismiss. Accepting creates a NEXT-TASK.md for the next idle pickup.                                                                                                    | "accept PROP-", "dismiss PROP-", "defer PROP-"               |
| `reflect`         | Reflects on accumulated experience to surface recurring patterns. Uses memory as primary input — no report prerequisite. Runs at task boundaries, heartbeat idle checks, and end of day. When a multi-step procedure recurs across ≥2 sessions with no existing skill covering it, reflect writes a procedure brief to `compiled/` and proposes a new skill (`category: capability`, operator-gated). On accept, `/skill-creator` authors the final SKILL.md and the operator confirms before it is installed to `.claude/skills/`. | --                                                           |
| `reflect-scheduled-checks` | Standalone routine skill. Runs one due interval-triggered scheduled check, gates findings through reflection-judge + proposal-triage, applies state, and logs. Runs as a daily routine, not called by `reflect`. | -- |
| `capability-brainstorm` | On-demand hermit-voice brainstorm: synthesizes memory, available capabilities, recent compiled artifacts, and codebase shape into at most 2 capability ideas, each gated by proposal-triage. | "brainstorm capabilities", "what could you be doing for me?", "any capability ideas?" |

## Configuration

| Skill             | What it does                                                                                                                                                                                                                                                | Auto-triggers |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| `hermit-settings` | View or change project config. Subcommands: `name`, `language`, `timezone`, `escalation`, `sign-off`, `channels`, `remote`, `model`, `brief`, `permissions`, `heartbeat`, `routines`, `idle`, `env`, `compact`, `docker`, `scheduled-checks`, `quality-gate`, `push-notifications`. | --            |
| `hatch`           | One-time project setup. Creates state directory, runs the wizard, scans your project, writes OPERATOR.md, and configures scheduled checks for accepted plugins.                                                                                                | --            |
| `hermit-evolve`   | Run after updating the plugin. Detects version gaps, refreshes templates, prompts for new settings.                                                                                                                                                         | --            |

## Docker

| Skill              | What it does                                                                                                                                                                                                                                    | Auto-triggers |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| `docker-setup`     | Generates hermit-namespaced Docker files (`Dockerfile.hermit`, `docker-compose.hermit.yml`, etc.) and walks through the full deployment — token, build, start, MCP plugins, workspace trust, verify. Won't conflict with your own Docker setup. | --            |
| `docker-security`  | Opt-in advanced hardening wizard beyond the v1.0.26 baseline. Adds LAN containment, resource bounds, and a plugin install audit log via a reversible `docker-compose.security.yml` overlay. Run after `docker-setup`. | --            |

## Migration

| Skill            | What it does                                                                                                                                      | Auto-triggers |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| `migrate` | Audits a hermit-backed repo for safe migration to another machine. Classifies ignored files, assesses hermit state, and produces a `migration-manifest.txt` and verification checklist. Git-first, read-only by default. | --            |

## Channel-Friendly Summaries

| Skill           | What it does                                                                                                                                                                                    | Auto-triggers       |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| `hermit-brain`     | Show fragile zones, stale accepted proposals, and recent learnings from session history, proposals, and reflect output. Activated by natural language: "what's stuck", "fragile zones", etc.    | --                  |
| `hermit-evolution` | Show cost trend, autonomy delta, and proposal-resolution times across recent weekly reviews. Activated by: "how am I trending", "cost trend", "hermit evolution", etc.                          | --                  |
| `cost-reflect`     | Structural cost audit — token-type breakdown (cache_read / cache_write / output / input), cold-start detection, and per-session attribution over the last 7 days. Read-only report. For week-over-week trend lines, use `hermit-evolution`. Opt-in as a weekly routine via `/hermit-settings`. Activated by: "where is my spend going", "cost breakdown", "cost audit", "cold starts", "cost drivers", etc. | opt-in routine |
| `hermit-health`    | Show alert state, proposal queue depth, routine engagement, knowledge state, and channel availability. Activated by: "health check", "how's the hermit", "is anything broken", etc.            | --                  |
| `weekly-review` | Generates a weekly review report at `.claude-code-hermit/compiled/review-weekly-YYYY-Www.md` and sends a channel-friendly summary with an evolution block. Archives expired raw artifacts.      | Sunday 23:00 routine |

## Communication

| Skill               | What it does                                                                                                                                                                                | Auto-triggers  |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| `channel-setup`     | Guided channel activation for local/tmux users — installs the plugin, configures the bot token in the project-local state dir, and walks through pairing. Run after hatch or hermit-settings when not using Docker. | -- |
| `channel-responder` | Handles inbound messages from [Channels](https://code.claude.com/docs/en/channels). Classifies as status request, new instruction, question, or emergency. Responds in one short paragraph. | Message-driven |

## Testing

| Skill        | What it does                                                                                                                                                | Auto-triggers |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| `smoke-test`    | Post-hatch validation — checks config structure, OPERATOR.md, routine schema, plugin references, and optionally sends a channel test message. Run after hatch to verify setup. | --            |
| `hermit-doctor` | Eleven-check installation health report — config validity, hook registration, state file integrity, cost visibility, proposal health, sibling dependency ranges, file permissions, docker-security posture, archival health, reflect loop health, sandbox capability. Use when diagnosing an install, before a release, or after suspicious behavior. | --            |
| `test-run`      | Runs the full hermit test suite (`run-contracts.py`, the bun hook-contract suite) and reports pass/fail. Use before releasing changes.                                   | --            |
