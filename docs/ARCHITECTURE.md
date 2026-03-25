# Architecture: claude-code-hermit

A Claude Code plugin providing session discipline and operational hygiene for autonomous
agents. No custom runtime, no server, no orchestration framework. Just markdown and
JavaScript files that turn Claude Code into a disciplined, session-aware agent.
Domain-specific capabilities (development workflows, specialized agents) are provided
by separate packs such as `claude-code-dev-hermit`.

---

## Architecture Overview

```
 ┌─────────────────────────────────────────────────────────────────────┐
 │                    LAYER 1: CHANNEL SURFACE                        │
 │                                                                    │
 │   Terminal (interactive)    Remote Control (SDK/API)                │
 │   Channels (Telegram/Discord)    Headless (claude -p "...")        │
 └──────────────────────────────┬──────────────────────────────────────┘
                                │
 ┌──────────────────────────────▼──────────────────────────────────────┐
 │                    LAYER 2: SESSION LAYER                          │
 │                                                                    │
 │   sessions/ACTIVE.md ◄── live working state                       │
 │   sessions/S-NNN-REPORT.md ◄── archived handoff artifacts         │
 │                                                                    │
 │   Lifecycle:  start ──► work ──► close ──► archive                │
 └──────────────────────────────┬──────────────────────────────────────┘
                                │
 ┌──────────────────────────────▼──────────────────────────────────────┐
 │                    LAYER 3: AGENT LAYER                            │
 │                                                                    │
 │   session-mgr (Sonnet)   ──  session lifecycle management         │
 │                                                                    │
 │   (Domain packs add specialized agents here)                      │
 └──────────────────────────────┬──────────────────────────────────────┘
                                │
 ┌──────────────────────────────▼──────────────────────────────────────┐
 │                    LAYER 4: SKILLS + HOOKS                         │
 │                                                                    │
 │   Skills:  session, session-start, session-close, status,         │
 │            brief, monitor, heartbeat, hermit-settings,            │
 │            proposal-create, proposal-list, proposal-act,          │
 │            pattern-detect, channel-responder, init, upgrade        │
 │                                                                    │
 │   Hooks:   SessionStart (context load), Stop (cost tracking),     │
 │            Stop (compact suggestion), Stop (session diff),        │
 │            evaluate-session                                       │
 │                                                                    │
 │   Profiles: minimal │ standard │ strict                           │
 └──────────────────────────────┬──────────────────────────────────────┘
                                │
 ┌──────────────────────────────▼──────────────────────────────────────┐
 │                    LAYER 5: REPO ARTIFACTS                         │
 │                                                                    │
 │   CLAUDE.md          ──  agent instructions (always loaded)       │
 │   OPERATOR.md        ──  human-curated project context            │
 │   sessions/          ──  session state and history                 │
 │   proposals/         ──  improvement proposals                    │
 │   templates/         ──  file templates for sessions/proposals    │
 └─────────────────────────────────────────────────────────────────────┘
```

---

## Layer 1: Channel Surface

The plugin is input-agnostic. The same session discipline works regardless of how
the agent is invoked:

| Channel | How it works | Typical use |
|---------|-------------|-------------|
| **Terminal** | `claude` interactive mode | Hands-on development sessions |
| **Remote Control** | Claude Code SDK / API | CI/CD pipelines, automated workflows |
| **Channels** | Telegram, Discord (research preview) | Async operator communication |
| **Headless** | `claude -p "do the thing"` | One-shot scripted tasks |

The `channel-responder` skill handles inbound channel messages by classifying them
(status request, new instruction, question, emergency) and responding with session
context awareness.

All channels converge on the same session state in `sessions/ACTIVE.md`. An operator
can start a session in the terminal, check status via Telegram, and the agent stays
oriented.

---

## Layer 2: Session Layer

This is the plugin's core value proposition. Sessions provide bounded, mission-scoped
work with durable handoff artifacts.

### Session Lifecycle

```
  ┌─────────┐     ┌─────────┐     ┌─────────┐     ┌───────────┐
  │  START   │────►│  WORK   │────►│  CLOSE  │────►│  ARCHIVE  │
  └─────────┘     └─────────┘     └─────────┘     └───────────┘
       │               │               │                │
       ▼               ▼               ▼                ▼
  Create or        Update steps,   Finalize status,  Copy ACTIVE.md
  resume           log progress,   record lessons,   to S-NNN-REPORT.md,
  ACTIVE.md        track blockers  capture cost      reset ACTIVE.md with
                                                     carry-forward items
```

