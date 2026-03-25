# Skills Reference

Skills are reusable workflows you invoke with slash commands (e.g., `/claude-code-hermit:session`). Every skill in this plugin is namespaced under `/claude-code-hermit:`.

Some skills **auto-trigger** when you type certain keywords in normal conversation. For example, typing "status" or "how's it going" automatically invokes the `status` skill — no slash command needed.

## Glossary

| Term | Meaning |
|------|---------|
| **Session** | A bounded unit of work. Has a task, tracked plan items, a cost log, and an archived report when done. |
| **SHELL.md** | The live working document for the current session. Lives at `.claude/.claude-code-hermit/sessions/SHELL.md`. |
| **Proposal** | A captured improvement idea. Created during work, reviewed later by the operator (you). |
| **Operator** | You — the human running the agent. |
| **Hermit** | A separate plugin that adds specialized agents and skills on top of hermit core (e.g., `claude-code-dev-hermit` for software development). |
| **Channel** | A Telegram or Discord connection to the running agent via [Claude Code Channels](https://code.claude.com/docs/en/channels) (v2.1.80+). |

---

## Session Lifecycle

### session

Start or resume a work session with full context loading and task tracking.

**Usage:** `/claude-code-hermit:session`
**Auto-triggers:** None

The main entry point for working with the agent. It calls `session-start` to load context, asks you for a task (or resumes the active one), plans an ordered plan, executes work, and calls `session-close` when done. This is a generic workflow — hermits provide specialized versions (e.g., `/claude-code-dev-hermit:dev-session` adds code review and testing).

**Example:**
```
/claude-code-hermit:session
> Active session found: "Migrate auth module to OAuth2"
> Progress: 3/5 plan items complete
> Continue this task, or start a new one?
```

**Related:** session-start, session-close

---

### session-start

Initializes or resumes a work session. Loads context from OPERATOR.md, SHELL.md, and the latest session report.

**Usage:** `/claude-code-hermit:session-start`
**Auto-triggers:** None

Runs automatically as part of `/session`, but you can also call it directly. Loads project config, OPERATOR.md, and active session state. Checks for a prepared task from `NEXT-TASK.md` (created by accepting a proposal). Notifies you of unreviewed auto-detected proposals. For new sessions, asks for a task, tags, and an optional cost budget.

**Related:** session, session-close

---

### session-close

Closes the current session, archives a report, and prepares for the next session.

**Usage:** `/claude-code-hermit:session-close`
**Auto-triggers:** None

Before archiving, it:
1. Finalizes SHELL.md with plan statuses (`done`, `blocked`, `planned`)
2. Documents blockers with enough context for a cold start
3. Records lessons learned
4. Creates proposals for any high-leverage improvements discovered
5. Runs `pattern-detect` to analyze recent sessions for recurring issues
6. Archives the session as `S-NNN-REPORT.md`

**Related:** session, session-start, pattern-detect, proposal-create

---

## Status & Reporting

### status

Returns a compact summary of the current session (under 10 lines).

**Usage:** `/claude-code-hermit:status`
**Auto-triggers:** "status", "progress", "what are you working on", "how's it going"

Reads SHELL.md and outputs a channel-friendly summary:

```
Session S-042 | in_progress | refactor, backend
Task: Migrate auth module to OAuth2
Progress: 3/5 plan items | Current: Step 4 - Update token refresh logic
Budget: $2.10 / $5.00 (42%)
Blockers: none
Cost: $2.10 (145K tokens)
```

Budget and tags lines are omitted if not set.

**Related:** brief

---

### brief

Returns a 5-line executive summary of recent work.

**Usage:** `/claude-code-hermit:brief`
**Auto-triggers:** "brief", "what happened", "morning update", "overnight summary"

Checks the active session first, falls back to the latest archived report. Designed for morning check-ins and phone consumption.

```
[Brief] 2026-03-24 | refactor, backend
Task: Migrate auth module to OAuth2
Status: partial (3/5 plan items) | $2.10 spent
Done: Extract token logic, Update middleware, Add refresh endpoint
Next: Update token refresh logic
```

If there are unreviewed auto-detected proposals, a 6th line is appended.

**Related:** status

---

## Monitoring

### monitor

Sets up a session-aware monitoring loop for recurring checks during a session.

**Usage:**
```
/claude-code-hermit:monitor check if the deploy succeeded — every 5m
/claude-code-hermit:monitor watch error rate in logs — every 2m
/claude-code-hermit:monitor stop
```
**Auto-triggers:** None

Wraps the built-in `/loop` command with SHELL.md bookkeeping. Each check appends findings to the Progress Log with a `[monitor]` prefix. Multiple monitors can run simultaneously. When a session closes, all active monitors are stopped.

Requires an active session. Default interval is 5 minutes if not specified.

**Related:** heartbeat

---

### heartbeat

Background health checker that periodically evaluates a checklist and surfaces anything needing attention.

**Usage:**
```
/claude-code-hermit:heartbeat run       — execute one tick immediately
/claude-code-hermit:heartbeat start     — start the recurring loop
/claude-code-hermit:heartbeat stop      — stop the recurring loop
/claude-code-hermit:heartbeat status    — show last result and loop state
/claude-code-hermit:heartbeat edit      — modify the checklist
```
**Auto-triggers:** None

Reads `.claude/.claude-code-hermit/HEARTBEAT.md` (an operator-editable checklist) and evaluates each item. If something needs attention, it sends a channel alert. If everything is OK, it logs silently (unless `show_ok` is enabled).

Respects `active_hours` (default 08:00–23:00) — ticks outside this window are skipped. Every N ticks (default 20), a self-evaluation runs to detect stale checks and suggest new ones based on recurring proposal patterns.

**Heartbeat vs Monitor:**

| | Heartbeat | Monitor |
|---|---|---|
| Triggered by | Always-on loop via boot script | User-invoked per task |
| Checklist | HEARTBEAT.md (persistent) | Inline instruction (one-off) |
| Quiet mode | Yes — suppresses OK by default | No — always logs |
| Active hours | Yes | No |

**Related:** monitor, hermit-settings (heartbeat subcommand)

---

## Proposals & Learning

### proposal-create

Creates a proposal for a high-leverage improvement discovered during work.

**Usage:** `/claude-code-hermit:proposal-create`
**Auto-triggers:** None

Use this when you discover something worth capturing:
- A missing helper that would save time across sessions
- A missing guardrail that could prevent errors
- A workflow improvement benefiting multiple sessions

Creates a `PROP-NNN.md` file in `.claude/.claude-code-hermit/proposals/` with context, problem, proposed solution, and impact. The "Operator Decision" section is left blank for you to fill in.

Do NOT create proposals for trivial fixes (just fix them), style preferences (put in OPERATOR.md), or hypothetical future needs.

**Related:** proposal-list, proposal-act

---

### proposal-list

Lists all proposals with status, source, and age.

**Usage:** `/claude-code-hermit:proposal-list`
**Auto-triggers:** None

Shows a table of all proposals, with auto-detected proposals (from the learning loop) listed first:

```
| ID       | Status   | Source        | Age          | Summary                            |
|----------|----------|---------------|--------------|------------------------------------|
| PROP-020 | proposed | auto-detected | 1 session    | [tag-correlation] Frontend blocked |
| PROP-019 | proposed | auto-detected | 3 sessions   | [blocker] Test env recurring       |
| PROP-015 | proposed | manual        | 12 sessions  | ⚠ Refactor auth module             |
```

Dismissed and resolved proposals are hidden by default (say "show all" to see them). Proposals open for 10+ sessions get a ⚠ warning.

**Related:** proposal-create, proposal-act

---

### proposal-act

Accept, defer, or dismiss a proposal.

**Usage:**
```
/claude-code-hermit:proposal-act accept PROP-019
/claude-code-hermit:proposal-act defer PROP-015
/claude-code-hermit:proposal-act dismiss PROP-012
```
**Auto-triggers:** None

- **Accept:** Marks as accepted and asks how to proceed. "Create a session task" writes a `NEXT-TASK.md` file that `session-start` will offer as the default task next time. "I'll handle it manually" just marks it accepted.
- **Defer:** Marks as deferred with an optional note. Still visible in `/proposal-list`.
- **Dismiss:** Marks as dismissed. Hidden from the default `/proposal-list` view.

**Related:** proposal-create, proposal-list

---

### pattern-detect

Analyzes recent session reports to detect recurring patterns and creates auto-proposals.

**Usage:** `/claude-code-hermit:pattern-detect`
**Auto-triggers:** None (auto-invoked by `session-close` before archiving)

Requires at least 3 archived session reports. Scans the last 5 reports for four pattern categories: blocker recurrence, workaround repetition, cost trends, and tag correlations.

New patterns generate auto-proposals (with `Source: auto-detected`). Previously accepted auto-proposals are checked for resolution — if the pattern hasn't recurred in 3 sessions, the proposal is auto-resolved.

**Related:** proposal-create, proposal-list, session-close

---

## Configuration

### hermit-settings

View or change hermit configuration for the project.

**Usage:** `/claude-code-hermit:hermit-settings [subcommand]`
**Subcommands:** `name`, `language`, `timezone`, `escalation`, `sign-off`, `channels`, `remote`, `budget`, `brief`, `permissions`, `heartbeat` (or no argument to show all)
**Auto-triggers:** None

Reads and writes `.claude/.claude-code-hermit/config.json`. With no argument, displays all current settings. With a subcommand, prompts you to change that specific setting. Auto-detects system locale and timezone as defaults where applicable.

**Related:** init

---

### init

Initializes the autonomous agent in the current project. Run once per project, like `git init`.

**Usage:** `/claude-code-hermit:init`
**Auto-triggers:** None

Creates the full state directory (`.claude/.claude-code-hermit/`) with sessions, proposals, templates, boot scripts, and config. Runs a setup wizard covering:

- **Agent Identity:** name, language, timezone, autonomy level, sign-off
- **Operational:** channels, remote control, morning brief, heartbeat, budget prompting, unattended mode

Then scans your project (README, package.json, CI config, etc.) and generates an OPERATOR.md with targeted questions to fill in what it couldn't infer. Appends session discipline to your CLAUDE.md and updates .gitignore.

If the project is already initialized, it asks whether to reinitialize (preserves sessions, proposals, config, and OPERATOR.md).

**Related:** hermit-settings, upgrade

---

### upgrade

Upgrades hermit config and templates after a plugin update.

**Usage:** `/claude-code-hermit:upgrade`
**Auto-triggers:** None

Run this after updating the plugin (`claude plugin install`). It:
1. Detects the version gap between your config and the new plugin
2. Shows what changed (from CHANGELOG.md)
3. Asks about any new settings introduced in the update
4. Refreshes templates and boot scripts
5. Updates the CLAUDE.md session discipline block
6. Handles hermit upgrades if installed

If versions already match, it reports "up to date" and stops.

**Related:** init, hermit-settings

---

## Communication

### channel-responder

Handles inbound messages from Claude Code Channels (Telegram, Discord).

**Usage:** Invoked automatically when a message arrives via a channel
**Auto-triggers:** None (message-driven)

Classifies inbound messages and responds with session context:

| Message Type | Examples | Response |
|---|---|---|
| Status request | "status", "what are you working on?" | Concise SHELL.md summary |
| New instruction | "work on the auth module" | Confirms and updates task |
| Question | "why did you change X?" | Answers with session context |
| Emergency | "stop", "abort" | Halts work, marks session blocked |

Responses are kept to one short paragraph, appropriate for a chat interface. This skill extends as [Claude Code Channels](https://code.claude.com/docs/en/channels) matures.

**Related:** status, brief
