---

<!-- claude-code-hermit: Session Discipline -->

## Session Discipline (claude-code-hermit)

- On startup, check `.claude-code-hermit/sessions/SHELL.md`
- If active (`in_progress`/`waiting`): resume — read task, check plan via `TaskList`, check blockers
- If `idle`: ask what to help with
- If none: ask what to help with
- Use `/claude-code-hermit:session-start` and `/claude-code-hermit:session-close`

## Agent State

| Path                       | Contents                                                        |
| -------------------------- | --------------------------------------------------------------- |
| `sessions/SHELL.md`        | Live working document                                           |
| `sessions/S-NNN-REPORT.md` | Archived reports                                                |
| `proposals/PROP-NNN-<slug>-HHMMSS.md` | Improvement proposals                                           |
| `state/`                   | Runtime state (alert dedup, reflection, routine queue, metrics) |
| `state/monitors.runtime.json` | Active watch registry — cleared on each session start       |
| `OPERATOR.md`              | Human-curated context — draft changes, confirm before writing |

## Subagents

- `session-mgr` (Sonnet) — session lifecycle (open, archive, idle transitions)
- `proposal-triage` (Haiku) — pre-creation gate: deduplicates proposals and applies the three-condition rule before queuing
- `reflection-judge` (Sonnet) — post-reflect validator: verifies cross-session evidence citations exist before proposals are queued
- `hermit-config-validator` (Haiku) — lightweight config.json validator: checks required keys, types, routine times, channel structure, env naming. Use after hermit-settings, hermit-evolve, or any config mutation.
- `quality-gate-judge` (Haiku) — decides whether `/claude-code-hermit:simplify` should run at step (e.5) of `/proposal-act` accept flow; reads proposal body + touched files, returns RUN/SKIP verdict. Only invoked when `quality_gate.tier: "balanced"`.
- `evolve-runner` (Sonnet) — runs the hermit-evolve upgrade (steps 0–9) in an isolated context so upgrades don't pollute the session; escalates undecidable migration choices back to the main loop.

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
- `HEARTBEAT_EVALUATE` notification → invoke `/claude-code-hermit:heartbeat run`.

## Quick Reference

`/session-start` `/session` `/session-close` `/pulse` `/brief` `/heartbeat` `/daily-auto-close` `/watch` `/reflect` `/reflect-scheduled-checks` `/hermit-routines` `/hermit-settings` `/proposal-list` `/proposal-act` `/proposal-create` `/capability-brainstorm` `/hermit-evolve` `/channel-setup` `/channel-responder` `/docker-setup` `/docker-security` `/hatch` `/smoke-test` `/hermit-brain` `/hermit-evolution` `/hermit-health` `/weekly-review` `/migrate` `/knowledge` `/hermit-doctor`
(All prefixed with `/claude-code-hermit:`)

## Operator Notification

When a sub-step is delegated under the Context-hygiene heuristic, the subagent returns the message and main runs this protocol to send it. Main owns the outbound send and any `AskUserQuestion`.

When you need to notify the operator proactively:

- **If no channel is enabled** (channels block absent, `channels === {}`, or every channel-config entry has `enabled === false` — exclude the `primary` string pointer when iterating):
  - If `push_notifications === true` in `config.json`, fire `PushNotification(message="<condensed one-line ≤200 chars, no markdown, actionable detail first>", status="proactive")`. Push is best-effort; do not retry on failure and do not log a `channel-send-unavailable` issue for this branch — the operator's empty-channels config is intentional.
  - Respond in conversation either way (the conversation response is the durable record).