**Start.** The `session-start` skill checks for an existing `sessions/ACTIVE.md`.
If one exists with status `in_progress`, the agent resumes it. If none exists (or the
previous session is `completed`/`blocked`), a fresh session is created from
`templates/ACTIVE.md.template`. The operator provides the mission.

**Work.** During work, `sessions/ACTIVE.md` is the live document. Steps are tracked in
a table with statuses: `planned`, `in_progress`, `blocked`, `done`. A progress log
captures timestamped entries. Blockers are recorded with enough context for cold-start
resumption.

**Close.** The `session-close` skill runs a quality checklist before allowing close:
mission status accurate, changed files listed, blockers documented with context, next
start point is actionable. Cost data from the `cost-tracker` hook is included if
available.

**Archive.** The `session-mgr` agent copies `ACTIVE.md` to `sessions/S-NNN-REPORT.md`
with a sequential ID, then resets `ACTIVE.md` with a fresh template that carries
forward unfinished steps and blockers. The archived report is a complete, self-contained
handoff artifact.

### Why Sessions Matter

Any session -- or any human -- can pick up where the last one left off. The archived
report contains everything needed: what was done, what was not done, what is blocking,
and what to do next. This eliminates the "context amnesia" problem where an agent loses
all working knowledge between invocations.

---

## Layer 3: Agent Layer

One built-in subagent with a defined model tier, tool permissions, and responsibility
scope. Domain packs extend this layer with specialized agents.

### Subagent Summary

| Agent | Model | Isolation | Max Turns | Role |
|-------|-------|-----------|-----------|------|
| `session-mgr` | Sonnet | None | 15 | Session lifecycle, progress tracking |

### Tool Permissions

| Tool | session-mgr |
|------|:-----------:|
| Read | yes |
| Write | yes |
| Edit | yes |
| Bash | yes |
| Glob | yes |
| Grep | yes |
| WebSearch | -- |
| WebFetch | -- |

Key design principle:

- **session-mgr handles lifecycle only.** It creates, updates, and archives session
  files. It does not write code.

### Agent Memory

`session-mgr` uses `memory: project`, meaning it maintains project-scoped memory that
persists across sessions. This accumulated knowledge improves accuracy over time without
consuming context window space.

Domain packs extend this layer. For example, `claude-code-dev-hermit` adds repo-mapper
(Haiku), implementer (Sonnet, worktree-isolated), and reviewer (Sonnet, read-only).

---

## Layer 4: Skills and Hooks

### Skills

Skills are reusable procedures the agent can invoke by name. They encode multi-step
workflows so the agent does not have to re-derive them each session.

| Skill | Purpose | Delegates to |
|-------|---------|-------------|
| `session` | Full session workflow (start → work → close) | `session-mgr` |
| `session-start` | Initialize or resume a session, load context | `session-mgr` |
| `session-close` | Finalize session with quality checklist, archive | `session-mgr` |
| `status` | Compact session summary (auto-triggers on "status") | -- |
| `brief` | 5-line executive summary (auto-triggers on "brief") | -- |
| `monitor` | Session-aware recurring checks via `/loop` | -- |
| `heartbeat` | Background checklist (run/start/stop/status/edit) | -- |
| `hermit-settings` | View/change project config (channels, budget, etc.) | -- |
| `proposal-create` | Create a numbered improvement proposal | -- |
| `proposal-list` | List all proposals with status, source, and age | -- |
| `proposal-act` | Accept, defer, or dismiss a proposal | -- |
| `pattern-detect` | Detect recurring patterns across session reports | -- |
| `channel-responder` | Handle inbound channel messages with session awareness | -- |
| `init` | Initialize project (state directory, config, OPERATOR.md) | -- |
| `upgrade` | Upgrade config and templates after plugin update | -- |

For detailed skill documentation, see [SKILLS.md](SKILLS.md).

### Hooks

Hooks are automated scripts triggered at specific points in the Claude Code lifecycle.
They run without agent intervention.

| Hook | Trigger | File | What it does |
|------|---------|------|-------------|
| Context loader | `SessionStart` | inline (settings.json) | Reads `OPERATOR.md`, `ACTIVE.md`, and latest session report into context |
| Cost tracker | `Stop` | `cost-tracker.js` | Logs token usage and cost to `.claude/cost-log.jsonl`, updates `ACTIVE.md` |
| Compact suggestion | `Stop` | `suggest-compact.js` | Suggests `/compact` when context usage exceeds 60% or tool call count passes threshold |
| Session diff | `Stop` | `session-diff.js` | Auto-populates `## Changed` in `ACTIVE.md` from `git diff` (skips if already populated) |
| Session evaluator | (invocable) | `evaluate-session.js` | Validates `ACTIVE.md` quality: status set, steps tracked, blockers documented, progress logged |

