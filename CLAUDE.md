# claude-code-hermit (monorepo)

This repo is a multi-plugin Claude Code marketplace. Four plugins ship from `plugins/<slug>/`:
`claude-code-hermit` (core), `claude-code-dev-hermit`, `claude-code-homeassistant-hermit`, `claude-code-fitness-hermit`.
Each plugin has its own `CLAUDE.md`, `CHANGELOG.md`, and `tests/` — read those for plugin-specific context.

The top-level `.claude-plugin/marketplace.json` is the only marketplace. The README at the repo root is the canonical hermit pitch.

Always launch Claude Code from this repo's root, not from inside a plugin dir. Auto-memory is keyed by CWD, and plugin dirs contain their own `.claude-plugin/` (launching there can load the plugin under test as the project plugin). Per-plugin `CLAUDE.md` files load on demand when you touch their files.

## Conventions

- **Per-plugin paths**: every plugin lives at `plugins/<slug>/`. Tests, scripts, skills, agents, hooks, state-templates, docs, CHANGELOG, CLAUDE.md all live inside that dir.
- **Tests run from inside the plugin dir**: each plugin has its own runner — `bash tests/run-all.sh` for core and HA, `node scripts/*.test.js` for dev-hermit. Helpers use CWD-relative paths and break if invoked from repo root.
- **Tag format**: `<slug>--v<X.Y.Z>` (double-dash, e.g. `claude-code-hermit--v1.0.20`).
- **Independent versioning**: each plugin's `plugin.json` bumps on its own cadence. Domain plugins declare core compat via `required_core_version: ">=X.Y.Z"` (semver range, not pin).
- **Dependency fields**: `required_core_version` and `requires` live in `.claude-plugin/hermit-meta.json` (hermit-internal, validator-invisible). `dependencies` is the native Claude Code resolver field in `plugin.json`. `required_core_version` is authoritative — read by `plugins/claude-code-hermit/scripts/doctor-check.js` from `hermit-meta.json`. `requires` mirrors it for documentation. Update all three when the core version requirement changes. All hermit-internal manifest extensions (`hermit.*`, etc.) belong in hermit-meta.json.
- **Marketplace.json bumps**: only the matching plugin's entry. The release skill takes a slug arg: `/release <plugin-slug>`.

## Commits

- **Use `/commit` for every commit in this repo.** It detects which plugin's scope the diff belongs to, routes the CHANGELOG entry to that plugin's `CHANGELOG.md`, path-scopes staging (never `git add -A`), and runs `/simplify` on every diff (including markdown-only). The skill enforces "one plugin per commit" — cross-plugin changes are split into separate `/commit` runs.
- Root-scope edits (CI, root README, `.claude/`, `.claude-plugin/marketplace.json`) skip the CHANGELOG step entirely — they don't ship to operators. `/commit` handles that automatically.
- Releases still go through `/release <slug>`, which promotes a plugin's `[Unreleased]` section to a real version. `/commit` accumulates those entries during day-to-day work.
- **Where these skills live**: `/commit`, `/release`, `/create-pr`, `/release-status`, `/fleet-release`, `/test-run` are repo-internal skills under `.claude/skills/` — they're not shipped to operators, only used during monorepo dev. Use `/release-status` for a read-only pipeline snapshot before any release session; use `/fleet-release` when multiple plugins change together on one branch (handles dep ordering and `required_core_version` sync automatically).

## Branching

- **Default for version work: use a plugin-scoped branch** named `<short-slug>/vX.Y.Z` (e.g. `dev-hermit/v0.3.0`, `hermit/v1.0.22`, `ha-hermit/v0.0.7`). Accumulate commits there until the version is complete, then PR + regular merge (no squash) to `main`, then `/release <slug>`. This groups related commits, gives CI and `/ultrareview` a natural review point, and avoids shipping to operators mid-iteration.
- **Direct to `main`** for atomic, self-contained changes where a PR adds no value: hotfixes, single-line doc edits, dep bumps, and changes where the diff is its own review. Use judgment — if you'd want to see it in a PR before it reaches operators, branch.
- **Branch naming**: `<short-slug>/vX.Y.Z` where short-slug drops the `claude-code-` prefix (`dev-hermit`, `hermit`, `ha-hermit`). The `v` prefix is required — matches tag convention and disambiguates from feature names.
- **Never squash-merge** a plugin branch. Squash changes the SHA and strands the tag on an orphan commit. Regular merge commit, then `/release` tags HEAD of `main`.
- **Tags ship immediately to operators** — no staging. The branch is your safety gate.

## Layout gotchas

- **Sibling-scan pattern**: `${CLAUDE_PLUGIN_ROOT}/../*/.claude-plugin/plugin.json` resolves to `plugins/*/...` and finds all fleet plugins as guaranteed siblings.
- **Old standalone repos are redirect-only zombies**: `gtapps/claude-code-dev-hermit` and `gtapps/claude-code-homeassistant-hermit` exist but their `marketplace.json` redirects to this monorepo via `git-subdir`. **Do not push code there.** All work happens here.

