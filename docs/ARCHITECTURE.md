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
 |   15 skills    5 hooks    3 profiles (minimal/standard/strict)   |
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
SHELL.md plan,   status,   S-NNN-REPORT.md,
         log     lessons   reset SHELL.md
```

**Start:** Checks for existing SHELL.md. Resumes if `in_progress`, creates fresh if not. Loads OPERATOR.md. Runs morning routine if it hasn't fired today.

**Work:** Plan items tracked as `planned` -> `in_progress` -> `blocked` -> `done`. Timestamped progress log. Blockers recorded with cold-start context.

**Close:** Defaults to idle transition at every task boundary — your hermit says "What's next?" and waits. Reflection fires. Full shutdown only via `/session-close`. See [Always-On Lifecycle](ALWAYS-ON-OPS.md#2-always-on-lifecycle).

**Archive:** SHELL.md -> `S-NNN-REPORT.md`. Fresh template with carry-forward items. Any session can pick up where the last one left off.

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
| minimal  | yes  | --      | --   | --         |
| standard | yes  | yes     | yes  | yes        |
| strict   | yes  | yes     | yes  | yes        |

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
├── skills/                 # 15 skill directories
├── state-templates/        # Copied into projects by init
└── .claude-plugin/plugin.json
```

### Per-project state (after init)

```
your-project/
├── .claude-code-hermit/
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
|  sessions/SHELL.md                           |
|  Owner: Agent. Lifetime: one session.        |
|  Task, plan, progress, blockers, cost.       |
+----------------------------------------------+
|  sessions/S-NNN-REPORT.md                    |
|  Owner: Agent. Lifetime: permanent.          |
|  Archived journals. Cold-start safety net.   |
+----------------------------------------------+
```

OPERATOR.md is human-curated — your hermit reads it but never modifies it. Auto-memory is Claude Code's built-in [persistent memory](https://code.claude.com/docs/en/sub-agents) and the primary input to learning. SHELL.md is the live working document. Reports are the journal and cold-start safety net — not the input to learning.

---

## Learning Loop

```
Reflection fires -> auto-proposal if pattern noticed
    ^                        |
    | Triggers:              |
    | - Task boundaries      |
    | - Heartbeat idle (4h+) |
    | - Evening routine      |
    | - Session close        |
    |                        |
Operator reviews -> /proposal-act accept/defer/dismiss
                 -> accepted proposal becomes NEXT-TASK.md
                 -> idle agency picks it up automatically
                                                      |
Memory shows no recurrence -> auto-resolved ----------+
```

Reflection uses auto-memory as primary input. Your hermit reflects on what it remembers: recurring blockers, repeated workarounds, cost patterns, workflow friction. Evidence is conversational ("I've hit this repeatedly") rather than citation-based.

Hermit provides the **timing infrastructure** (when to reflect) and the **proposal pipeline** (structured proposals with an operator gate). Claude handles the intelligence — noticing patterns, assessing confidence, formulating proposals.

### Daily Rhythm

Morning routine (first heartbeat tick of active hours): brief, proposal review, priority check.
Evening routine (last heartbeat tick): daily journal archived as S-NNN, reflection, preparation for tomorrow.

Both fire once per day based on `active_hours` in config.

---

## What You Give Up / What You Gain

**Give up:** No web dashboard, no metrics visualization, no multi-tenant isolation, no custom tool definitions (use Claude Code's native tools or [MCP servers](https://code.claude.com/docs/en/mcp)).

**Gain:** Understand it in 30 minutes. No version conflicts, no build failures. Works with any codebase in any language. Session reports are human-readable markdown — grep them, review in GitHub, feed to another agent.

---

## Configuration Reference

### Environment Variable Flow

```
config.json "env"  →  hermit-start.py  →  .claude/settings.local.json "env"  →  Claude Code  →  subprocesses
```

1. Operator configures env vars in `config.json` `env` (or via `/hermit-settings env`)
2. `hermit-start.py` reads `config["env"]` and merges into `.claude/settings.local.json` `env`
3. Claude Code reads `settings.local.json` and exports `env` values to all subprocesses
4. Hooks, MCP servers, and Bash tool calls inherit these via `process.env`

**Bucket A (shell env only):** `CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY` — must be in shell env before `claude` starts. Forwarded via temp file in tmux, or Docker `environment:`.

**Bucket B+C (settings.local.json):** All other env vars — managed in `config.json` `env`, written to `settings.local.json` by `hermit-start`.

### config.json env defaults

| Field                             | Value      | Purpose                     |
| --------------------------------- | ---------- | --------------------------- |
| `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` | `50`       | Auto-compact at 50% context |
| `MAX_THINKING_TOKENS`             | `10000`    | Cap thinking budget         |
| `AGENT_HOOK_PROFILE`              | `standard` | Active hook profile         |
| `COMPACT_THRESHOLD`               | `50`       | Compaction suggestion threshold |
| `DISCORD_STATE_DIR`               | (dynamic)  | Set when discord channel configured |
| `TELEGRAM_STATE_DIR`              | (dynamic)  | Set when telegram channel configured |

### Denied operations

`rm -rf /`, `git push --force`, `Write(.env)`, `Write(*.pem)`, `Write(*.key)` — hard blocks, cannot be overridden.

---

## Known Limitations

1. **O(n) cost-log scan** — `cost-tracker.js` reads the full `.claude/cost-log.jsonl` on every Stop hook. Fine for short sessions, slow for months-long always-on agents. Fix: sidecar summary file.

2. **Boot script timing** — `hermit-start.py` waits 3 seconds before sending commands to tmux. May not be enough on slow hardware. Fix: poll `tmux capture-pane` for readiness.

3. **Silent cost-log corruption** — Malformed JSONL lines are silently skipped. If multiple entries corrupt, budget warnings fire late. Fix: count and log skipped lines.