### Hook Profiles

The `AGENT_HOOK_PROFILE` environment variable controls which hooks are active.
Set it in `.claude/settings.json` under `env`.

| Profile | Cost Tracker | Compact Suggestion | Session Diff | Session Evaluation |
|---------|:------------:|:------------------:|:------------:|:------------------:|
| `minimal` | yes | -- | -- | -- |
| `standard` | yes | yes | yes | yes |
| `strict` | yes | yes | yes | yes |

Default: **standard**. Domain packs may register additional hooks that participate in
these profiles (for example, `claude-code-dev-hermit` adds a git push guard under the
strict profile).

The `run-with-profile.js` utility enables profile-gated execution for any hook:

```
node ${CLAUDE_PLUGIN_ROOT}/scripts/run-with-profile.js "standard,strict" scripts/evaluate-session.js
```

This runs `evaluate-session.js` only when `AGENT_HOOK_PROFILE` is `standard` or `strict`.

### Hooks and Subagents

**Verified behavior (Claude Code v2.x):**

> **[PENDING VERIFICATION]**
>
> Does a `PreToolUse` hook fire when a subagent (e.g., implementer)
> invokes a tool (e.g., Bash)?
>
> - If YES: Domain pack hooks provide defense-in-depth alongside
>   agent-level `disallowedTools` and in-prompt forbidden actions.
>   Document this as a reliable safety contract.
> - If NO: Agent-level safety rules (disallowedTools, forbidden actions
>   in agent markdown) are the ONLY enforcement mechanism for subagents.
>   Domain pack hooks are main-session-only guardrails.
>   Document this clearly so pack authors don't build false assumptions.

Pack authors should not assume hooks fire on subagent tool calls until
this is verified. Design agent definitions with self-contained safety
rules (disallowedTools, forbidden actions) as the primary enforcement,
and treat hooks as an additional layer if available.

**Impact by hook event:**

| Hook event   | If fires on subagents                                                       | If doesn't fire                                          |
| ------------ | --------------------------------------------------------------------------- | -------------------------------------------------------- |
| PreToolUse   | Domain pack safety hooks protect subagent actions                           | Agent-level rules are the only safety net                |
| SessionStart | Context-loader runs for subagents (may waste tokens on unnecessary context) | Subagents start with only their agent definition context |
| Stop         | Cost-tracker captures subagent cost separately                              | Subagent cost is rolled into the parent session's total  |

---

## Layer 5: Repo Artifacts

All state lives in git-tracked files. No database, no external service, no ephemeral
state. The repo is the single source of truth.

### Plugin File Map

```
claude-code-hermit/                        # The plugin repo
├── .claude-plugin/
│   └── plugin.json                        # Plugin manifest
├── agents/                                # Subagent definitions
│   └── session-mgr.md                     #   Sonnet session lifecycle
├── hooks/
│   └── hooks.json                         # Hook registrations
├── scripts/                               # Hook implementations
│   ├── cost-tracker.js                    #   Token/cost logging
│   ├── suggest-compact.js                 #   Context window management
│   ├── session-diff.js                     #   Auto-populate changed files
│   ├── evaluate-session.js                #   Session quality validation
│   ├── run-with-profile.js               #   Profile-gated hook wrapper
│   ├── hermit-start.py                    #   Boot script (tmux + channels)
│   └── hermit-stop.py                     #   Graceful shutdown
├── skills/                                # Workflows
│   ├── init/SKILL.md                      #   /claude-code-hermit:init
│   ├── session/SKILL.md                   #   /claude-code-hermit:session
│   ├── session-start/SKILL.md             #   Session initialization
│   ├── session-close/SKILL.md             #   Session finalization
│   ├── status/SKILL.md                    #   Compact session summary
│   ├── brief/SKILL.md                     #   Executive summary
│   ├── monitor/SKILL.md                   #   Session-aware monitoring
│   ├── heartbeat/SKILL.md                 #   Background health checklist
│   ├── hermit-settings/SKILL.md           #   Config management
│   ├── proposal-create/SKILL.md           #   Improvement proposals
│   ├── proposal-list/SKILL.md             #   List proposals with status
│   ├── proposal-act/SKILL.md              #   Accept/defer/dismiss proposals
│   ├── pattern-detect/SKILL.md            #   Cross-session pattern detection
│   └── channel-responder/SKILL.md         #   Channel message handling
└── state-templates/                       # Copied into target projects by init
    ├── ACTIVE.md.template
    ├── SESSION-REPORT.md.template
    ├── PROPOSAL.md.template
    ├── config.json.template
    ├── OPERATOR.md
    ├── HEARTBEAT.md.template
    ├── CLAUDE-APPEND.md
    ├── GITIGNORE-APPEND.txt
    └── bin/                               # Boot script wrappers
        ├── hermit-run                     #   Dispatcher (resolves plugin path)
        ├── hermit-start                   #   Start persistent session
        └── hermit-stop                    #   Graceful shutdown
```