## Environment quirks

- **`rm -rf` is blocked** by the `enforce-deny-patterns` hook. Use `rm -r` (no `-f`) for scratch cleanup.
- **Subtree imports are unsquashed**: `git log --first-parent` for the monorepo-only view; full upstream commits live under each subtree merge.
- **CI is not path-filtered yet**: every plugin's tests run on every PR. Don't assume a HA-test failure on a core-only PR is your fault.

## Rules

- Always use Context7 when I need library/API documentation, code generation, setup or configuration steps without me having to explicitly ask.
- Don't overengineer.---

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
| `proposals/PROP-NNN.md`    | Improvement proposals                                           |
| `state/`                   | Runtime state (alert dedup, reflection, routine queue, metrics) |
| `state/monitors.runtime.json` | Active watch registry — cleared on each session start       |
| `OPERATOR.md`              | Human-curated context — draft changes, confirm before writing |

## Subagents

- `session-mgr` (Sonnet) — session lifecycle (open, archive, idle transitions)
- `proposal-triage` (Haiku) — pre-creation gate: deduplicates proposals and applies the three-condition rule before queuing
- `reflection-judge` (Sonnet) — post-reflect validator: verifies cross-session evidence citations exist before proposals are queued
- `hermit-config-validator` (Haiku) — lightweight config.json validator: checks required keys, types, routine times, channel structure, env naming. Use after hermit-settings, hermit-evolve, or any config mutation.

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

`/session-start` `/session` `/session-close` `/pulse` `/brief` `/heartbeat` `/watch` `/reflect` `/reflect-scheduled-checks` `/hermit-routines` `/hermit-settings` `/proposal-list` `/proposal-act` `/proposal-create` `/hermit-evolve` `/channel-setup` `/channel-responder` `/docker-setup` `/hermit-takeover` `/hermit-hand-back` `/hatch` `/smoke-test` `/obsidian-setup` `/cortex-refresh` `/cortex-sync` `/weekly-review` `/migrate` `/knowledge` `/hermit-doctor`
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

- Domain inputs go to `raw/<type>-<slug>-<date>.md` with frontmatter (`title`, `type`, `created`, `tags` required).
- Domain outputs go to `compiled/<type>-<slug>-<date>.md` with frontmatter. Max 150 lines, self-contained. Add `session: S-NNN` when inside a session. Cite source in frontmatter (`source: raw/<type>-<slug>-<date>.md`).
- **`type` in frontmatter is the discriminator — never a folder.** Do not create subdirectories inside `raw/` or `compiled/`, and do not create new top-level directories inside `.claude-code-hermit/` (e.g. `audits/`, `reports/`, `reviews/`, `memory/`, `tmp/`). Artifacts outside `raw/` and `compiled/` are invisible to session injection and retention.
- On session start: scan `compiled/` for recent and foundational artifacts likely to be useful. If two compiled artifacts share a `type`, the newest wins.
- On recurring routines that produce domain output: write to `compiled/` instead of ad-hoc paths. Consult `knowledge-schema.md` for what this hermit produces and in what format.
- Raw inputs are retained per `config.json knowledge.raw_retention_days`. Expired raw artifacts are archived to `raw/.archive/` by the weekly review.
- Tag a compiled artifact `foundational` when it describes a stable pattern worth injecting at every session start.

## Rules

- **Rate limits:** Log pause/resume in Progress Log. Never silently stall.
- **Self-awareness:** If stuck — say so, log it, alert via channel. Don't push through silently.
- **Secrets:** Never log API keys, tokens, passwords, or credentials to SHELL.md, reports, or proposals. Session files may be committed to git.
- **OPERATOR.md:** Never edit autonomously. If you notice stale or contradictory context, draft the minimal change, show a diff, and apply only after the operator confirms. In always-on mode, flag it via channel instead — the operator edits directly.
- **Proposals mandatory:** Every improvement goes through `/proposal-create` → operator accepts → implement. Trivial fixes (typos, one-liners) exempt.
- **Tasks:** Use `TaskCreate`/`TaskUpdate` for multi-step work. `tasks-snapshot.md` is auto-generated — don't edit.
- **Artifact frontmatter:** Any `.md` file you create outside `.claude-code-hermit/` must include YAML frontmatter with at least `title` (string) and `created` (ISO 8601 with timezone). If inside a hermit session, add `session: S-NNN`. Optionally add `proposal`, `source` (`session` | `interactive` | `routine` | `manual`), and `tags` (array of strings). Files without frontmatter appear as "Unlinked" in the Cortex. Full contract: `docs/frontmatter-contract.md`.
- **Tag discipline:** Add `tags` to every session report, proposal, and artifact you create. Before tagging, scan the last 5 session reports and proposals for the existing vocabulary and reuse — introduce new tags only when nothing fits. Keep tags lowercase and hyphenated (1–2 per document).