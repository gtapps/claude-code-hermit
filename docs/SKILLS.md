# Skills Reference

Skills are Hermit's built-in workflows — invoke them with `/claude-code-hermit:` or let some auto-trigger from natural language.

---

## Session Lifecycle

| Skill           | What it does                                                                                                                  | Auto-triggers |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------- |
| `session`       | Full workflow: start → work → close. The main entry point.                                                                    | —             |
| `session-start` | Initialize or resume a session. Loads OPERATOR.md, SHELL.md, last report. Checks for prepared tasks from accepted proposals.  | —             |
| `session-close` | Finalize session, run quality checklist, archive report. Always a full shutdown — idle transitions happen automatically at task boundaries. | —             |

## Status & Reporting

| Skill    | What it does                                                                  | Auto-triggers                                                     |
| -------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `status` | Compact session summary, under 10 lines. Channel-friendly.                    | "status", "progress", "what are you working on", "how's it going" |
| `brief`  | 5-line executive summary. Checks active session, falls back to latest report. | "brief", "what happened", "morning update", "overnight summary"   |

## Monitoring

| Skill       | What it does                                                                                                                                                                              | Auto-triggers |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| `monitor`   | Session-aware recurring checks via `/loop`. Logs findings to SHELL.md with `[monitor]` prefix. Multiple monitors can run simultaneously.                                                  | —             |
| `heartbeat` | Background health checker on a schedule. Evaluates HEARTBEAT.md checklist, alerts via channel only when something needs attention. Subcommands: `run`, `start`, `stop`, `status`, `edit`. | —             |

**Heartbeat vs Monitor:**

|              | Heartbeat                  | Monitor                |
| ------------ | -------------------------- | ---------------------- |
| Runs         | Persistent across tasks (guaranteed in always-on, best-effort in interactive) | Per-task, user-invoked |
| Checklist    | HEARTBEAT.md (you edit it) | Inline instruction     |
| Quiet mode   | Suppresses OK by default   | Always logs            |
| Active hours | Yes (default 08:00–23:00)  | No                     |

## Proposals & Learning

| Skill             | What it does                                                                                                                          | Auto-triggers |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| `proposal-create` | Capture a high-leverage improvement found during work. Skip trivial fixes (just fix them) and style preferences (put in OPERATOR.md). | —             |
| `proposal-list`   | All proposals with status, source, and age. Auto-detected proposals listed first. Stale proposals (10+ sessions) get flagged.         | —             |
| `proposal-act`    | Accept, defer, or dismiss. Accepting creates a NEXT-TASK.md for the next session.                                                     | —             |
| `pattern-detect`  | Analyzes last 5 session reports for recurring patterns. Requires 3+ reports. Runs automatically during session close.                 | —             |

## Configuration

| Skill             | What it does                                                                                                                                                                     | Auto-triggers |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| `hermit-settings` | View/change project config. Subcommands: `name`, `language`, `timezone`, `escalation`, `sign-off`, `channels`, `remote`, `model`, `budget`, `brief`, `permissions`, `heartbeat`. | —             |
| `init`            | One-time project setup. Creates state directory, runs wizard, scans project, generates OPERATOR.md.                                                                              | —             |
| `upgrade`         | Run after updating the plugin. Detects version gaps, refreshes templates, prompts for new settings.                                                                              | —             |

## Communication

| Skill               | What it does                                                                                                                                                                                | Auto-triggers  |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| `channel-responder` | Handles inbound messages from [Channels](https://code.claude.com/docs/en/channels). Classifies as status request, new instruction, question, or emergency. Responds in one short paragraph. | Message-driven |