### Per-Project State (after init)

```
your-project/
├── .claude/
│   ├── .claude-code-hermit/
│   │   ├── sessions/ACTIVE.md             # Current session (live state)
│   │   ├── sessions/S-NNN-REPORT.md       # Archived session reports
│   │   ├── sessions/NEXT-MISSION.md        # Prepared mission from accepted proposal (temporary)
│   │   ├── proposals/PROP-NNN.md          # Improvement proposals
│   │   ├── templates/                     # Session and proposal templates
│   │   ├── bin/                           # Boot script wrappers (hermit-start, hermit-stop)
│   │   ├── config.json                    # Project config (channels, budget, etc.)
│   │   ├── OPERATOR.md                    # Human-curated project context
│   │   └── HEARTBEAT.md                   # Background checklist (operator-editable)
│   └── settings.json                      # Existing, untouched
└── CLAUDE.md                              # Session discipline appended
```

Total: ~39 files in the core plugin. No `package.json`, no `node_modules`, no build step.

---

## Memory Model

The plugin uses a three-tier memory model. Each tier serves a different purpose and
has a different owner.

```
┌────────────────────────────────────────────────────────────┐
│                    MEMORY MODEL                            │
│                                                            │
│  ┌──────────────────────────────────────────────────────┐  │
│  │  OPERATOR.md                                        │  │
│  │  Owner: Human                                       │  │
│  │  Contains: Project context, constraints, sensitive   │  │
│  │  areas, naming conventions, preferences              │  │
│  │  Lifetime: Permanent (updated by operator)           │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                            │
│  ┌──────────────────────────────────────────────────────┐  │
│  │  Auto-memory (Claude Code built-in)                 │  │
│  │  Owner: Agent (project-scoped per subagent)         │  │
│  │  Contains: Engineering lessons, codebase patterns,  │  │
│  │  recurring issues, tooling quirks                    │  │
│  │  Lifetime: Persistent across sessions               │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                            │
│  ┌──────────────────────────────────────────────────────┐  │
│  │  sessions/ACTIVE.md                                 │  │
│  │  Owner: Agent (managed by session-mgr)              │  │
│  │  Contains: Current mission, step status, progress   │  │
│  │  log, blockers, discoveries, cost data              │  │
│  │  Lifetime: One session (archived on close)          │  │
│  └──────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────┘
```

**OPERATOR.md** is human-curated context that the agent reads but never modifies. It
contains project identity, hard constraints, sensitive areas, naming conventions, and
operator preferences. The `SessionStart` hook loads it automatically.

**Auto-memory** is Claude Code's built-in project-scoped memory. Each subagent
(configured with `memory: project`) accumulates engineering lessons, codebase patterns,
and recurring issues. These are stored by Claude Code internally and do not clutter
the repo. The rule: engineering lessons go in auto-memory, not in files.

**ACTIVE.md** is the live working document for the current session. It is the
operational state of the agent: what it is doing, what it has done, what is blocking
it. On session close, it is archived as `S-NNN-REPORT.md` and a fresh template is
created with carry-forward items.

---

## Learning Loop

The learning loop connects session reports, proposals, and heartbeat into a feedback
cycle that detects recurring operational problems across sessions.

```
Session closes
  → evaluate-session.js scores the session (existing)
  → pattern-detect skill reads recent reports, compares
  → If pattern found → auto-create proposal + channel alert

Heartbeat ticks
  → heartbeat reads HEARTBEAT.md (existing)
  → After N ticks, self-evaluate checklist effectiveness
  → Suggest removing stale checks, adding relevant ones

Operator reviews
  → /proposal-list shows all proposals (manual + auto-detected)
  → /proposal-act to accept, defer, or dismiss
  → Accepted proposals become session missions via NEXT-MISSION.md
```

