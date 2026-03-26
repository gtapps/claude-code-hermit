# Architecture

A Claude Code plugin providing session discipline and operational hygiene for autonomous agents. No custom runtime, no server. Just markdown and JavaScript files on top of everything [Claude Code already provides](https://code.claude.com/docs/en/plugins).

---

## Overview

```
 ┌─────────────────────────────────────────────────────────────────────┐
 │                    LAYER 1: CHANNEL SURFACE                        │
 │   Terminal    Remote Control    Channels (Telegram/Discord)        │
 │   Headless (claude -p "...")                                       │
 └──────────────────────────────┬──────────────────────────────────────┘
                                │
 ┌──────────────────────────────▼──────────────────────────────────────┐
 │                    LAYER 2: SESSION LAYER                          │
 │   sessions/SHELL.md ◄── live state                                │
 │   sessions/S-NNN-REPORT.md ◄── archived handoff artifacts         │
 │   Lifecycle:  start ──► work ──► close ──► archive                │
 └──────────────────────────────┬──────────────────────────────────────┘
                                │
 ┌──────────────────────────────▼──────────────────────────────────────┐
 │                    LAYER 3: AGENT LAYER                            │
 │   session-mgr (Sonnet) — session lifecycle management             │
 │   (Hermits add specialized agents here)                           │
 └──────────────────────────────┬──────────────────────────────────────┘
                                │
 ┌──────────────────────────────▼──────────────────────────────────────┐
 │                    LAYER 4: SKILLS + HOOKS                         │
 │   15 skills    4 hooks    3 profiles (minimal/standard/strict)    │
 └──────────────────────────────┬──────────────────────────────────────┘
                                │
 ┌──────────────────────────────▼──────────────────────────────────────┐
 │                    LAYER 5: REPO ARTIFACTS                         │
 │   CLAUDE.md • OPERATOR.md • sessions/ • proposals/ • templates/   │
 └─────────────────────────────────────────────────────────────────────┘
```

---

## Layer 1: Channel Surface

The plugin is input-agnostic. Same session discipline regardless of how the agent is invoked.

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
START → WORK → CLOSE → ARCHIVE
  │       │       │        │
  ▼       ▼       ▼        ▼
Create   Update  Finalize  Copy to
SHELL.md plan,   status,   S-NNN-REPORT.md,
         log     lessons   reset SHELL.md
```

**Start:** Checks for existing SHELL.md. Resumes if `in_progress`, creates fresh if not. Loads OPERATOR.md.

**Work:** Plan items tracked as `planned` → `in_progress` → `blocked` → `done`. Timestamped progress log. Blockers recorded with cold-start context.

**Close:** Quality checklist, lessons, proposals. Defaults to idle transition at every task boundary — session says "What's next?" and waits. Full shutdown only via `/session-close`. See [ALWAYS-ON-OPS.md](ALWAYS-ON-OPS.md#2-always-on-lifecycle).

**Archive:** SHELL.md → `S-NNN-REPORT.md`. Fresh template with carry-forward items. Any session can pick up where the last one left off.

---

## Layer 3: Agent Layer

| Agent         | Model  | Max Turns | Role                                 |
| ------------- | ------ | --------- | ------------------------------------ |
| `session-mgr` | Sonnet | 15        | Session lifecycle, progress tracking |

Tools: Read, Write, Edit, Bash, Glob, Grep. No web access. Uses `memory: project` for accumulated knowledge across sessions.

Hermits extend this layer with specialized agents (e.g., `claude-code-dev-hermit` adds repo-mapper, implementer, reviewer).

---

## Layer 4: Skills and Hooks

### Skills (15)

See [Skills Reference](SKILLS.md) for the full list.

### Hooks

| Hook               | Trigger      | What it does                                        |
| ------------------ | ------------ | --------------------------------------------------- |
| Context loader     | SessionStart | Loads OPERATOR.md, SHELL.md, latest report          |
| Cost tracker       | Stop         | Logs tokens/cost, updates SHELL.md, enforces budget |
| Compact suggestion | Stop         | Suggests `/compact` at 60% context usage            |
| Session diff       | Stop         | Auto-populates `## Changed` from `git diff`         |
| Session evaluator  | Stop         | Validates SHELL.md quality                          |

### Hook profiles

| Profile  | Cost | Compact | Diff | Evaluation |
| -------- | ---- | ------- | ---- | ---------- |
| minimal  | ✓    | —       | —    | —          |
| standard | ✓    | ✓       | ✓    | ✓          |
| strict   | ✓    | ✓       | ✓    | ✓          |

Hermits may add hooks at `strict` (e.g., git-push-guard). Use `run-with-profile.js` for profile-gated execution.

---

## Layer 5: Repo Artifacts

All state in git-tracked files. No database, no external service.

### Plugin file map

```
claude-code-hermit/
├── agents/session-mgr.md
├── hooks/hooks.json
├── scripts/               # Hook implementations + boot scripts
├── skills/                 # 15 skill directories
├── state-templates/        # Copied into projects by init
└── .claude-plugin/plugin.json
```

### Per-project state (after init)

```
your-project/
├── .claude/.claude-code-hermit/
│   ├── sessions/SHELL.md, S-NNN-REPORT.md
│   ├── proposals/PROP-NNN.md
│   ├── templates/
│   ├── bin/hermit-start, hermit-stop
│   ├── config.json
│   ├── OPERATOR.md
│   └── HEARTBEAT.md
└── CLAUDE.md (session discipline appended)
```

~39 files total. No `package.json`, no `node_modules`, no build step.

---

## Memory Model

```
┌──────────────────────────────────────────────┐
│  OPERATOR.md                                 │
│  Owner: Human. Lifetime: permanent.          │
│  Project context, constraints, preferences.  │
├──────────────────────────────────────────────┤
│  Auto-memory (Claude Code built-in)          │
│  Owner: Agent. Lifetime: persistent.         │
│  Engineering lessons, codebase patterns.     │
├──────────────────────────────────────────────┤
│  sessions/SHELL.md                           │
│  Owner: Agent. Lifetime: one session.        │
│  Task, plan, progress, blockers, cost.       │
└──────────────────────────────────────────────┘
```

OPERATOR.md is human-curated — the agent reads but never modifies it. Auto-memory is Claude Code's built-in [persistent memory](https://code.claude.com/docs/en/sub-agents). SHELL.md is the live working document, archived on close.

---

## Learning Loop

```
Session closes → pattern-detect reads recent reports → auto-proposal if pattern found
                                                              │
Heartbeat ticks → self-evaluates checklist every 20 ticks     │
                                                              │
Operator reviews → /proposal-act accept/defer/dismiss         │
                → accepted proposal becomes NEXT-TASK.md      │
                                                              │
3 sessions pass without recurrence → auto-resolved ───────────┘
```

Pattern detection analyzes the last 5 reports for: blocker recurrence (3+ sessions), workaround repetition (2+), cost trends (>50% increase AND >$1.00), tag correlation (3+ sessions with same tag closing blocked/partial).

This is NOT a memory system — Claude Code's auto-memory handles that natively. The learning loop operates on **structured session reports** to detect operational problems and create actionable proposals.

---

## What You Give Up / What You Gain

**Give up:** No web dashboard, no metrics visualization, no multi-tenant isolation, no custom tool definitions (use Claude Code's native tools or [MCP servers](https://code.claude.com/docs/en/mcp)).

**Gain:** Understand it in 30 minutes. No version conflicts, no build failures. Works with any codebase in any language. Session reports are human-readable markdown — grep them, review in GitHub, feed to another agent.

---

## Configuration Reference

### settings.json

| Field                             | Value      | Purpose                     |
| --------------------------------- | ---------- | --------------------------- |
| `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` | `50`       | Auto-compact at 50% context |
| `MAX_THINKING_TOKENS`             | `10000`    | Cap thinking budget         |
| `CLAUDE_CODE_SUBAGENT_MODEL`      | `haiku`    | Default subagent model      |
| `AGENT_HOOK_PROFILE`              | `standard` | Active hook profile         |

### Denied operations

`rm -rf /`, `git push --force`, `Write(.env)`, `Write(*.pem)`, `Write(*.key)` — hard blocks, cannot be overridden.

---

## Known Limitations

1. **O(n) cost-log scan** — `cost-tracker.js` reads the full `.claude/cost-log.jsonl` on every Stop hook. Fine for short sessions, slow for months-long always-on agents. Fix: sidecar summary file.

2. **Boot script timing** — `hermit-start.py` waits 3 seconds before sending commands to tmux. May not be enough on slow hardware. Fix: poll `tmux capture-pane` for readiness.

3. **Silent cost-log corruption** — Malformed JSONL lines are silently skipped. If multiple entries corrupt, budget warnings fire late. Fix: count and log skipped lines.
