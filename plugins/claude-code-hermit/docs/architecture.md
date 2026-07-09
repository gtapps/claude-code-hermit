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
 |   skills       3 hook phases    3 profiles (minimal/standard/strict)   |
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

**Work:** Plan items tracked as native Claude Code Tasks (`pending` -> `in_progress` -> `completed`). Timestamped progress log in SHELL.md. Blockers recorded with cold-start context. `tasks-snapshot.md` auto-updated by cost-tracker hook.

**Close:** Defaults to idle transition at every task boundary — your hermit says "What's next?" and waits. Reflection fires. Full shutdown only via `/session-close`. See [Always-On Lifecycle](always-on-ops.md#2-always-on-lifecycle).

**Archive:** SHELL.md + task table -> `S-NNN-REPORT.md`. Fresh template with carry-forward. Monitoring and Session Summary sections are compacted if over threshold (configurable via `compact` in config.json). On full close, unfinished tasks persist in the task list for the next session.

---

## Layer 3: Agent Layer

| Agent                    | Model  | Max Turns | Role                                                                              |
| ------------------------ | ------ | --------- | --------------------------------------------------------------------------------- |
| `session-mgr`            | Sonnet | 15        | Session lifecycle, progress tracking                                              |
| `evolve-runner`          | Sonnet | 50        | Runs the hermit-evolve upgrade in isolation                                       |
| `proposal-triage`        | Haiku  | —         | Pre-creation gate: deduplicates proposals, applies three-condition rule           |
| `reflection-judge`       | Sonnet | —         | Post-reflect validator: verifies cross-session evidence citations before queuing  |

Tools: Read, Write, Edit, Bash, Glob, Grep. No web access. Uses `memory: project` for accumulated knowledge across sessions.

Hermits extend this layer with specialized agents when they ship them; the active set varies per hermit and is documented in each plugin's `CLAUDE.md`.

---

## Layer 4: Skills and Hooks

### Skills

Skills are namespaced `/claude-code-hermit:*`; the full set is listed in the plugin's `CLAUDE.md` (Plugin Structure).

### Hooks

| Hook                | Trigger      | Profile   | What it does                                           |
| ------------------- | ------------ | --------- | ------------------------------------------------------ |
| Deny enforcer       | PreToolUse   | strict    | Blocks banned bash patterns before execution           |
| Channel hook        | PostToolUse  | strict    | Forwards tool events to configured channel             |
| Heartbeat touch     | PostToolUse  | strict    | Marks activity for heartbeat gap detection             |
| Contract tests      | PostToolUse  | strict    | Runs plugin contract tests after changes               |
| Config validator    | PostToolUse  | strict    | Validates config.json after mutations                  |
| Context loader      | SessionStart | all       | Loads OPERATOR.md, SHELL.md, latest report, cost data  |
| Cost tracker        | Stop         | all       | Logs tokens/cost                                       |
| Compact suggestion  | Stop         | standard+ | Suggests `/compact` by tool-call count                 |
| Session diff        | Stop         | standard+ | Auto-populates `## Changed` from `git diff`            |
| Session evaluator   | Stop         | standard+ | Validates SHELL.md quality, detects zombie/stale/bloat |
| PermissionDenied notify | PermissionDenied | all | Deduped channel alert when a tool call is denied      |
| Stop pipeline       | Stop         | all       | Cost tracking, compact suggestion, session diff, evaluation, heartbeat |

Hermits may add hooks at `strict` (e.g., git-push-guard). Profile-gated hooks check `AGENT_HOOK_PROFILE` internally and return early when the active profile doesn't match.

---

## Layer 5: Repo Artifacts

All state lives in git-tracked files. No database, no external service.

### Plugin file map

```
claude-code-hermit/
├── agents/session-mgr.md
├── hooks/hooks.json
├── scripts/               # Hook implementations + boot scripts
├── skills/                 # skill definitions
├── state-templates/        # Copied into projects by init
└── .claude-plugin/plugin.json
```

### Per-project state (after init)

```
your-project/
├── .claude-code-hermit/
│   ├── sessions/SHELL.md, S-NNN-REPORT.md
│   ├── proposals/PROP-NNN.md
│   ├── compiled/review-weekly-YYYY-Www.md  # Weekly review reports (weekly-review.ts; type: review)
│   ├── templates/
│   ├── state/                        # Runtime observations (agent-owned, not operator-configured)
│   │   ├── runtime.json              # Session state: in_progress/waiting/idle (authoritative since v0.3.2)
│   │   ├── alert-state.json          # Alert dedup state + self-eval evidence (heartbeat-owned)
│   │   ├── reflection-state.json     # Last reflection timestamp (reflect-owned)
│   │   ├── channel-activity.json     # Last channel interaction timestamp (channel-hook-owned)
│   │   ├── channel-replies.jsonl     # Append-only channel reply log (channel-hook-owned)
│   │   ├── channel-log.sqlite        # Episodic DM log + FTS5 index (PROP-010); created lazily, absent until first message
│   │   ├── session-diff.json         # Uncommitted file tracking (session-diff-owned)
│   │   ├── proposal-metrics.jsonl    # Append-only event log (proposal-create + proposal-act)
│   │   ├── micro-proposals.json      # Pending micro-approvals list (reflect + channel-bridged asks + channel-responder)
│   │   ├── state-summary.md          # Auto-generated health snapshot (generate-summary.ts)
│   │   ├── monitors.runtime.json     # Active watch registry, cleared on session start (watch-owned)
│   │   ├── operator-pause.json       # Operator/watchdog pause (pause-keyword.ts/watchdog-owned)
│   │   ├── auto-pause.json           # Budget-breach auto-pause (cost-tracker-owned)
│   │   ├── budget-alerts.json        # Budget alert dedup (cost-tracker-owned)
│   │   ├── telemetry-alert.json      # Telemetry export-failure alert dedup (telemetry-export-owned)
│   │   ├── channel-health.json       # Advisory channel send-liveness (channel-send-owned)
│   │   ├── .heartbeat                # Activity marker (heartbeat-touch-owned)
│   │   └── .lifecycle.lock           # Always-on lifecycle lock (hermit-start-owned)
│   ├── bin/hermit-start, hermit-stop
│   ├── config.json
│   ├── OPERATOR.md           # Human-curated context — never edit autonomously; always confirm changes
│   └── HEARTBEAT.md
└── CLAUDE.md (session discipline appended)
```

No `package.json`, no `node_modules`, no build step.

#### state/ ownership model

One writer per state file. No shared mutation bus. (Exception: `state/micro-proposals.json` has several writers — reflect and the channel-bridged asking skills queue entries, channel-responder/brief resolve them — but the hermit runs as a single sequential session, so these never overlap; the "one writer" rule is about avoiding concurrent mutation, which single-session execution already guarantees here.)

| File                           | Owner (sole writer)                                 | Readers                                                       |
| ------------------------------ | --------------------------------------------------- | ------------------------------------------------------------- |
| `state/runtime.json`           | session-mgr + cost-tracker                          | heartbeat, session-start, /hermit-routines (rdw=false suppression)   |
| `state/alert-state.json`       | heartbeat only                                      | heartbeat; evaluate-session (read-only nudge computation)     |
| `state/reflection-state.json`  | reflect + session (non-overlapping phases)          | heartbeat (debounce), hermit-settings (scheduled-checks display) |
| `state/channel-activity.json`  | channel-hook.ts only                                | channel-responder, heartbeat                                  |
| `state/channel-replies.jsonl`  | channel-hook.ts (append only)                       | reflect (routine-ROI engagement join)                         |
| `state/channel-log.sqlite`     | channel-reply-reminder.ts + channel-hook.ts (append, via `lib/channel-log.ts`); weekly-review marks/prunes | search.ts (recall, fourth source); weekly-review consolidation |
| `state/session-diff.json`      | session-diff.ts only                                | session-close (display)                                       |
| `state/observations.jsonl`     | reflect + reflect-precheck + session-close + channel-responder (append only; `source` values: `cost-spike`, `quick-deferral`, `reflect-noticed`, `startup-drift`, `skill-correction`) | reflect (step 3b graduation), reflection-judge (§1.4 ledger verification) |
| `state/proposal-metrics.jsonl` | proposal-create + proposal-act (append only)        | generate-summary.ts, proposal-metrics-report.ts (read-only)   |
| `state/micro-proposals.json`   | reflect + channel-bridged skills (queue, schema owned by reflect § Queuing procedure) + channel-responder/brief (resolve) | brief, generate-summary.ts |
| `state/state-summary.md`       | generate-summary.ts only                            | humans                                                        |
| `state/monitors.runtime.json`  | watch skill only                                    | session-start (clear on start), session-close (stop all)      |
| `state/heartbeat-monitor.runtime.json` | heartbeat skill only                        | heartbeat-start (write), heartbeat-stop (clear), heartbeat-restart (rewrite) |
| `state/heartbeat-liveness.json` | heartbeat-monitor.sh (every poll iteration)         | doctor-check.ts (heartbeat liveness check), heartbeat status  |
| `state/cc-stop-snapshot.json`  | stop-pipeline.ts only                               | doctor-check.ts (scheduler/background-task health check)      |
| `state/.heartbeat`             | heartbeat-touch.ts only                             | heartbeat (detect activity gaps)                              |
| `state/.lifecycle.lock`        | hermit-start.ts only                                | hermit-stop.ts (cleanup)                                      |
| `state/cost-index.json`        | cost-tracker.ts only                                | cost-tracker.ts (writeCostSummary, getCumulativeCost fallback), doctor-check.ts |
| `state/watchdog-state.json`    | hermit-watchdog.ts only                             | doctor-check.ts (`last_run` liveness + consecutive_stale)     |
| `state/watchdog-events.jsonl`  | hermit-watchdog.ts only (append)                    | doctor-check.ts (event counts), session-start (restart reason)|
| `state/template-manifest.json` | `manifest-seed.ts` (called by hatch seed, docker-setup baselines, hermit-evolve update-after-copy) | evolve-plan.ts (classify), doctor-check.ts (shape check) |

Per-file update policies for managed files under `.claude-code-hermit/`:

- **bot-owned-overwrite**: `state/` runtime files, `config.json` keys added by upgrade — written by the hermit, overwritten on upgrade with no review.
- **operator-owned-never**: `OPERATOR.md`, `HEARTBEAT.md`, `sessions/`, `proposals/` — hermit never overwrites.
- **managed-with-merge-gate** (`templates/`): on upgrade, classified against `template-manifest.json` baseline; conflicts parked as `.new` for operator review; `customized-kept` files left untouched.
- **boot-critical-replace** (`bin/`): conflicts replace with the upstream version (`chmod +x`); operator's copy preserved as `.bak`; stale wrappers can dead-end the hermit so keeping them is never safe.

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
|  Injected on startup.                        |
+----------------------------------------------+
|  sessions/SHELL.md                           |
|  Owner: Agent. Lifetime: one session.        |
|  Task, plan, progress, blockers, findings.   |
+----------------------------------------------+
|  sessions/S-NNN-REPORT.md                    |
|  Owner: Agent. Lifetime: permanent.          |
|  Archived journals. Cold-start safety net.   |
+----------------------------------------------+
|  state/channel-log.sqlite (PROP-010)         |
|  Owner: Agent (hooks). Lifetime: substrate.  |
|  Forward-only DM log — the conversational    |
|  layer above didn't capture. Consolidated    |
|  weekly into memory/compiled; raw rows       |
|  pruned only after consolidation.            |
+----------------------------------------------+
```

OPERATOR.md is human-curated — your hermit reads it but never modifies it. Auto-memory is Claude Code's built-in [persistent memory](https://code.claude.com/docs/en/sub-agents) and the primary input to learning. `compiled/` is for durable domain outputs the operator wants surfaced across sessions — distinct from auto-memory, which handles operational lessons. SHELL.md is the live working document. Reports are the journal and cold-start safety net — not the input to learning. `channel-log.sqlite` is the episodic substrate below all of the above: it captures the operator's actual DM text (deterministically, at hook level) so a concluded channel thread survives context compaction even before anything from it gets promoted. It's feature-detected everywhere it's read — a hermit with no channel traffic never creates the file, and recall/consolidation simply see nothing from this source.

The `proposal-triage` and `reflection-judge` gate agents each carry their own private `memory: project` store (at `.claude/agent-memory/<agent-name>/MEMORY.md`). These are **isolated from the operator's memory** — triage accumulates suppression-pattern heuristics, judge accumulates hollow-evidence shapes. Private memory sharpens judgment but is never the sole basis for a suppress verdict. Over-suppression is bounded by the reflect Component Health check (`state/reflection-state.json` and `state/proposal-metrics.jsonl` counters).

### Knowledge directories

```
.claude-code-hermit/
  raw/          # Domain inputs (fetched data, snapshots, logs) — ephemeral
    .archive/   # Expired raw artifacts, moved by archive-raw.ts
  compiled/     # Domain outputs (briefings, decisions, assessments) — durable
  knowledge-schema.md  # Per-hermit behavioral schema: what to produce and when
```

**Ownership boundary:** Claude Code memory owns instructions, preferences, and recurring operating context; hermit knowledge owns domain artifacts; skills own procedures.

A `procedure-brief` (`type: procedure-brief`) is the boundary case: it lives in `compiled/` as a *record* of what recurring procedure was observed and which sessions showed it. The installed skill under `.claude/skills/` is the live procedure. The brief is not injected at startup (it is a transient record, not a durable domain output); the installed skill is what the operator cares about day-to-day.

**Scope boundary:**

| Concern | Owner |
|---------|-------|
| Operational learning (lessons, patterns, preferences) | Auto-memory |
| Durable domain outputs the operator wants surfaced across sessions | `compiled/` |
| Domain operational inputs | `raw/` |
| Session state | `state/` |

`compiled/` artifacts use the [frontmatter conventions](frontmatter-contract.md) with a required `type` field. Startup injection reads `compiled/` frontmatter and injects the newest artifact of each type within the configured char budget (`knowledge.compiled_budget_chars`, default 2500, range 500–6000). Artifacts tagged `foundational` are always injected first. For deep retrieval of specific history, use `/recall`.

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

**Three-condition gate:** Every proposal candidate must satisfy the three conditions defined canonically in `skills/proposal-create/SKILL.md` §Three-Condition Rule: repeated pattern across sessions, meaningful consequence if left unaddressed, and an operator-actionable change. This prevents trivial or one-off observations from cluttering the proposal pipeline.

**Micro-proposals (tier 1/2):** For changes that are reversible or non-critical, reflect queues a micro-proposal — a yes/no, or 2-4-option, question sent via channel. Multiple pending micro-proposals can coexist (`state/micro-proposals.json → pending[]`); operator answers by ID. On channel-tagged turns, other skills' bounded asks (e.g. `proposal-act accept`'s 3-way ask, `hermit-settings quality-gate`) queue entries through the same bridge (channel-responder § Channel-safe ask bridge) so the question survives compaction or a session restart. Ignored micro-proposals expire after 2 morning briefs.

Hermit provides the **timing infrastructure** (when to reflect), the **proposal pipeline** (structured proposals with an operator gate), and the **tier classification** (which proposals need what level of approval). Claude handles the intelligence — noticing patterns, assessing confidence, formulating proposals.

### Daily Rhythm

Morning routine (configurable time, default: active hours start + 30m): brief, proposal review, priority check, pending micro-proposals surfaced.
Evening routine (configurable time, default: active hours end - 30m): daily journal archived as S-NNN, reflection, preparation for tomorrow.

Both are managed by `/claude-code-hermit:hermit-routines` (per-session CronCreate registrations). Fire at exact cron times. CronCreate is idle-gated: routines that come due during `in_progress` are deferred until the REPL is between turns — never dropped, never interrupting mid-task. A daily 4am `heartbeat-restart` routine re-runs `/claude-code-hermit:hermit-routines load` to re-arm the routine CronCreates (7-day expiry) and re-register the heartbeat Monitor.

### Scheduling ownership boundaries

Four mechanisms handle background work — each owns a distinct axis:

- **hermit-routines** — the only place for time-based semantic work (reflect, scheduled-checks, weekly-review, daily-auto-close). Implemented as idle-gated `CronCreate` registrations; each cron fire wakes the model for a scheduled task turn.
- **heartbeat** — health/checklist/idle-wake gate only. Polls via `--peek` in a bash subprocess (zero model cost when quiet); wakes the model only on `EVALUATE` or `AUTO_CLOSE` verdicts. Must not be merged into routines — doing so would lose the zero-token quiet path because `CronCreate` fires unconditionally on every tick with no precheck filter.
- **watch** — session-scoped external event streams via the `Monitor` tool. Dies with the session; not a scheduler.
- **watchdog** — out-of-session process recovery (restart, wedge-nudge, re-arm). `post_close_clear`, `context_clear_tokens`, and `context_hygiene.compact` run on every scheduler tick **independent of `watchdog.enabled`**; they are scheduler-owned context-hygiene co-located in the watchdog script, not watchdog features. Setting `enabled: false` disables restart/nudge only.

New periodic semantic work belongs in hermit-routines. Heartbeat, watchdog, and watch must not become general schedulers.

### Context Hygiene

Three context-reset mechanisms live in the watchdog script, each owning a distinct timing:

1. **`post_close_clear`** — fires right after `daily-auto-close` archives the session. `/clear` is free here because the archive that just ran externalized everything; there is nothing left to preserve.
2. **`watchdog.context_clear_tokens`** (700k default) — an emergency `/clear` for a context that grew far past routine hygiene. Destructive and conservative by design: it can fire mid-arc, with only `SHELL.md`'s task ledger (not the live reasoning thread) surviving.
3. **`context_hygiene.compact`** (150k default) — routine hygiene. Always-on hermits wake on events ≥2 min apart, past the 5-minute prompt-cache TTL, so every wake re-pays the full accumulated context from cold. A `/compact` at a low, frequent threshold keeps that cost bounded; `startup-context.ts`'s post-compaction pointer section (`source === "compact"`, see Layer 4/5 above) re-seeds `runtime.json` state, pending micro-approvals, and outbound channel routing on the next `SessionStart`, which is what makes a threshold this low safe — nothing operationally load-bearing survives only in the discarded conversation.

Mechanism 3 also has a secondary effect on mechanism-independent native/proactive auto-compaction (`CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`): by keeping context low at quiescent moments, it reduces how often native auto-compaction gets the chance to fire mid-task in the first place.

A boundary marker (`state/compact-requested.json`), written by the `session` and `proposal-act` skills at arc-end moments, lets mechanism 3 waive its `min_interval` cooldown for one tick — never its 60k token floor. See `config-reference.md` § `context_hygiene` for the full guard list and config keys.

---

## What You Give Up / What You Gain

**Give up:** No web dashboard, no metrics visualization, no multi-tenant isolation, no custom tool definitions (use Claude Code's native tools or [MCP servers](https://code.claude.com/docs/en/mcp)).

**Gain:** Understand it in 30 minutes. No version conflicts, no build failures. Works with any codebase in any language. Session reports are human-readable markdown — grep them, review in GitHub, feed to another agent.

---

## Configuration Reference

### Environment Variable Flow

```
config.json "env"  →  hermit-start.ts  →  .claude/settings.local.json "env"  →  Claude Code  →  hooks, Bash tool calls
                   →  shell env (tmux temp file / Docker environment:)  →  MCP servers
```

1. Operator configures env vars in `config.json` `env` (or via `/hermit-settings env`)
2. `hermit-start.ts` writes all `config["env"]` values into `.claude/settings.local.json` `env`
3. Claude Code reads `settings.local.json` and exports `env` values to hooks and Bash tool calls
4. For vars that MCP servers need (`*_STATE_DIR`), `hermit-start.ts` also forwards them as OS env vars (tmux temp file or Docker compose `environment:`) — MCP servers are separate processes that inherit shell env but do NOT read `settings.local.json`

**Bucket A (shell env only):** `CLAUDE_CONFIG_DIR`, `ANTHROPIC_API_KEY` — must be in shell env before `claude` starts. Forwarded via temp file in tmux, or Docker `environment:`. OAuth credentials live in `.credentials.json` (written by `claude /login`), not in env vars.

**Bucket B (settings.local.json only):** `AGENT_HOOK_PROFILE`, `COMPACT_THRESHOLD`, `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`, `MAX_THINKING_TOKENS` — consumed by hooks and Claude Code itself.

**Bucket C (derived at boot, written to both):** `DISCORD_STATE_DIR`, `TELEGRAM_STATE_DIR` — derived by `hermit-start` from `channels.<name>.state_dir` in config.json (relative paths resolved against project root). Written to `settings.local.json` for hooks and forwarded into the tmux shell env (or Docker compose `environment:`) for MCP servers (channel plugins), which inherit shell env but don't read `settings.local.json`.

### config.json env defaults

| Field                             | Value      | Purpose                                            |
| --------------------------------- | ---------- | -------------------------------------------------- |
| `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` | `65`       | Auto-compact at 65% context                        |
| `MAX_THINKING_TOKENS`             | `10000`    | Cap thinking budget                                |
| `AGENT_HOOK_PROFILE`              | `standard` | Active hook profile                                |
| `COMPACT_THRESHOLD`               | `75`       | Tool-call-count threshold for compact suggestion   |
| `DISCORD_STATE_DIR`               | (derived)  | Derived from `channels.discord.state_dir` at boot  |
| `TELEGRAM_STATE_DIR`              | (derived)  | Derived from `channels.telegram.state_dir` at boot |

### Denied operations

Deny patterns block dangerous operations regardless of permission mode. See [Security](security.md) for the full deny list and defense-in-depth model.

---

## Known Limitations

1. ~~**O(n) cost-log scan**~~ — Fixed: `cost-tracker.ts` now maintains `cost-index.json`, an incremental byte-offset index updated on every Stop hook. `writeCostSummary` and the `getCumulativeCost` fallback both render from the index; the O(n) scan only runs on first use or after log truncation.

2. **Boot script timing** — `hermit-start.ts` waits 3 seconds before sending commands to tmux. May not be enough on slow hardware. Fix: poll `tmux capture-pane` for readiness.

3. ~~**Silent cost-log corruption**~~ — Fixed: `cost-index.json` carries a `skipped_corrupt_lines` counter incremented on every `JSON.parse` failure; `doctor-check.ts` surfaces a `warn` when the counter is non-zero.