### What this is NOT

This is NOT a memory/context system. Claude Code's auto-memory captures technical
patterns and preferences natively. The learning loop operates at a different layer:
analyzing **structured session reports** to detect recurring operational problems,
creating actionable proposals with evidence, and refining the heartbeat checklist.

### Pattern Detection

The `pattern-detect` skill runs at session close (before archiving) and analyzes the
last 5 session reports for four categories of patterns:

1. **Blocker recurrence** — same blocker appearing in 3+ sessions
2. **Workaround repetition** — same workaround applied in 2+ sessions
3. **Cost trends** — last-3 session average >50% higher than prior-3 AND >$1.00 absolute
4. **Tag correlation** — 3+ sessions with the same tag closing as blocked/partial

When a pattern is detected, an auto-proposal is created with `Source: auto-detected`
and `Related Sessions` linking to the evidence. Existing proposals are checked first
to avoid duplicates.

### Feedback Loop Closure

The pattern detector also checks accepted auto-proposals: if the underlying pattern
has not recurred in 3 sessions since acceptance, the proposal is marked `resolved`.
This closes the detect → propose → fix → verify cycle.

### Proposal Lifecycle

```
proposed → accepted → resolved       (pattern fixed, verified)
        → deferred                    (revisit later)
        → dismissed                   (not actionable)
```

Proposals have a `Source` field (`manual` or `auto-detected`) and a `Related Sessions`
field linking to evidence. The `/proposal-list` skill displays them with age and
staleness warnings (open for 10+ sessions). The `/proposal-act` skill handles
accept/defer/dismiss with optional NEXT-MISSION.md creation for accepted proposals.

### Heartbeat Self-Evaluation

The heartbeat tracks a `total_ticks` counter in config.json (persists across sessions).
Every N ticks (configurable, default 20), it evaluates checklist effectiveness:
- Items that were OK for all ticks → suggest removal
- Recent auto-proposals about recurring issues → suggest adding a relevant check

Self-evaluation suggestions are reported, never auto-applied.

---

## Comparison with OpenClaw / Custom Orchestration

This plugin exists because building autonomous agents should not require a custom
orchestration framework.

| Dimension | Custom Orchestration (e.g., OpenClaw) | claude-code-hermit |
|-----------|---------------------------------------|---------------|
| **Runtime** | ~500K lines of Node.js/TypeScript | Zero custom runtime |
| **Dependencies** | npm install, build step, server process | None (uses Claude Code directly) |
| **File count** | Hundreds to thousands | ~25 files |
| **Session management** | Custom database, state machines | Markdown files in git |
| **Agent orchestration** | Custom agent framework, message routing | Claude Code native subagents |
| **Hook system** | Custom middleware pipeline | Claude Code hooks (settings.json) |
| **Memory** | Custom vector store or database | Git-tracked files + Claude Code auto-memory |
| **Deployment** | Container, server, infrastructure | `claude` CLI (already installed) |
| **Maintenance** | Framework updates, dependency audits | Update Claude Code |
| **Portability** | Locked to the framework | Any repo, any project, any language |

The key insight: Claude Code already provides the agent runtime, tool execution,
subagent management, memory, and hook system. The only missing pieces are session
discipline and operational structure. This plugin adds those pieces with plain
markdown and a handful of JavaScript hooks -- no framework required.

### What You Give Up

- No web dashboard (use the terminal or channel integration)
- No built-in metrics visualization (cost data is in `.claude/cost-log.jsonl` -- pipe
  it to whatever you want)
