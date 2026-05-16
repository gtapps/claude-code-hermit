---

<!-- claude-code-hermit: Session Discipline -->

## Focus Discipline (claude-code-hermit)

- On startup, read `.claude-code-hermit/sessions/SHELL.md` (live focus dashboard) and `.claude-code-hermit/state/runtime.json` (lifecycle state).
- Lifecycle is tracked in `runtime.session_state` ∈ {`idle`, `in_progress`, `waiting`}. SHELL.md has no `Status:` field: `## Focus` describes the current work, `## Recent Activity` is the rolling log.
- If `## Focus` has non-placeholder content: resume — check `## Progress Log`, check `## Findings` for blockers, call `TaskList` for in-flight work.
- Otherwise: ask what to work on.
- Use `/claude-code-hermit:steer` to set or pivot focus, `/claude-code-hermit:done` to clear it (`/done --shutdown` for graceful daemon stop).

## Agent State

| Path                       | Contents                                                        |
| -------------------------- | --------------------------------------------------------------- |
| `sessions/SHELL.md`        | Live focus dashboard (`## Focus` + `## Recent Activity`)        |
| `sessions/S-NNN-REPORT.md` | Pre-v1.1.0 archived reports (read-only historical artifacts)    |
| `proposals/PROP-NNN-<slug>-HHMMSS.md` | Improvement proposals                                |
| `state/runtime.json`       | Lifecycle truth (`session_state`, shutdown timestamps, idle_task) |
| `state/`                   | Runtime state (alert dedup, reflection, routine queue, metrics) |
| `state/monitors.runtime.json` | Active watch registry — cleared on `/steer` or boot          |
| `OPERATOR.md`              | Human-curated context — draft changes, confirm before writing |

## Subagents

- `focus-mgr` (Sonnet) — SHELL.md custody: compaction, Recent Activity writes, recovery prompt orchestration, v1.1.0 migration helper
- `proposal-triage` (Haiku) — pre-creation gate: deduplicates proposals and applies the three-condition rule before queuing
- `reflection-judge` (Sonnet) — post-reflect validator: verifies evidence citations (SHELL.md `## Recent Activity` or pre-v1.1.0 S-NNN-REPORT.md content) actually exist before proposals are queued
- `hermit-config-validator` (Haiku) — lightweight config.json validator: checks required keys, types, routine times, channel structure, env naming. Use after hermit-settings, hermit-evolve, or any config mutation.
- `quality-gate-judge` (Haiku) — decides whether `/simplify` should run at step (e.5) of `/proposal-act` accept flow; reads proposal body + touched files, returns RUN/SKIP verdict. Only invoked when `quality_gate.tier: "balanced"`.

## Watches

Config-defined watches auto-register on session start. Ad-hoc watches via `/watch <instruction>`.
Registry: `state/monitors.runtime.json` (sole truth — not SHELL.md). Use `/watch status` to check, `/watch stop` to halt.

Two classes:
- **Stream (truly event-driven):** Source pushes events — `tail -f <file> | grep --line-buffered "<pat>"`, WebSocket subscriptions, `fswatch <path>` (macOS) / `inotifywait -m <path>` (Linux, needs inotify-tools)
- **Poll (quieter polling, not event-driven):** `while true; do <check> && echo <event>; sleep <N>; done`

Rules:
- Always use `grep --line-buffered` in pipes — without it, buffering delays events by minutes
- Add `|| true` after API calls in poll loops — one failed request shouldn't kill the watch
- Be selective with stdout — noisy watches are auto-stopped by CC
- All 4 CC Monitor tool params are required: `description`, `command`, `timeout_ms`, `persistent`. Always pass `timeout_ms` even when `persistent: true` (required by schema; ignored when persistent).
- `$CLAUDE_PLUGIN_ROOT` is **NOT available** in the watch subprocess. `$PWD` is project root. Resolve plugin paths at registration time (skill execution context has the var).
- Watch dies with the session — for scheduled work, use `/claude-code-hermit:hermit-routines` (re-registered on every always-on launch by `hermit-start.py`)

## Quick Reference

`/steer` `/done` `/pulse` `/brief` `/heartbeat` `/watch` `/reflect` `/reflect-scheduled-checks` `/hermit-routines` `/hermit-settings` `/proposal-list` `/proposal-act` `/proposal-create` `/capability-brainstorm` `/hermit-evolve` `/channel-setup` `/channel-responder` `/docker-setup` `/docker-security` `/hatch` `/smoke-test` `/obsidian-setup` `/cortex-refresh` `/cortex-sync` `/weekly-review` `/migrate` `/knowledge` `/hermit-doctor`
(All prefixed with `/claude-code-hermit:`)

## Operator Notification

When you need to notify the operator proactively:

