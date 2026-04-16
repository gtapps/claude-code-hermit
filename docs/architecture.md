# Architecture

A Claude Code plugin that turns any Claude Code instance into a self-improving personal assistant. No custom runtime, no server. Just markdown and JavaScript files on top of everything [Claude Code already provides](https://code.claude.com/docs/en/plugins).

---

## Overview

```
 +-----------------------------------------------------------------+
 |                    LAYER 1: CHANNEL SURFACE                      |
 |   Terminal    Remote Control    Channels (Telegram/Discord)      |
 |   Headless (claude -p "...")                                     |
 +-------------------------------|----------------------------------+
                                 |
 +-------------------------------v----------------------------------+
 |                    LAYER 2: SESSION LAYER                        |
 |   sessions/SHELL.md <-- live state                               |
 |   sessions/S-NNN-REPORT.md <-- archived handoff artifacts        |
 |   Lifecycle:  start --> work --> close --> archive                |
 +-------------------------------|----------------------------------+
                                 |
 +-------------------------------v----------------------------------+
 |                    LAYER 3: AGENT LAYER                          |
 |   session-mgr (Sonnet) -- session lifecycle management           |
 |   (Hermits add specialized agents here)                          |
 +-------------------------------|----------------------------------+
                                 |
 +-------------------------------v----------------------------------+
 |                    LAYER 4: SKILLS + HOOKS                       |
 |   26 skills    3 hook phases    3 profiles (minimal/standard/strict)   |
 +-------------------------------|----------------------------------+
                                 |
 +-------------------------------v----------------------------------+
 |                    LAYER 5: REPO ARTIFACTS                       |
 |   CLAUDE.md - OPERATOR.md - sessions/ - proposals/ - templates/  |
 +-----------------------------------------------------------------+
```

---

## Layer 1: Channel Surface

Input-agnostic. Same session discipline regardless of how your hermit is invoked.

| Channel                                                          | Use                                  |
| ---------------------------------------------------------------- | ------------------------------------ |
| Terminal                                                         | Interactive sessions                 |
| [Remote Control](https://code.claude.com/docs/en/remote-control) | Browser/phone access                 |
| [Channels](https://code.claude.com/docs/en/channels)             | Telegram, Discord, iMessage          |
| Headless                                                         | `claude -p "..."` for scripted tasks |

All channels converge on the same `sessions/SHELL.md`.

---

## Layer 2: Session Layer

Sessions provide bounded, task-scoped work with durable handoff artifacts.

```
START -> WORK -> CLOSE -> ARCHIVE
  |       |       |        |
  v       v       v        v
Create   Update  Finalize  Copy to
SHELL.md tasks,  status,   S-NNN-REPORT.md,
         log     lessons   reset SHELL.md
```

**Start:** Checks for existing SHELL.md. Resumes if `in_progress` or `waiting`, creates fresh if not. Loads OPERATOR.md. Calls `TaskList` to see plan steps. Runs morning routine if it hasn't fired today.

**Work:** Plan items tracked as native Claude Code Tasks (`pending` -> `in_progress` -> `completed`). Timestamped progress log in SHELL.md. Blockers recorded with cold-start context. `tasks-snapshot.md` auto-updated by cost-tracker hook for Obsidian.

**Close:** Defaults to idle transition at every task boundary — your hermit says "What's next?" and waits. Reflection fires. Full shutdown only via `/session-close`. See [Always-On Lifecycle](always-on-ops.md#2-always-on-lifecycle).

**Archive:** SHELL.md + task table -> `S-NNN-REPORT.md`. Fresh template with carry-forward. Monitoring and Session Summary sections are compacted if over threshold (configurable via `compact` in config.json). On full close, unfinished tasks persist in the task list for the next session.

---

## Layer 3: Agent Layer

| Agent         | Model  | Max Turns | Role                                 |
| ------------- | ------ | --------- | ------------------------------------ |
| `session-mgr` | Sonnet | 15        | Session lifecycle, progress tracking |

Tools: Read, Write, Edit, Bash, Glob, Grep. No web access. Uses `memory: project` for accumulated knowledge across sessions.

Hermits extend this layer with specialized agents (e.g., `claude-code-dev-hermit` adds repo-mapper, implementer, reviewer).

---

## Layer 4: Skills and Hooks

### Skills (26)

See [Skills Reference](skills.md) for the full list.

### Hooks

| Hook                | Trigger      | Profile   | What it does                                           |
| ------------------- | ------------ | --------- | ------------------------------------------------------ |
| Deny enforcer       | PreToolUse   | strict    | Blocks banned bash patterns before execution           |
| Channel hook        | PostToolUse  | strict    | Forwards tool events to configured channel             |
| Heartbeat touch     | PostToolUse  | strict    | Marks activity for heartbeat gap detection             |
| Contract tests      | PostToolUse  | strict    | Runs plugin contract tests after changes               |
| Config validator    | PostToolUse  | strict    | Validates config.json after mutations                  |
| Context loader      | SessionStart | all       | Loads OPERATOR.md, SHELL.md, latest report, cost data  |
| Cost tracker        | Stop         | all       | Logs tokens/cost, enforces budget                      |
| Compact suggestion  | Stop         | standard+ | Suggests `/compact` at 60% context usage               |
| Session diff        | Stop         | standard+ | Auto-populates `## Changed` from `git diff`            |
| Session evaluator   | Stop         | standard+ | Validates SHELL.md quality, detects zombie/stale/bloat |
| Routine queue flush | Stop         | all       | Dequeues pending routines when session goes idle       |

Hermits may add hooks at `strict` (e.g., git-push-guard). Use `run-with-profile.js` for profile-gated execution.

---

## Layer 5: Repo Artifacts

All state lives in git-tracked files. No database, no external service.

### Plugin file map

```
claude-code-hermit/
├── agents/session-mgr.md
├── hooks/hooks.json
├── scripts/               # Hook implementations + boot scripts
├── skills/                 # 26 skill directories
├── state-templates/        # Copied into projects by init
└── .claude-plugin/plugin.json
```

### Per-project state (after init)

```
your-project/
├── .claude-code-hermit/
│   ├── sessions/SHELL.md, S-NNN-REPORT.md
│   ├── proposals/PROP-NNN.md
│   ├── reviews/weekly-YYYY-WNN.md        # Weekly review reports (weekly-review.js)
│   ├── templates/
│   ├── state/                        # Runtime observations (agent-owned, not operator-configured)
│   │   ├── runtime.json              # Session state: in_progress/waiting/idle (authoritative since v0.3.2)
│   │   ├── alert-state.json          # Alert dedup state + self-eval evidence (heartbeat-owned)
│   │   ├── reflection-state.json     # Last reflection timestamp (reflect-owned)
│   │   ├── routine-queue.json        # Queued routines pending execution (routine-watcher-owned)
│   │   ├── channel-activity.json     # Last channel interaction timestamp (channel-hook-owned)
│   │   ├── session-diff.json         # Uncommitted file tracking (session-diff-owned)
│   │   ├── proposal-metrics.jsonl    # Append-only event log (proposal-create + proposal-act)
│   │   ├── micro-proposals.json      # Single-slot micro-approval queue (reflect + channel-responder)
│   │   ├── state-summary.md          # Auto-generated health snapshot (generate-summary.js)
│   │   ├── monitors.runtime.json     # Active watch registry, cleared on session start (watch-owned)
│   │   ├── .heartbeat                # Activity marker (heartbeat-touch-owned)
│   │   └── .lifecycle.lock           # Always-on lifecycle lock (hermit-start-owned)
│   ├── bin/hermit-start, hermit-stop
│   ├── config.json
│   ├── cortex-manifest.json          # Obsidian Cortex index (optional, created by obsidian-setup)
│   ├── OPERATOR.md
│   └── HEARTBEAT.md
└── CLAUDE.md (session discipline appended)
```

No `package.json`, no `node_modules`, no build step.

#### state/ ownership model

One writer per state file. No shared mutation bus.

| File                           | Owner (sole writer)                                 | Readers                                                       |
| ------------------------------ | --------------------------------------------------- | ------------------------------------------------------------- |
| `state/runtime.json`           | session-mgr + cost-tracker                          | heartbeat, session-start, routine-watcher                     |
| `state/alert-state.json`       | heartbeat only                                      | heartbeat; evaluate-session (read-only nudge computation)     |
| `state/reflection-state.json`  | reflect + session (non-overlapping phases)          | heartbeat (debounce), hermit-settings (plugin-checks display) |
| `state/routine-queue.json`     | routine-watcher only                                | routine-watcher                                               |
| `state/channel-activity.json`  | channel-hook.js only                                | channel-responder, heartbeat                                  |
| `state/session-diff.json`      | session-diff.js only                                | session-close (display)                                       |
| `state/proposal-metrics.jsonl` | proposal-create + proposal-act (append only)        | generate-summary.js                                           |
| `state/micro-proposals.json`   | reflect (queue) + channel-responder/brief (resolve) | brief, generate-summary.js                                    |
| `state/state-summary.md`       | generate-summary.js only                            | Obsidian, humans                                              |
| `state/monitors.runtime.json`  | watch skill only                                    | session-start (clear on start), session-close (stop all)      |
| `state/.heartbeat`             | heartbeat-touch.js only                             | heartbeat (detect activity gaps)                              |
| `state/.lifecycle.lock`        | hermit-start.py only                                | hermit-stop.py (cleanup)                                      |

---

## Memory Model

```
+----------------------------------------------+
|  OPERATOR.md                                 |
|  Owner: Human. Lifetime: permanent.          |
|  Project context, priorities, constraints.   |
+----------------------------------------------+
|  Auto-memory (Claude Code built-in)          |
|  Owner: Agent. Lifetime: persistent.         |
|  Engineering lessons, codebase patterns,     |
|  operational experience. Primary input       |
|  for reflection.                             |
+----------------------------------------------+
|  compiled/                                   |
|  Owner: Agent. Lifetime: managed.            |
|  Durable domain outputs — briefings,         |
|  decisions, postmortems, assessments.        |
|  Visible in Cortex. Injected on startup.     |
+----------------------------------------------+
|  sessions/SHELL.md                           |
|  Owner: Agent. Lifetime: one session.        |
|  Task, plan, progress, blockers, findings.   |
+----------------------------------------------+
|  sessions/S-NNN-REPORT.md                    |
|  Owner: Agent. Lifetime: permanent.          |
|  Archived journals. Cold-start safety net.   |
+----------------------------------------------+
```

OPERATOR.md is human-curated — your hermit reads it but never modifies it. Auto-memory is Claude Code's built-in [persistent memory](https://code.claude.com/docs/en/sub-agents) and the primary input to learning. `compiled/` is for durable domain outputs the operator wants surfaced across sessions and in Cortex — distinct from auto-memory, which handles operational lessons. SHELL.md is the live working document. Reports are the journal and cold-start safety net — not the input to learning.

### Knowledge directories

```
.claude-code-hermit/
  raw/          # Domain inputs (fetched data, snapshots, logs) — ephemeral
    .archive/   # Expired raw artifacts, moved by archive-raw.js
  compiled/     # Domain outputs (briefings, decisions, assessments) — durable
  knowledge-schema.md  # Per-hermit behavioral schema: what to produce and when
```

**Ownership boundary:** Claude Code memory owns instructions, preferences, and recurring operating context; hermit knowledge owns domain artifacts; skills own procedures.

**Scope boundary:**

| Concern | Owner |
|---------|-------|
| Operational learning (lessons, patterns, preferences) | Auto-memory |
| Durable domain outputs the operator wants in Cortex | `compiled/` |
| Domain operational inputs | `raw/` |
| Session state | `state/` |

`compiled/` artifacts use the [Section E frontmatter contract](frontmatter-contract.md#e-cortex-connected-custom-artifact) extended with a `type` field. Startup injection reads `compiled/` frontmatter and injects the newest artifact of each type within the configured char budget (`knowledge.compiled_budget_chars`, default 1000). Artifacts tagged `foundational` are always injected first.

---

## Learning Loop

```
Reflection fires -> three-outcome decision:
    ^                  |
    | Triggers:        +-> no action (nothing notable)
    | - Task boundary  +-> memory update (lesson learned)
    | - Heartbeat idle +-> proposal candidate -> tier classification:
    | - Evening routine|                          |
    | - Session close  |    Tier 1 (silent) ------+-> act directly (reversible/routine)
    |                  |    Tier 2 (micro) -------+-> channel yes/no (meaningful/non-critical)
    |                  |    Tier 3 (full PROP) ---+-> operator review via proposal-act
    |                  |                               |
    |                  |    Three-condition gate:       |
    |                  |    1. Repeated pattern         |
    |                  |    2. Meaningful consequence    |
    |                  |    3. Operator-actionable       |
    |                  |                               v
    |                  +---- /proposal-act accept/defer/dismiss
    |                        -> accepted -> NEXT-TASK.md -> idle agency
    |                                                            |
    +---- Memory shows no recurrence -> auto-resolved -----------+
```

Reflection uses auto-memory as primary input. Your hermit reflects on what it remembers: recurring blockers, repeated workarounds, cost patterns, workflow friction. Evidence is conversational ("I've hit this repeatedly") rather than citation-based.

**Three-condition gate:** Every proposal candidate must satisfy three conditions: (1) repeated pattern observed across sessions, (2) meaningful consequence if left unaddressed, and (3) an operator-actionable change. This prevents trivial or one-off observations from cluttering the proposal pipeline.

**Micro-proposals (tier 2):** For changes that are meaningful but not safety-critical, reflect queues a micro-proposal — a single yes/no question sent via channel. One slot at a time (`state/micro-proposals.json`). Ignored micro-proposals expire after 2 morning briefs.

Hermit provides the **timing infrastructure** (when to reflect), the **proposal pipeline** (structured proposals with an operator gate), and the **tier classification** (which proposals need what level of approval). Claude handles the intelligence — noticing patterns, assessing confidence, formulating proposals.

### Daily Rhythm

Morning routine (configurable time, default: active hours start + 30m): brief, proposal review, priority check, pending micro-proposal surfaced.
Evening routine (configurable time, default: active hours end - 30m): daily journal archived as S-NNN, reflection, preparation for tomorrow.

Both are managed by the routine watcher (shell-level, not LLM-dependent). Fire once per day at exact times. Routines that fire during `in_progress` are queued to `state/routine-queue.json` and dequeued when idle. A daily 4am `heartbeat-restart` routine prevents silent `/loop` expiry in always-on deployments.

---

## What You Give Up / What You Gain

**Give up:** No web dashboard, no metrics visualization, no multi-tenant isolation, no custom tool definitions (use Claude Code's native tools or [MCP servers](https://code.claude.com/docs/en/mcp)).

**Gain:** Understand it in 30 minutes. No version conflicts, no build failures. Works with any codebase in any language. Session reports are human-readable markdown — grep them, review in GitHub, feed to another agent.

---

## Configuration Reference

### Environment Variable Flow

```
config.json "env"  →  hermit-start.py  →  .claude/settings.local.json "env"  →  Claude Code  →  hooks, Bash tool calls
                   →  shell env (tmux temp file / Docker environment:)  →  MCP servers
```

1. Operator configures env vars in `config.json` `env` (or via `/hermit-settings env`)
2. `hermit-start.py` writes all `config["env"]` values into `.claude/settings.local.json` `env`
3. Claude Code reads `settings.local.json` and exports `env` values to hooks and Bash tool calls
4. For vars that MCP servers need (`*_STATE_DIR`), `hermit-start.py` also forwards them as OS env vars (tmux temp file or Docker compose `environment:`) — MCP servers are separate processes that inherit shell env but do NOT read `settings.local.json`

**Bucket A (shell env only):** `CLAUDE_CONFIG_DIR`, `ANTHROPIC_API_KEY` — must be in shell env before `claude` starts. Forwarded via temp file in tmux, or Docker `environment:`. OAuth credentials live in `.credentials.json` (written by `claude login`), not in env vars.

**Bucket B (settings.local.json only):** `AGENT_HOOK_PROFILE`, `COMPACT_THRESHOLD`, `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`, `MAX_THINKING_TOKENS` — consumed by hooks and Claude Code itself.

**Bucket C (derived at boot, written to both):** `DISCORD_STATE_DIR`, `TELEGRAM_STATE_DIR` — derived by `hermit-start` from `channels.<name>.state_dir` in config.json (relative paths resolved against project root). Written to `settings.local.json` for hooks and forwarded into the tmux shell env (or Docker compose `environment:`) for MCP servers (channel plugins), which inherit shell env but don't read `settings.local.json`.

### config.json env defaults

| Field                             | Value      | Purpose                                            |
| --------------------------------- | ---------- | -------------------------------------------------- |
| `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` | `50`       | Auto-compact at 50% context                        |
| `MAX_THINKING_TOKENS`             | `10000`    | Cap thinking budget                                |
| `AGENT_HOOK_PROFILE`              | `standard` | Active hook profile                                |
| `COMPACT_THRESHOLD`               | `50`       | Compaction suggestion threshold                    |
| `DISCORD_STATE_DIR`               | (derived)  | Derived from `channels.discord.state_dir` at boot  |
| `TELEGRAM_STATE_DIR`              | (derived)  | Derived from `channels.telegram.state_dir` at boot |

### Denied operations

Deny patterns block dangerous operations regardless of permission mode. See [Security](security.md) for the full deny list and defense-in-depth model.

---

## Known Limitations

1. **O(n) cost-log scan** — `cost-tracker.js` reads the full `.claude/cost-log.jsonl` on every Stop hook. Fine for short sessions, slow for months-long always-on agents. Fix: sidecar summary file.

2. **Boot script timing** — `hermit-start.py` waits 3 seconds before sending commands to tmux. May not be enough on slow hardware. Fix: poll `tmux capture-pane` for readiness.

3. **Silent cost-log corruption** — Malformed JSONL lines are silently skipped. If multiple entries corrupt, budget warnings fire late. Fix: count and log skipped lines.