- **If at least one channel is enabled**, resolve the outbound target by running:
  ```
  bun ${CLAUDE_PLUGIN_ROOT}/scripts/resolve-outbound-channel.ts .claude-code-hermit
  ```
  Parse stdout as JSON. A channel is eligible if `enabled !== false`, `allowed_users` is not `[]`, and `dm_channel_id` is set. Resolution order: `channels.primary` (if set and eligible), then the first eligible entry in `channels` (operator's config order — no hardcoded slug list, so newly added channel plugins are picked up automatically).
  - **On success** (`"id"` and `"chat_id"` in result): call `mcp__plugin_<id>_<id>__reply` with `{ chat_id, text: <message> }`. If the reply call itself fails (token expired, plugin crashed, network blip) and `push_notifications === true`, fire `PushNotification(message="<...>", status="proactive")` as a last-resort signal, then log + dedup as below.
  - **On miss** (non-zero exit or `{"error":"no_reachable_channel"}` — a channel is configured but unreachable: missing `dm_channel_id`, empty `allowed_users`, or `config_read_failed`): if `push_notifications === true`, fire `PushNotification(message="<...>", status="proactive")`. Then log the unsent content to SHELL.md Findings and record a deduped `channel-send-unavailable` issue regardless of push state — the configured channel is broken and the operator should see the signal. Do not use the user ID as a substitute (it will fail for Discord DMs).
- If outbound send fails after a successful resolve (covered above): log + dedup; do not retry.

## Knowledge Discipline

Auto-memory handles all learning. `compiled/` is for durable domain outputs and records the operator may want surfaced across sessions. Don't duplicate lessons into `compiled/`.

**Memory-first for suggestions.** Before any skill or subagent declares a finding novel — `brief`, `reflect`, `weekly-review`, `proposal-create`, `session-start`, and the `proposal-triage` / `reflection-judge` subagents — consult auto-memory first and suppress the suggestion if memory already covers the same operator decision, preference, or pattern. This applies only to suggestion-generating paths; skills acting on a decided intent (`session-close`, `proposal-act`, `hermit-routines`, `hatch`) are exempt — they execute, not suggest. When memory covers the candidate, suppress with the canonical code `covered-by-memory` and quote the matching memory line.

- Domain inputs go to `raw/<type>-<slug>-<date>.md` with frontmatter (`title`, `type`, `created`, `tags` required).
- Evolving subjects live in `compiled/topic-<slug>.md` (undated): update the page in place — merge findings, bump `updated:`, refresh the one-line `summary:` — instead of writing a new dated copy. Prefer a topic page over a dated note whenever the subject will come up again.
- One-off domain outputs go to `compiled/<type>-<slug>-<date>.md` with frontmatter. Max 150 lines, self-contained. Add `session: S-NNN` when inside a session. Cite source in frontmatter (`source: raw/<type>-<slug>-<date>.md`).
- **`type` in frontmatter is the discriminator — never a folder.** Do not create subdirectories inside `raw/` or `compiled/`, and do not create new top-level directories inside `.claude-code-hermit/` (e.g. `audits/`, `reports/`, `reviews/`, `memory/`, `tmp/`). Artifacts outside `raw/` and `compiled/` are invisible to session injection and retention.
- On session start: `foundational`-tagged artifacts inject full bodies; everything else appears as a one-line catalog entry (stem, type, date, tags + `summary`). Read the file or use `/recall` for depth.
- On recurring routines that produce domain output: write to `compiled/` instead of ad-hoc paths. Consult `knowledge-schema.md` for what this hermit produces and in what format.
- Raw inputs are retained per `config.json knowledge.raw_retention_days`. Expired raw artifacts are archived to `raw/.archive/` by the weekly review.
- Tag a compiled artifact `foundational` when it describes a stable pattern worth injecting at every session start.

## Rules

- **Rate limits:** Log pause/resume in Progress Log. Never silently stall.
- **Self-awareness:** If stuck — say so, log it, alert via channel. Don't push through silently.
- **Context hygiene & delegation:** For broad file scans, archive traversals, or research where only the conclusion is needed, delegate to the built-in `Explore` subagent. The same logic extends to *execution* steps. Delegate a sub-step to a subagent when **all three** hold: (a) its intermediate context is much larger than its conclusion (multi-file edits, search sweeps, test output qualify; a frontmatter flip does not); (b) it needs no operator contact mid-flight; (c) main needs only the verdict, not the artifact. **Comms contract:** a delegated sub-step returns its verdict plus an optional `operator_message`; **main owns `AskUserQuestion`, channel resolution, and `PushNotification`**. `AskUserQuestion` is unavailable to a subagent, and outbound routing/cost/dedup live in § Operator Notification. **Break-even:** subagents inherit `CLAUDE.md`/`CLAUDE.local.md`, so each dispatch re-pays that seed as a fixed token tax. It is a net win only on the long-lived always-on session for steps above that noise threshold; fanning out trivial steps *raises* total tokens. Inheritance is also a feature: a dispatched implementer gets git-safety, worktree discipline, and project conventions for free, which is why `general-purpose` is the right pick for write tasks.
- **Calibration:** Before publishing specifics you didn't verify in this conversation (version-pinned behavior, external system state, recalled API/function signatures, menu paths, prices/dates/counts), either verify against a source (`WebSearch`, project docs, read the code, ask the operator) or label as recalled-not-verified. Trigger is specificity of the claim, not topic; general domain knowledge (principles, patterns, semantics) is fine to answer directly. `OPERATOR.md` can tighten or relax.
- **Secrets:** Never log API keys, tokens, passwords, or credentials to SHELL.md, reports, or proposals. Session files may be committed to git.
- **OPERATOR.md:** Never edit autonomously. If you notice stale or contradictory context, draft the minimal change, show a diff, and apply only after the operator confirms. In always-on mode, flag it via channel instead — the operator edits directly.
- **Proposals mandatory:** Every improvement goes through `/proposal-create` → operator accepts → implement. Trivial fixes (typos, one-liners) exempt. **Never hand-write `proposals/PROP-*.md` files** — always invoke the skill so the NNN-assignment, slug, timestamp, and collision-guard logic runs. Manually-assigned ids reuse NNNs across parallel sessions and produce short-form ids that violate the canonical `PROP-NNN-<slug>-HHMMSS` schema.
- **Tasks:** Use `TaskCreate`/`TaskUpdate` for multi-step work. `tasks-snapshot.md` is auto-generated — don't edit.
- **Artifact frontmatter:** Any `.md` file you create outside `.claude-code-hermit/` must include YAML frontmatter with at least `title` (string) and `created` (ISO 8601 with timezone). If inside a hermit session, add `session: S-NNN`. Optionally add `proposal`, `source` (`session` | `interactive` | `routine` | `manual`), and `tags` (array of strings). Full conventions: `docs/frontmatter-contract.md`.
- **Tag discipline:** Add `tags` to every session report, proposal, and artifact you create. Before tagging, scan the last 5 session reports and proposals for the existing vocabulary and reuse — introduce new tags only when nothing fits. Keep tags lowercase and hyphenated (1–2 per document).
