# Skills Reference

Skills are Hermit's built-in workflows — invoke them with `/claude-code-hermit:` or let some auto-trigger from natural language.

---

## Session Lifecycle

| Skill           | What it does                                                                                                                  | Auto-triggers |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------- |
| `session`       | Full workflow: start, work, close. The main entry point.                                                                      | --            |
| `session-start` | Picks up where you left off, or starts fresh. Loads context and checks for queued work from accepted proposals.               | --            |
| `session-close` | Finalizes the session, runs a quality checklist, archives the report. Always a full shutdown — idle transitions happen automatically when work finishes. | "I'm done", "wrap it up", "that's it for now", "done for today" |

## Status & Reporting

| Skill    | What it does                                                                  | Auto-triggers                                                     |
| -------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `status` | Compact session summary, under 10 lines. Channel-friendly.                    | "status", "progress", "what are you working on", "how's it going" |
| `brief`  | 5-line executive summary. Checks active session, falls back to latest report. Also supports daily summaries. | "brief", "what happened", "morning update", "overnight summary"   |

## Monitoring

| Skill       | What it does                                                                                                                                                                              | Auto-triggers |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| `monitor`   | Session-aware recurring checks via `/loop`. Logs findings to SHELL.md with `[monitor]` prefix. Multiple monitors can run simultaneously.                                                  | --            |
| `heartbeat` | Background health checker with idle agency and daily routines. Evaluates HEARTBEAT.md checklist, picks up autonomous work during idle, runs morning and evening routines. Subcommands: `run`, `start`, `stop`, `status`, `edit`. | --            |

**Heartbeat vs Monitor:**

|              | Heartbeat                  | Monitor                |
| ------------ | -------------------------- | ---------------------- |
| Runs         | Persistent across tasks (guaranteed in always-on, best-effort in interactive) | Per-session, you start it |
| Checklist    | HEARTBEAT.md (you edit it) | Inline instruction     |
| Quiet mode   | Suppresses OK by default   | Always logs            |
| Active hours | Yes (default 08:00-23:00)  | No                     |

**Checklist weight:** Keep the heartbeat checklist under 10 items. Items that need checking on a schedule (daily, weekly) rather than every tick belong in routines. The self-evaluation will flag overgrown checklists.

## Routines

Routines are scheduled skills that fire at exact times (HH:MM) instead of relying on heartbeat ticks. A shell-level watcher (`scripts/routine-watcher.sh`) reads `config.json` routines every 60 seconds and fires the configured skill when the time matches. No LLM tokens are spent on clock-checking.

Each routine has an `id`, a `time` (24h format), a `skill` to invoke, and optional `args`. Default routines are `morning` (brief with forward-looking framing) and `evening` (brief with backward-looking framing).

**Managing routines:**

- View and edit: `/claude-code-hermit:hermit-settings routines`
- Morning brief variant: `/claude-code-hermit:brief --morning` (emphasizes priorities, proposals, forward-looking content)
- Evening brief variant: `/claude-code-hermit:brief --evening` (emphasizes completed work, cost, findings)

Routines replace the old `heartbeat.morning_routine` / `heartbeat.evening_routine` config. Existing config is migrated automatically on upgrade.

## When Idle (OPERATOR.md)

OPERATOR.md supports a `## When Idle` section listing low-priority maintenance tasks the hermit can pick up during downtime. Tasks are picked sequentially, capped by `idle_budget`.

This section is only active when `idle_behavior` is set to `"discover"` (default is `"wait"`). Set it via `/claude-code-hermit:hermit-settings idle`.

## Proposals & Learning

| Skill             | What it does                                                                                                                          | Auto-triggers |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| `proposal-create` | Capture a high-leverage improvement found during work. Skip trivial fixes (just fix them) and style preferences (put in OPERATOR.md). | --            |
| `proposal-list`   | All proposals with status, source, and age. Auto-detected proposals listed first. Stale proposals (10+ sessions) get flagged.         | "what have you noticed", "any improvements", "any proposals" |
| `proposal-act`    | Accept, defer, or dismiss. Accepting creates a NEXT-TASK.md for the next idle pickup.                                                 | "accept PROP-", "dismiss PROP-", "defer PROP-" |
| `reflect`  | Reflects on accumulated experience to surface recurring patterns. Uses memory as primary input — no report prerequisite. Runs at task boundaries, heartbeat idle checks, and end of day. | --            |

## Configuration

| Skill             | What it does                                                                                                                                                                     | Auto-triggers |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| `hermit-settings` | View or change project config. Subcommands: `name`, `language`, `timezone`, `escalation`, `sign-off`, `channels`, `remote`, `model`, `budget`, `brief`, `permissions`, `heartbeat`, `routines`, `idle-agency`, `env`, `compact`, `docker`. | --             |
| `init`            | One-time project setup. Creates state directory, runs the wizard, scans your project, and writes OPERATOR.md.                                                                    | --            |
| `upgrade`         | Run after updating the plugin. Detects version gaps, refreshes templates, prompts for new settings.                                                                              | --            |

## Docker & Takeover

| Skill              | What it does                                                                                                                                                                    | Auto-triggers |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| `docker-setup`     | Generates hermit-namespaced Docker files (`Dockerfile.hermit`, `docker-compose.hermit.yml`, etc.) and walks through the full deployment — token, build, start, MCP plugins, workspace trust, verify. Won't conflict with your own Docker setup. | --            |
| `hermit-takeover`  | Stops the Docker container, marks session as `operator_takeover`, loads full hermit context (OPERATOR.md, SHELL.md, latest report), presents a summary. Run locally to drive interactively. | --            |
| `hermit-hand-back` | Summarizes operator activity via `git log`, optionally queues instructions in NEXT-TASK.md, updates SHELL.md, restarts the Docker container.                                     | --            |

## Communication

| Skill               | What it does                                                                                                                                                                                | Auto-triggers  |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| `channel-responder` | Handles inbound messages from [Channels](https://code.claude.com/docs/en/channels). Classifies as status request, new instruction, question, or emergency. Responds in one short paragraph. | Message-driven |