- If no channels are configured, respond in conversation.
- If a channel is configured and there is exactly one allowed user for that channel:
  - Read `config.json` → `channels.<channel>.dm_channel_id` (e.g. `channels.discord.dm_channel_id`).
  - **If found:** call the channel plugin's `reply` tool with `chat_id` set to that value and `text` set to the message content (i.e. `<plugin>:reply` with `{ chat_id, text }`).
  - **If not found:** the DM channel ID is unknown (no inbound message received yet). Log the unsent content to SHELL.md Findings and record a deduped `channel-send-unavailable` issue — do not use the user ID as a substitute (it will fail for Discord DMs).
- If outbound send fails, or if there is no unambiguous outbound target:
  - Log the unsent content to SHELL.md Findings
  - Record a deduped `channel-send-unavailable` issue if appropriate
  - Continue without retry spam

## Knowledge Discipline

Auto-memory handles all learning. `compiled/` is for durable domain outputs and records the operator may want surfaced across sessions and in Cortex. Don't duplicate lessons into `compiled/`.

**Memory-first for suggestions.** Before any skill or subagent declares a finding novel — `brief`, `reflect`, `weekly-review`, `proposal-create`, `steer`, and the `proposal-triage` / `reflection-judge` subagents — consult auto-memory first and suppress the suggestion if memory already covers the same operator decision, preference, or pattern. This applies only to suggestion-generating paths; skills acting on a decided intent (`done`, `proposal-act`, `hermit-routines`, `hatch`) are exempt — they execute, not suggest. When memory covers the candidate, suppress with the canonical code `covered-by-memory` and quote the matching memory line.

- Domain inputs go to `raw/<type>-<slug>-<date>.md` with frontmatter (`title`, `type`, `created`, `tags` required).
- Domain outputs go to `compiled/<type>-<slug>-<date>.md` with frontmatter. Max 150 lines, self-contained. Cite source in frontmatter (`source: raw/<type>-<slug>-<date>.md`).
- **`type` in frontmatter is the discriminator — never a folder.** Do not create subdirectories inside `raw/` or `compiled/`, and do not create new top-level directories inside `.claude-code-hermit/` (e.g. `audits/`, `reports/`, `reviews/`, `memory/`, `tmp/`). Artifacts outside `raw/` and `compiled/` are invisible to session injection and retention.
- On session start: scan `compiled/` for recent and foundational artifacts likely to be useful. If two compiled artifacts share a `type`, the newest wins.
- On recurring routines that produce domain output: write to `compiled/` instead of ad-hoc paths. Consult `knowledge-schema.md` for what this hermit produces and in what format.
- Raw inputs are retained per `config.json knowledge.raw_retention_days`. Expired raw artifacts are archived to `raw/.archive/` by the weekly review.
- Tag a compiled artifact `foundational` when it describes a stable pattern worth injecting at every session start.

## Rules

- **Rate limits:** Log pause/resume in Progress Log. Never silently stall.
- **Self-awareness:** If stuck — say so, log it, alert via channel. Don't push through silently.
- **Calibration:** Before publishing specifics you didn't verify in this conversation (version-pinned behavior, external system state, recalled API/function signatures, menu paths, prices/dates/counts), either verify against a source (`WebSearch`, project docs, read the code, ask the operator) or label as recalled-not-verified. Trigger is specificity of the claim, not topic; general domain knowledge (principles, patterns, semantics) is fine to answer directly. `OPERATOR.md` can tighten or relax.
- **Secrets:** Never log API keys, tokens, passwords, or credentials to SHELL.md, proposals, or compiled artifacts. These files may be committed to git.
- **OPERATOR.md:** Never edit autonomously. If you notice stale or contradictory context, draft the minimal change, show a diff, and apply only after the operator confirms. In always-on mode, flag it via channel instead — the operator edits directly.
- **Proposals mandatory:** Every improvement goes through `/proposal-create` → operator accepts → implement. Trivial fixes (typos, one-liners) exempt. **Never hand-write `proposals/PROP-*.md` files** — always invoke the skill so the NNN-assignment, slug, timestamp, and collision-guard logic runs. Manually-assigned ids reuse NNNs across parallel sessions and produce short-form ids that violate the canonical `PROP-NNN-<slug>-HHMMSS` schema.
- **Tasks:** Use `TaskCreate`/`TaskUpdate` for multi-step work.
- **Artifact frontmatter:** Any `.md` file you create outside `.claude-code-hermit/` must include YAML frontmatter with at least `title` (string) and `created` (ISO 8601 with timezone). Optionally add `proposal`, `source` (`interactive` | `routine` | `manual`), and `tags` (array of strings). Files without frontmatter appear as "Unlinked" in the Cortex. Full contract: `docs/frontmatter-contract.md`.
- **Tag discipline:** Add `tags` to every proposal and artifact you create. Before tagging, scan recent proposals and `compiled/` artifacts for the existing vocabulary and reuse — introduce new tags only when nothing fits. Keep tags lowercase and hyphenated (1–2 per document).