- No multi-tenant isolation (this is a single-operator plugin)
- No custom tool definitions (use Claude Code's native tools or MCP servers)

### What You Gain

- Install it, understand it in 30 minutes, modify it freely
- No version conflicts, no build failures, no dependency vulnerabilities
- Works with any codebase in any language -- install the plugin and go
- Upgrades automatically when Claude Code ships new features
- Session reports are human-readable markdown -- grep them, review them in GitHub,
  feed them to another agent

---

## Skills Reference

| Skill | Auto-triggers | Purpose |
|-------|:------------:|---------|
| `/claude-code-hermit:session` | No | Full session workflow (start → work → close) |
| `/claude-code-hermit:session-start` | No | Initialize or resume a session |
| `/claude-code-hermit:session-close` | No | Close session with quality checklist |
| `/claude-code-hermit:status` | Yes | Compact session summary (< 10 lines) |
| `/claude-code-hermit:brief` | Yes | 5-line executive summary |
| `/claude-code-hermit:monitor` | No | Session-aware recurring checks |
| `/claude-code-hermit:heartbeat` | No | Background checklist (run/start/stop/status/edit) |
| `/claude-code-hermit:hermit-settings` | No | View/change project config |
| `/claude-code-hermit:proposal-create` | No | Create improvement proposal |
| `/claude-code-hermit:proposal-list` | No | List proposals with status, source, and age |
| `/claude-code-hermit:proposal-act` | No | Accept, defer, or dismiss a proposal |
| `/claude-code-hermit:pattern-detect` | No | Detect recurring patterns across session reports |
| `/claude-code-hermit:channel-responder` | Yes | Handle channel messages |
| `/claude-code-hermit:init` | No | Initialize project |
| `/claude-code-hermit:upgrade` | No | Upgrade config and templates after plugin update |

For detailed skill documentation (usage, examples, subcommands), see [SKILLS.md](SKILLS.md).

Domain packs add specialized skills. For example, `claude-code-dev-hermit` provides
`/dev-session` and `/dev-parallel` for software development workflows.

---

## Configuration Reference

### settings.json (key fields)

| Field | Value | Purpose |
|-------|-------|---------|
| `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` | `50` | Auto-compact at 50% context usage |
| `MAX_THINKING_TOKENS` | `10000` | Cap thinking token budget |
| `CLAUDE_CODE_SUBAGENT_MODEL` | `haiku` | Default subagent model (overridden per agent) |
| `AGENT_HOOK_PROFILE` | `standard` | Active hook profile |
| `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` | `1` | Enable Agent Teams |

### Denied operations (settings.json permissions)

- `Bash(rm -rf /)`
- `Bash(git push --force)`
- `Write(.env)`, `Write(*.pem)`, `Write(*.key)`

These are hard blocks that cannot be overridden by the agent.

---

## Getting Started

1. Add the marketplace and install: `claude plugin marketplace add gtapps/claude-code-hermit && claude plugin install claude-code-hermit@claude-code-hermit --scope project`
2. Start Claude Code and run `/claude-code-hermit:init`
3. Edit `.claude/.claude-code-hermit/OPERATOR.md` with your project context
4. Run `/claude-code-hermit:session` to start your first session
5. Provide a mission and let it work

For software development workflows, also install `claude-code-dev-hermit`, which adds
the repo-mapper, implementer, and reviewer agents along with `/dev-session` and
`/dev-parallel` skills.

No build step. Configuration lives in `OPERATOR.md` (project context) and
`.claude/.claude-code-hermit/config.json` (preferences — created by the init wizard).

---

## Known Limitations

Issues identified during review that are acceptable for now but should be addressed
if the plugin sees heavy autonomous use.

### 1. O(n) cost-log scan

`scripts/cost-tracker.js` — `getCumulativeCost()` reads the entire `.claude/cost-log.jsonl`
and sums every line on every Stop hook invocation. For short sessions (50–200 entries)
this is instant. For always-on agents running for months, the file could grow to thousands
of entries, causing noticeable latency on each hook call.

**Future fix:** Keep a sidecar file (e.g., `.claude/cost-summary.json`) with
`{ "total_cost": 12.34, "total_tokens": 500000 }`. Each invocation reads the tiny sidecar,
adds the new increment, writes it back. One small read + write instead of parsing the full
log.

### 2. Boot script timing assumptions

`scripts/hermit-start.py` — after starting Claude in tmux, the script `sleep(3)` then
sends `/claude-code-hermit:session` via `tmux send-keys`. There is no way to verify
Claude is actually ready to accept input. On slow hardware, in containers under load,
or with a large CLAUDE.md, 3 seconds may not be enough — the keystrokes land in the
terminal buffer and may be lost.

**Future fix:** Poll `tmux capture-pane` for Claude's prompt character before sending
commands. Alternatively, make the delay configurable via `config.json`
(e.g., `boot_delay_seconds`).

### 3. Silent cost-log corruption

`scripts/cost-tracker.js` — when parsing `cost-log.jsonl`, malformed lines (e.g.,
truncated JSON from a crash mid-write) are silently skipped. If multiple entries are
corrupted, cumulative cost under-reports without any warning. This matters most when
budget enforcement is active — the 80%/100% warnings could fire late.

**Future fix:** Count skipped lines during the parse loop and emit a single
`console.error` if `skipped > 0` (e.g., `"[cost-tracker] Warning: 10 malformed entries
in cost-log.jsonl skipped"`). Low noise in the normal case, surfaced when something is
wrong.
