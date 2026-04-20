# Changelog

## [Unreleased]

### Added

- **reflect: operator-value self-check** — a new bullet in the always-run reflection questions asks whether recent outputs are actually being used, cross-referencing `responded` event counts (accept/defer/dismiss) from `proposal-metrics.jsonl` and deferred-proposal build-up. Closes the gap where operators had to manually ask "how can you be more useful?"
- **reflect: cost-spike detection** — step 2 now computes today's cost vs the 7-day median; a spike (today > 2× median) is recorded to project memory as a sub-threshold observation that can graduate via recurrence.
- **reflect: `proposal-metrics.jsonl` tailed at step 3** — dismissal ratios feed the new operator-value self-check. No new infrastructure; the log was already being written.
- **reflect: Component Health agent check** — `reflection-judge` verdict counters in `reflection-state.json` are now read to detect an over-strict gate (rough flag: `judge_suppress > 2× judge_accept` with ≥5 total verdicts since `since`).
- **reflect: mandatory Progress Log entry** — every reflect run (including empty runs) appends a one-line summary to `SHELL.md` `## Progress Log` with candidate count, verdict breakdown, and outcomes. Makes reflect's work visible for audit/weekly-review without interrupting the operator. Silent-by-default applies only to operator pings, not the audit trail.

### Changed

- **reflect: silent by default** — the unconditional top-of-skill operator notification was removed. Reflect now only notifies on outcomes (proposal candidate, micro-approval, resolved proposal, graduated sub-threshold observation, or cost spike).
- **reflect: Three-Condition Rule moved before first use** — previously defined after three references; now defined directly after the reflection questions. All three prior references are pointers to the single definition.
- **reflect: sub-threshold observations routed to project memory** — line 156's "do not generate observations for their own sake" was reframed: sub-threshold observations (interesting but failing the rule) are now explicitly recorded to project memory with a pattern label and session_id so they can graduate on recurrence. Suppression-by-default remains; the change is that the carry-forward path is now explicit.
- **reflect: Resolution Check 14-day guard** — resolving an accepted proposal now requires both absence from 3 checked sessions **and** ≥14 days elapsed since `accepted_date`. Prevents wrongly resolving monthly-cadence patterns on daily reflects.
- **reflect: Skill Health → Component Health** — broadened to cover agents (with a concrete reflection-judge counter check) and hooks (documented as out-of-scope pending hook telemetry). Skills retain the existing weak/moderate/strong signal ladder.
- **reflection-judge: current-session evidence path tightened** — the fallback from `S-NNN-REPORT.md` to `SHELL.md` now has an explicit trigger (no archived report + ID matches the current SHELL.md Session Info), and emits `ACCEPT (current-session)` / `DOWNGRADE:N (current-session)` / `SUPPRESS (current-session)` so the caller can tell the evidence hasn't been archived yet. Unblocks proposals whose only evidence is the live session.

### Files affected

| File | Change |
|------|--------|
| `skills/reflect/SKILL.md` | Top-of-skill notification removed; cost-spike detection + proposal-metrics tail added; operator-value bullet added; Three-Condition Rule moved earlier; sub-threshold observation handling reframed; Resolution Check 14-day guard; Skill Health → Component Health |
| `agents/reflection-judge.md` | Current-session fallback path tightened with explicit trigger and distinct verdict labels |

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. No state migration required — all changes are plugin-side (skill + agent definition edits). Existing `reflection-state.json` counters are reused; no new state files are introduced.

---

## [1.0.12] - 2026-04-20

### Changed

- **`routines` skill renamed to `hermit-routines`** — avoids collision with Claude Code's native schedule/routines concepts. The slash command is now `/claude-code-hermit:hermit-routines` (and bare `/hermit-routines`). The `config.json` `routines` array key, `hermit-settings routines` subcommand, `routine-metrics.jsonl`, and `[hermit-routine:<id>]` CronCreate tags are unchanged.
- **Stale routine-watcher prose removed** — several docs and skills still referenced the old bash watcher (removed in 0.0.9). Cleaned up `docs/always-on-ops.md`, `docs/architecture.md`, `docs/testing.md`, `skills/proposal-act/SKILL.md`, `hooks/hooks.json`.
- **Cortex Portal.md is now a live Dataview template** — replaced the generated `obsidian/Cortex Portal.md` (rewritten by `build-cortex.js` on every refresh) with a static Dataview/dataviewjs template. Recent sessions, active proposals, reflect health, and recent artifacts now update live in Obsidian without any rebuild trigger.
- **Connections.md refreshes automatically** — a new mtime-gated stage in the Stop hook (`scripts/cortex-refresh-stage.js`) rebuilds `Connections.md` at the end of any turn that modified sessions, proposals, or artifact manifest. Cost on no-change turns is a handful of `stat()` calls. The nightly `cortex-refresh` routine remains as a safety net.

### Files affected

| File | Change |
|------|--------|
| `skills/hermit-routines/SKILL.md` | Renamed from `skills/routines/SKILL.md`; updated all internal invocation references |
| `state-templates/obsidian/Cortex Portal.md.template` | Rewritten as Dataview/dataviewjs template |
| `scripts/build-cortex.js` | Removed Portal generation; now writes `Connections.md` only |
| `scripts/cortex-refresh-stage.js` | New: mtime-gated Stop hook stage |
| `scripts/stop-pipeline.js` | Added cortex-refresh as stage 5 (standard+ only) |
| `skills/cortex-refresh/SKILL.md` | Updated description to reflect Portal is now live Dataview |
| `skills/cortex-sync/SKILL.md` | Updated step 4 to note Portal is live Dataview |
| `skills/obsidian-setup/SKILL.md` | Updated step 5 to clarify script scope |
| `state-templates/obsidian/Brain.md.template` | Added **Recent Inputs** Dataview section — live view of `raw/` sorted by recency, excluding `.archive/` |
| `state-templates/cortex-manifest.json.template` | Seeded `artifact_paths` with `"compiled"` so new hermits index durable outputs out of the box |

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Update `/routines` invocations** — replace any manual invocations of `/claude-code-hermit:routines` with `/claude-code-hermit:hermit-routines`. If you have custom scripts or notes that reference `/routines load` or `/routines status`, update those references. No config or state changes required — the `routines` array in `config.json` is unchanged.

2. **Replace `obsidian/Cortex Portal.md`** with the new Dataview template — copy `${PLUGIN_ROOT}/state-templates/obsidian/Cortex Portal.md.template` to `obsidian/Cortex Portal.md` (overwrite). The file was previously machine-generated; it is now a static template that Obsidian's Dataview plugin renders live.

3. **Seed `cortex-manifest.json` with `compiled/`** — read `.claude-code-hermit/cortex-manifest.json`. If `artifact_paths` does not already contain `"compiled"`, append it. Write the file back. Skip if the file does not exist.

4. **Replace `obsidian/Brain.md`** with the new template — copy `${PLUGIN_ROOT}/state-templates/obsidian/Brain.md.template` to `obsidian/Brain.md` (overwrite). Adds the **Recent Inputs** Dataview section so operators can see what the hermit has been reading without `raw/` polluting the relationship map.

No `config.json` changes required.

---

## [1.0.11] - 2026-04-19

### Fixed

- **Always-on bootstrap prompt never submitted** — after v1.0.10 collapsed the startup skills into a single composite prompt, `tmux send-keys -t <session> <bootstrap> Enter` in one call still delivered the text and Enter back-to-back. Claude Code's TUI treated the burst as bracketed paste, so the trailing Enter became a literal newline inside the composer rather than a submit — the bootstrap prompt sat visible in the input box but was never processed. Split into two `send-keys` calls with a 0.5s gap so the paste window closes before Enter is registered.

### Files affected

| File | Change |
|------|--------|
| `scripts/hermit-start.py` | Bootstrap send split into two `tmux send-keys` calls (text, 0.5s sleep, Enter) so Claude Code's paste detection doesn't swallow the submit keystroke |

### Upgrade Instructions

`hermit-evolve` executes these steps in order:

1. **No `bin/hermit-start` regeneration needed** — `bin/hermit-start` is a thin wrapper that invokes the plugin's `scripts/hermit-start.py`. The fix lands automatically when the plugin updates; run `.claude-code-hermit/bin/hermit-stop && .claude-code-hermit/bin/hermit-start` to pick it up. Verify by attaching (`tmux attach -t <session>`) and confirming the composite bootstrap prompt is auto-submitted rather than sitting unprocessed in the composer.

No `config.json` changes required.

---

## [1.0.10] - 2026-04-19

### Fixed

- **Always-on bootstrap silently dropped `/heartbeat start` and `/routines load`** — `hermit-start.py` was sending three slash commands via separate back-to-back `tmux send-keys` calls (`/session`, then `/heartbeat start`, then `/routines load`) with zero delay between them. `/session` runs the `session-start` skill, which is heavyweight (can take 30+ seconds and pauses for "What should I help with?"). The follow-up keystrokes landed inside the still-running `/session` turn and were silently swallowed — the same root cause as the original `routine-watcher.sh` bug. Heartbeat and routines never registered, so always-on hermits had no scheduled work and no health checks. Replaced with a single composite bootstrap prompt that asks Claude to invoke heartbeat-start, routines-load, then session in order — one tmux send, one Claude turn, no race possible.

- **`/routines` missing from `CLAUDE-APPEND.md` Quick Reference** — the routines skill landed in v1.0.9 but was not listed in the quick-reference line, so operators reading the appendix could not discover it.

### Files affected

| File | Change |
|------|--------|
| `scripts/hermit-start.py` | Bootstrap rewritten — three racing `tmux send-keys` replaced with one composite prompt that orders heartbeat-start → routines-load → session in a single Claude turn; respects existing `auto_session` / `heartbeat.enabled` / `routines` config gates |
| `state-templates/CLAUDE-APPEND.md` | `/routines` added to Quick Reference line |

### Upgrade Instructions

`hermit-evolve` executes these steps in order:

1. **Refresh `CLAUDE-APPEND.md`** — re-append the updated appendix to the project's `.claude/CLAUDE.md` so operators see `/routines` in the Quick Reference. The skill itself has been usable since v1.0.9; this only fixes discoverability.
2. **No `bin/hermit-start` regeneration needed** — `bin/hermit-start` is a thin wrapper that invokes the plugin's `scripts/hermit-start.py`. The fix lands automatically when the plugin updates; just run `.claude-code-hermit/bin/hermit-stop && .claude-code-hermit/bin/hermit-start` to pick up the new bootstrap behavior. Verify by checking the operator-visible log shows `Bootstrap: ... queued` lines AND that `/claude-code-hermit:routines status` reports active CronCreate registrations after launch.

No `config.json` changes required.

---

## [1.0.9] - 2026-04-19

### Fixed

- **Routine delivery silently dropped in `--remote-control` + channels mode** — `routine-watcher.sh` used `tmux send-keys` to invoke skills, which is event-displaced when Claude is in remote-control mode (the keystrokes land in the input buffer but are silently dropped between turns). The bash watcher and queue file are removed entirely. Each enabled routine is now a per-session `CronCreate` registered by the new `/claude-code-hermit:routines` skill (mirrors `/watch`). CronCreate is idle-gated: routines defer until the REPL is between turns and never interrupt mid-task. `hermit-start.py` invokes `/routines load` automatically on always-on launches. `routine-metrics.jsonl` adds a `delivery: "cron-create"` field on `fired` events.

### Added

- **`/claude-code-hermit:routines` skill** — manages per-session CronCreate registrations. Subcommands: `load` (register all enabled config.routines), `list` (show configured routines), `status` (show active CronCreate entries via CronList), `stop [id]` / `stop --all` (CronDelete). Changes take effect immediately — `hermit-settings routines` auto-runs `/routines load` after writing config.

- **`scripts/log-routine-event.sh`** — helper invoked by routine cron prompts to append timestamped fire events to `state/routine-metrics.jsonl` without asking the LLM to construct JSON.

### Removed

- `scripts/routine-watcher.sh`, `scripts/cron-match.py`, `scripts/routine-queue-flush.js`, `state-templates/routine-queue.json.template`, the `routines` tmux window in `hermit-start.py`, `routine-queue-flush` Stage 5 in `stop-pipeline.js`, the `routine-stale:<id>` heartbeat alert, and corresponding tests.

### Files affected

| File | Change |
|------|--------|
| `skills/routines/SKILL.md` | New skill — load/list/status/stop subcommands |
| `scripts/log-routine-event.sh` | New helper — append `fired` events to `routine-metrics.jsonl` |
| `scripts/hermit-start.py` | Removed routine-watcher tmux window; auto-sends `/routines load` after `/heartbeat start` when `config.routines` is set |
| `scripts/stop-pipeline.js` | Removed Stage 5 `routine-queue-flush` call |
| `skills/heartbeat/SKILL.md` | Removed stale-queue check and `routine-stale:<id>` alert; footer updated |
| `skills/hermit-settings/SKILL.md` | Routines section auto-invokes `/routines load` after config write — changes apply live, no restart needed |
| `skills/hatch/SKILL.md` | No longer copies `routine-queue.json.template`; metrics log description updated |
| `skills/smoke-test/SKILL.md` | Removed `routine-queue.json` shape repair |
| `skills/session-start/SKILL.md` | Removed `routine-watcher` from advisory-lock holders list |
| `agents/session-mgr.md` | Removed routine-watcher from `session_state` writers note |
| `tests/run-hooks.sh`, `tests/run-contracts.py` | Removed routine-queue-flush and cron-match tests |
| Docs | `always-on-ops.md`, `troubleshooting.md`, `architecture.md`, `skills.md`, `how-to-use.md`, `state-templates/CLAUDE-APPEND.md` updated |

### Upgrade Instructions

`hermit-evolve` executes these steps in order:

1. **Delete the obsolete queue file.** `rm -f .claude-code-hermit/state/routine-queue.json` — the bash watcher no longer exists, the file is orphaned.
2. **Register routines via CronCreate.** Invoke `/claude-code-hermit:routines load`. This replaces the old bash-watcher behavior live with no session restart. Confirm the result line shows `Routines registered: <ids> (<N> ok, 0 failed)`.
3. **Verify.** Invoke `/claude-code-hermit:routines status` and confirm one `[hermit-routine:<id>]` entry per enabled routine in `config.json`.
4. **Tell the operator about residual tmux noise.** If the hermit is running in always-on / tmux mode, the old `routines` tmux window keeps a defunct `routine-watcher.sh` process alive (POSIX keeps the process running even though the script file was deleted). It will print `python3: can't open file '.../cron-match.py'` errors on its loop until next `.claude-code-hermit/bin/hermit-stop`. **Harmless — ignore.** Operators who want a clean tmux state can do a one-time `.claude-code-hermit/bin/hermit-stop && .claude-code-hermit/bin/hermit-start` at their convenience.

No `config.json` changes required. Interactive `/session` users who want routines active in interactive mode must run `/claude-code-hermit:routines load` themselves — `hermit-start.py` only auto-loads in always-on mode.

---

## [1.0.8] - 2026-04-18

### Fixed

- **`claude-code-hermit` plugin installed but not enabled in container** — the entrypoint installed the hermit plugin on first boot but never called `claude plugin enable`, leaving hermit skills/hooks present on disk but dormant at runtime. An unconditional idempotent `claude plugin enable` now runs on every boot so containers self-heal on restart after the entrypoint is updated.

- **Channel pairing commands sometimes swallowed by a stale REPL** — `docker-setup` now sends `/reload-plugins` via `tmux send-keys` once before the first pair command, ensuring channel plugins registered by the entrypoint are live in the running claude session.

- **`stop_grace_period` too short for graceful session-close** — compose template default was Docker's 10s, but the entrypoint's SIGTERM trap polls for session-close up to 30 iterations. `docker compose restart` (and any external stop without pre-close) could SIGKILL mid-graceful-close. Raised to 60s.

- **LLM running docker-setup could act on `hermit-docker up` echo hints** — `hermit-docker up`'s trailing "To attach… run hermit-docker attach" output looks like imperative instructions. The outer LLM could follow them mid-setup, blocking on an interactive tmux attach. `docker-setup` now uses `docker compose ... up -d` directly during setup; `hermit-docker up` is reserved for operator-facing contexts.

- **Domain hermit (and third-party) plugins not installed in container** — `docker-setup` step 7b now mirrors plugins installed on the host (project or local scope only — user-scope plugins are intentionally excluded as host-personal) instead of presenting a canned list of official-only plugins. The entrypoint's recommended-plugin loop now adds each plugin's marketplace before installing, rather than skipping any non-`claude-plugins-official` entry. Domain hermits (e.g. `claude-code-homeassistant-hermit`) are picked up automatically because they are already installed on the host when the setup flow runs. Marketplace `org/repo` is resolved from `claude plugin marketplace list` (bare slug previously caused `marketplace add` to fail on first boot).

  Security gates added alongside this change: a **safelist** preselects only `claude-plugins-official` and `gtapps/*` plugins during the operator confirmation — third-party plugins require explicit per-entry opt-in. An **`org/repo` regex validator** rejects malformed marketplace values before they reach `config.json`.

- **Entrypoint recommended-plugin re-install loop** — the `if install_target in installed` guard compared against raw `claude plugin list` line output using set membership, so it never matched. Every plugin was being re-installed on every container boot, producing misleading "failed to install" warnings. Switched to substring match against the whole blob.

- **Docker OAuth double-login bug** — `hermit-docker login` previously ran `claude /login` (full REPL). On a container with no credentials, the REPL's startup auth check opened one OAuth URL and the `/login` slash command opened a second, causing a race on `.credentials.json`. Fixed by switching to `claude auth login` (one-shot, no REPL) guarded by a `claude auth status --json` pre-check: if already authenticated, the command reports the email and exits cleanly instead of forcing a re-login.

  The entrypoint banner also now explicitly warns operators not to run `claude` manually inside the container while waiting for credentials.

### Added

- **End-of-setup clean restart (step 8b)** — `docker-setup` now finishes with `hermit-docker down` + `docker compose up -d` so the first "real" hermit session starts with plugins fully loaded, fresh tmux state, and no setup chatter in the session transcript. Skipped if the operator chose "No — manual" at step 8.

- **Routine fire metrics** — `routine-watcher.sh` now appends `queued`, `fired`, and `dequeued` events to `state/routine-metrics.jsonl`. The `reflect` skill reads this log to detect routines that fire repeatedly with no downstream effect and proposes disabling or re-timing them. `hatch` initializes the file.

### Files affected

| File | Change |
|------|--------|
| `state-templates/bin/hermit-docker` | `login` subcommand replaced `claude /login` with auth-status-gated `claude auth login` |
| `state-templates/docker/docker-entrypoint.hermit.sh.template` | Banner warns against manual `claude` invocation; timeout error message updated; third-party marketplace auto-add on boot; unconditional idempotent `claude plugin enable claude-code-hermit` on every boot |
| `skills/docker-setup/SKILL.md` | Step 7b now mirrors host-installed plugins; login guidance updated; `/reload-plugins` sent once before channel pairing; mid-setup uses raw `docker compose up -d` to avoid LLM-misleading echo hints; new step 8b clean-restart at end |
| `state-templates/docker/docker-compose.hermit.yml.template` | `stop_grace_period: 60s` added so SIGTERM graceful session-close has time to complete |
| `skills/hermit-settings/SKILL.md` | Removed third-party plugin warning; unified restart instruction |
| `skills/reflect/SKILL.md` | Routine health check reads `routine-metrics.jsonl`; idle routine proposal path added |
| `skills/hatch/SKILL.md` | Initializes `state/routine-metrics.jsonl` |
| `scripts/routine-watcher.sh` | Emits `queued`/`fired`/`dequeued` events to `routine-metrics.jsonl` |
| `docs/config-reference.md` | Updated `enabled` field description; security model note rewritten |
| `docs/recommended-plugins.md` | Third-party section rewritten to reflect auto-install |

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Create `state/routine-metrics.jsonl`** — If `.claude-code-hermit/state/routine-metrics.jsonl` does not exist, create it as an empty file. No content required — `routine-watcher.sh` appends to it on the next routine fire.

2. **Add domain hermit or third-party plugins to container** — Re-run `/claude-code-hermit:docker-setup` (or `/hermit-settings docker`) to mirror host-installed plugins into `config.json docker.recommended_plugins`, then rebuild the container. Only `project` and `local`-scope plugins are mirrored; user-scope plugins are ignored (install them at `project` scope on the host first if you want them in the container). If a domain hermit is already installed on the host but missing from `docker.recommended_plugins`, add it manually: `add <plugin> <org/repo-marketplace>`.

3. **Update `bin/hermit-docker` login subcommand** — Replace the `login)` case body in `.claude-code-hermit/bin/hermit-docker` with the new auth-status-gated form. Find the block starting with `login)` and ending with `;;`, and replace the body so `hermit-docker login` runs `claude auth status --json` first, then `claude auth login` only if not already authenticated.

4. **Regenerate Docker scaffolding** — the entrypoint self-heal fix is COPY'd into the image at build time, and the `stop_grace_period: 60s` fix is in `docker-compose.hermit.yml`. Both apply only after regeneration. Re-run `/claude-code-hermit:docker-setup` (which regenerates `docker-entrypoint.hermit.sh` and `docker-compose.hermit.yml` and triggers rebuild on next up), OR for the hermit-enable fix alone, remediate now without rebuild: `docker compose -f docker-compose.hermit.yml exec hermit claude plugin enable claude-code-hermit@claude-code-hermit --scope project`.

No `config.json` changes required.

---

## [1.0.7] - 2026-04-17

### Added

- **Baseline audit offer (first session)** — on the first session of a new hermit in an existing codebase, operator is offered a one-time audit using the plugins accepted at hatch (`claude-md-improver`, `claude-automation-recommender`). One proposal per plugin invocation. One-shot, marker-gated (`.baseline-pending`).

- **Reflect diagnostic counters** — `state/reflection-state.json` now tracks per-hermit reflect metrics under a `counters` key. No behavioral change to reflect itself.

  Tracked: `total_runs`, `empty_runs`, `runs_with_candidates`, `judge_accept`, `judge_downgrade`, `judge_suppress`, `proposals_created`, `micro_proposals_queued`, `last_run_at`, `last_output_at`, `since`.

  `pulse --full` surfaces a Reflect Health summary. `cortex-refresh` injects it into Cortex Portal.md.

### Changed

- **`GITIGNORE-APPEND.txt` (local scope): ignore `tasks-snapshot.md`** — `tasks-snapshot.md` is regenerated every turn by the `cost-tracker` hook from the native Tasks store, same category as `cost-summary.md` (already ignored). Adding it eliminates per-turn churn in `git status` for local-scope hermits. Project-scope gitignore unchanged — its "everything else is versioned" contract still applies.

- **`CLAUDE-APPEND.md`: `hermit-config-validator` added to Subagents section** — the agent was present in `agents/` and listed in `CLAUDE.md` but missing from the template injected into target projects. Deployed hermits had no LLM-visible documentation for this agent.

### Files affected

| File | Change |
|------|--------|
| `skills/reflect/SKILL.md` | `## State Update` extended with counter increment rules (single write per run) |
| `skills/hatch/SKILL.md` | Inline `reflection-state.json` init extended with `counters` object; Phase 4b baseline audit marker added |
| `skills/pulse/SKILL.md` | `--full` flag extended with Reflect Health section |
| `skills/session-start/SKILL.md` | Step 5b added: baseline audit offer on first session |
| `scripts/build-cortex.js` | Reads `counters` from `reflection-state.json`; injects Reflect Health block into Cortex Portal.md |
| `scripts/update-reflection-state.js` | New script — handles reflect state-update (counter increments, timestamps, missing-counters fallback) |
| `skills/reflect/SKILL.md` | `## State Update` replaced with single `update-reflection-state.js` call |
| `skills/hatch/SKILL.md` | `update-reflection-state.js` permission added to required allow list |
| `state-templates/GITIGNORE-APPEND-PROJECT.txt` | Ignore `.claude-code-hermit/.baseline-pending` |
| `state-templates/GITIGNORE-APPEND.txt` | Ignore `tasks-snapshot.md` for local-scope hermits |
| `state-templates/CLAUDE-APPEND.md` | `hermit-config-validator` added to Subagents section |
| `docs/always-on-ops.md` | Step 4 updated to mention baseline audit offer in always-on mode |

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **`tasks-snapshot.md` gitignore** — For local-scope hermits, append the new line to `.gitignore` and run `git rm --cached .claude-code-hermit/tasks-snapshot.md` if the file was previously tracked. Project-scope hermits are unaffected.

2. **Backfill `counters` on existing `reflection-state.json`** — Read `.claude-code-hermit/state/reflection-state.json`. If `counters` is absent, add it with all integer fields = `0`, both timestamp fields (`last_run_at`, `last_output_at`) = `null`, and `since` = current ISO timestamp (with offset). Preserve all other keys (`last_reflection`, `last_resolution_check`, `plugin_checks`, etc.). If the file is missing entirely, initialize with the full schema from `skills/hatch/SKILL.md`. If `counters` already exists, leave it untouched — no reset on upgrade.

3. **Add `update-reflection-state.js` permission** — In `.claude/settings.json`, add `"Bash(node */scripts/update-reflection-state.js*)"` to `permissions.allow`. Without this, reflect's state-update call will prompt for approval on every run.

4. **Refresh CLAUDE-APPEND** — Re-run `hatch` step that appends `CLAUDE-APPEND.md` to the project's `.claude/CLAUDE.md`, or manually append the `hermit-config-validator` entry to the `## Subagents` section.

No `config.json` changes required.

## [1.0.6] - 2026-04-17

### Changed

- **Storage convention tightened for plugin hermits** — `type` in frontmatter is now the explicit discriminator; subdirectories inside `raw/` or `compiled/` and new top-level folders inside `.claude-code-hermit/` are prohibited. This fixes silent breakage where artifacts in ad-hoc paths (e.g. `audits/`, `reports/`, `raw/audits/`) were invisible to session-start injection and retention archival. `CLAUDE-APPEND.md`, `knowledge-schema.md.template`, `docs/creating-your-own-hermit.md` updated with explicit do/don't rules. New `docs/plugin-hermit-storage.md` is the canonical reference for plugin authors.
- **`CLAUDE-APPEND.md`: stale `reviews/` row removed from Agent State table** — `reviews/` was listed as a first-class directory but is prohibited by the storage rules in the same file. Removed to eliminate the contradiction.
- **`CLAUDE-APPEND.md`: `memory/` added to prohibited top-level directory list** — Matches the prohibition list in `docs/creating-your-own-hermit.md`.
- **`knowledge-schema.md.template`: `location:` field casing normalized** — Per-example `Location:` entries (capitalized) normalized to lowercase `location:` to match the field declaration style in the section headers.

### Files affected

| File | Change |
|------|--------|
| `state-templates/CLAUDE-APPEND.md` | Storage rules updated; `reviews/` row removed; `memory/` added to prohibited list |
| `state-templates/knowledge-schema.md.template` | `location:` fields added to Work Products and Raw Captures sections; casing normalized |
| `docs/creating-your-own-hermit.md` | Knowledge outputs section rewritten with explicit path format and prohibitions |
| `docs/plugin-hermit-storage.md` | New canonical reference for plugin hermit storage convention |

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **CLAUDE-APPEND.md refresh** — Replace the existing `CLAUDE-APPEND.md` appendix in the target project's `.claude/` directory with the updated template. This picks up the corrected Agent State table (no `reviews/` row) and the expanded prohibited-directory list (now includes `memory/`).

No `config.json` changes required. The `knowledge-schema.md.template` change only affects new hermits hatched from this version onward — existing `knowledge-schema.md` files in target projects are operator-editable and are not overwritten by `hermit-evolve`.

## [1.0.5] - 2026-04-16

### Fixed

- **`docker-entrypoint`: channel schema mismatch + silent marketplace failure** — The entrypoint was reading `channels` as a list but `config.json` stores it as an object (`{"discord": {"enabled": true, ...}}`). This was harmless for name extraction (iterating a dict yields keys) but `enabled: false` was never checked, so disabled channels still triggered MCP enablement and plugin install attempts. More critically, `claude plugin marketplace add anthropics/claude-plugins-official` was followed by `|| true`, swallowing failures silently and leaving channel/recommended plugin installs broken on the first boot with no diagnostic output. Fixed: channel extraction now reads the object shape and filters by `enabled`; marketplace add failure surfaces a clear `ERROR:` block and sets `NEEDS_OFFICIAL=false` to skip downstream install loops that would only produce noise.
- **`docker-entrypoint`: channel and recommended plugins installed but left disabled** — `claude plugin install` installs plugins in a disabled state by default. The entrypoint was not calling `claude plugin enable` after install, so channel and recommended plugins were present but dormant — their commands never registered. Fixed: `claude plugin enable` is now called immediately after each successful install for both channel plugins and recommended plugins.
- **`claude login` → `claude /login`** — The correct Claude Code CLI invocation for OAuth login is `claude /login`, not `claude login`. Updated everywhere: `hermit-docker` executable, `docker-entrypoint.hermit.sh.template` echo messages, `docker-setup/SKILL.md`, and all docs (`faq.md`, `troubleshooting.md`, `always-on.md`, `config-reference.md`, `architecture.md`, `hermit-start.py`).
- **`hermit-docker`: `_require_running` preflight for `attach`, `bash`, `login`, `restart`** — These subcommands now check that `$SERVICE` specifically is running (not just any service in the compose file) before attempting `docker compose exec`. If the container is down they print a clear `Container is not running. Start it first: .claude-code-hermit/bin/hermit-docker up` message instead of a raw Docker error.
- **`docker-setup` Step 8: container readiness gates** — Prevents the skill from issuing `docker exec` commands against a non-running container. Three gates added: (1) "No — manual" branch now prints a self-contained manual deployment guide and skips directly to Step 9 — Login, Workspace trust, and Channel pairing are not attempted when the container hasn't been started. (2) "Yes — build now" polls `docker compose ps --status running` for up to 10s after `hermit-docker up` and shows container logs for diagnosis if the service never appears. (3) Workspace trust and Channel pairing both gate on `tmux has-session` (30s retry) before issuing `tmux send-keys`, preventing the `no server running on /tmp/tmux-.../default` error when the entrypoint is still installing plugins.
- **`docker-setup` Step 8: `access.json` verification** — Channel pairing now checks `.claude.local/channels/<plugin>/access.json` after ~3s (one retry at ~8s) and falls through to `tmux capture-pane` diagnostics if absent, instead of silently declaring success after "a few seconds".
- **`docker-setup`: broken doc link** — `docs/recommended-plugins.md` link at the end of Step 7b fixed to `../../docs/recommended-plugins.md` (relative to the skill file).

### Changed

- **`hatch` completion message** — "Go always-on" step now leads with `docker-setup` (recommended) before the bare-tmux option. `smoke-test` moved to a troubleshooting note rather than a required step. `bypassPermissions` promoted to first option in the permissions question with a clearer description.
- **`migrate`: scope confirmation gate (Step 0)** — The skill now opens by reading `config.json.scope` (authoritative) and cross-checking against `.gitignore`, surfacing any divergence. The operator is prompted to keep or switch scope before the audit runs. Switching triggers full reconciliation: updates `config.json`, reconciles `.gitignore` (removes the outbound scope's template lines, appends the target scope's lines), and for `project → local` switches runs `git rm --cached` on newly-ignored tracked paths — all behind a single pre-flight confirmation. Step 1 scope detection updated to trust the Step 0 value instead of re-detecting from `.gitignore`.

### Files affected

| File | Change |
|------|--------|
| `skills/migrate/SKILL.md` | Step 0 scope confirmation + reconciliation sub-flow; Step 1 scope detection updated |
| `state-templates/bin/hermit-docker` | `_require_running` helper; `claude login` → `claude /login` |
| `state-templates/docker/docker-entrypoint.hermit.sh.template` | `claude login` → `claude /login` in echo messages and comment |
| `skills/docker-setup/SKILL.md` | Step 8 readiness gates; doc link fix; `claude login` → `claude /login` |
| `skills/hatch/SKILL.md` | Completion message reorder; permissions option order; formatting |
| `docs/faq.md` | `claude login` → `claude /login` |
| `docs/troubleshooting.md` | `claude login` → `claude /login` |
| `docs/always-on.md` | `claude login` → `claude /login` |
| `docs/config-reference.md` | `claude login` → `claude /login` |
| `docs/architecture.md` | `claude login` → `claude /login` |
| `scripts/hermit-start.py` | `claude login` → `claude /login` in comment |
| `README.md` | Restructured introduction and quick start |

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **`hermit-docker` script** — Copy updated `state-templates/bin/hermit-docker` to `.claude-code-hermit/bin/hermit-docker`. This picks up the `_require_running` helper and the `claude /login` fix.
2. **`docker-entrypoint.hermit.sh`** — If Docker is in use, patch the rendered entrypoint at the project root: replace `claude login` with `claude /login` (two echo lines in the timeout paths). This is a cosmetic fix; the container still works — it only affects the error message shown when the 10-minute credential wait times out.

No `config.json` changes required.

## [1.0.4] - 2026-04-16

### Fixed

- **`waiting_reason` field in `runtime.json`** — New field that records why a session entered `waiting` state: `"unclean_shutdown"`, `"dead_process"`, `"conservative_pickup"`, or `"operator_input"`. Cleared to `null` when exiting `waiting`. Fixes `channel-responder` routing: on unclean shutdown or dead process, an operator reply of `(1)` / `(2)` now correctly triggers archive-or-resume via `session-mgr` instead of being treated as a task instruction.
- **`session-mgr`: `session_id` written to SHELL.md on open** — Step 6 now patches the `**ID:**` placeholder in SHELL.md with the actual `S-NNN` value so the session header is correct from the first tick. Previously the placeholder persisted until close.
- **`session-mgr`: `cost_usd` reads `.status.json` first** — On session close, `cost_usd` is read from `.claude-code-hermit/sessions/.status.json` (written by the cost-tracker hook) before falling back to parsing the SHELL.md `## Cost` section. Fixes sessions where the hook-written cost was silently discarded.
- **`session-start`: fast-path gate patches SHELL.md ID placeholder** — When the fast path fires (no session-mgr spawn), if `runtime.json` has a `session_id` and SHELL.md still shows the `S-NNN` placeholder, it is updated in-context without spawning session-mgr.
- **`routine-watcher.sh`: drain stale queue entries on startup** — Entries older than 2 hours (one heartbeat cycle) are pruned from `routine-queue.json` at watcher start. Prevents phantom stale-routine alerts from accumulating across restarts.
- **`heartbeat`: micro-proposal pending alert** — New step 6 checks `micro-proposals.json` for pending tier-1 entries and appends a monitoring alert using semantic key `micro-proposal-pending:<id>`. Prevents tier-1 micro-proposals from silently expiring if the operator doesn't notice them. Stale queue alert message now includes elapsed time for clarity.

### Changed

- **`proposal-act`: accept no longer stamps `resolved_date`** — Accept flow now sets only `status: accepted` + `accepted_date`. `resolved_date` is set later by `reflect` when it confirms the pattern is actually gone (3 consecutive session reports with no recurrence). This fixes a semantic mismatch where `weekly-review.js`'s resolution count was always zero despite accepted proposals.
- **`reflect`: concrete Resolution Check procedure** — Added a bounded round-robin step (up to 5 accepted proposals per reflect cycle) that reads each proposal's evidence, scans the last 3 session reports, and marks resolved if the pattern is absent. Tracks round-robin position in `state/reflection-state.json` under `last_resolution_check`. Appends a `resolved` metrics event on each transition.
- **`reflection-judge`: explicit gate for `Sessions: none`** — Added a step 0 rule: if `Sessions: none` is passed, the judge immediately returns `SUPPRESS: <title> — no cross-session evidence cited`. No evidence verification or tier check is performed. `reflect` notes SUPPRESSED candidates in SHELL.md Findings for future revisit.
- **`proposal-create`: `created` events now include `source` and `category`** — The metrics payload for proposal creation now includes `source` (manual / auto-detected / operator-request) and `category` (improvement / routine / capability / constraint / bug). Adds `operator-request` and `bug` to enums (previously documented in `frontmatter-contract.md` but absent from the skill).
- **`generate-summary.js`: per-source acceptance rates and resolved count** — New metrics: auto-detected acceptance rate, manual acceptance rate, resolved proposal count. Frontmatter gains `proposals_resolved` and `auto_detect_accept_rate` fields. Allows answering "are autonomous proposals good?" for the first time.
- **`reflect`, `session-start`: notification routing de-duplicated** — The "Always-On Notification Rule" block (identical in both skills) replaced with a one-liner deferring to CLAUDE.md § Operator Notification. Single source of truth stays in `CLAUDE-APPEND.md`.
- **`reflect`: micro-proposal `question` text preserved in JSONL** — `micro-queued` events now include `question` (full text). The question is also stored in `micro-proposals.json` active slot so `channel-responder` and `brief` can echo it in `micro-resolved` events. Enables post-hoc analysis of what was asked and operator response patterns.
- **`heartbeat`: `noise_ticks` self-eval field** — Self-eval entries gain a `noise_ticks` counter incremented when an alert fires and is linked to a dismissed proposal (via `self_eval_key`). Lazy reset when a linked proposal is accepted or resolved. At 20+ noise ticks across 3+ sessions, creates a proposal to retune or remove the noisy check — mirrors the existing `clean_ticks` removal pathway.
- **`docs/frontmatter-contract.md`: lifecycle table updated** — `resolved_date` writer changed from `proposal-act` to `reflect skill (pattern absence)`.

### Files affected

| File | Change |
|------|--------|
| `agents/session-mgr.md` | `waiting_reason` field docs; `session_id` → SHELL.md on open; `cost_usd` reads `.status.json` first |
| `scripts/routine-watcher.sh` | Drain stale queue entries older than 2h on startup |
| `skills/channel-responder/SKILL.md` | Route `waiting_reason` for unclean shutdown / dead process replies |
| `skills/heartbeat/SKILL.md` | `micro-proposal-pending` alert key; step 6 micro-proposal check; `noise_ticks` self-eval field; stale queue message includes elapsed time; `waiting_reason` on NEXT-TASK.md conservative pickup |
| `skills/session-start/SKILL.md` | Set `waiting_reason` on unclean shutdown / dead process; fast-path patches SHELL.md ID; de-duplicate notification routing |
| `skills/proposal-act/SKILL.md` | Remove `resolved_date` stamp from accept flow |
| `skills/reflect/SKILL.md` | Add resolution check procedure; de-duplicate notification routing; preserve micro-proposal `question` in JSONL |
| `agents/reflection-judge.md` | Add explicit `Sessions: none` suppression gate |
| `skills/proposal-create/SKILL.md` | Add `source` and `category` to `created` metrics events |
| `scripts/generate-summary.js` | Per-source acceptance rates and resolved count |
| `docs/frontmatter-contract.md` | Update `resolved_date` lifecycle table |

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **No config.json changes required** — all changes are in skill/agent files.
2. **`state/reflection-state.json`** — if it exists and lacks a `last_resolution_check` key, no action needed; the resolution check procedure initializes it on first run.
3. **`state/alert-state.json` self_eval entries** — existing entries lack `noise_ticks`. The heartbeat self-eval step initializes missing fields as 0 on first read; no manual migration needed.
4. **Existing `proposal-metrics.jsonl` events** — old `created` events without `source`/`category` fields are handled by `generate-summary.js` bucketing them as `unknown`. No backfill required.
5. **Accepted proposals with `resolved_date` already set** — these were stamped at accept time under the old behavior. They may show a `resolved_date` even though `status` is `accepted`, not `resolved`. On first reflect run, the resolution check will re-evaluate them. If the pattern is gone, they'll be promoted to `resolved` (updating `resolved_date` to the current time). If not, `resolved_date` stays set but `status` remains `accepted` — a cosmetically odd but non-breaking state that will self-heal.

## [1.0.3] - 2026-04-16

### Added

- **`proposal-triage` agent (Haiku)** — pre-creation gate for the proposal pipeline. Deduplicates against existing PROP-NNN files and applies the three-condition rule before any proposal is queued. Called by both `proposal-create` and `reflect` (Tier 1/2 micro-approvals). Returns `CREATE | SUPPRESS:<reason> | DUPLICATE:<id>`.
- **`reflection-judge` agent (Sonnet)** — post-reflect validator that verifies cross-session evidence citations actually exist in S-NNN-REPORT.md before proposals or micro-approvals are queued. Returns `ACCEPT | DOWNGRADE:<tier> | SUPPRESS` per candidate. Prevents phantom proposals from reflect runs with weak or fabricated evidence.
- **`knowledge` skill** — read-only lint of `raw/` and `compiled/`. Flags stale, unreferenced, missing-type, and oversized artifacts with actionable advice. Delegates to `scripts/knowledge-lint.js`. Activates on "check knowledge", "lint knowledge", "knowledge health".
- **`scripts/knowledge-lint.js`** — shared lint module extracted from `weekly-review.js`. Called by the `knowledge` skill and imported by the weekly review script. Eliminates the duplicate inline logic that previously lived only in the weekly review.
- **Test infrastructure: `tests/run-all.sh`, `tests/lib.sh`, `tests/run-scripts.sh`** — unified test entry point running hook, contract, and script suites in sequence. Script suite covers `knowledge-lint.js`, `check-upgrade.sh`, `deny-patterns.json`, bin executability, and knowledge lint scenarios. `lib.sh` provides shared assertions for shell test scripts.

### Changed

- **`reflect`: evidence validation pipeline** — before acting on any proposal candidate, `reflect` now delegates to `claude-code-hermit:reflection-judge` to verify that cited sessions actually describe the claimed pattern. Only ACCEPT and DOWNGRADE verdicts proceed. Additionally, all Tier 1/2 candidates pass through `claude-code-hermit:proposal-triage` before micro-approval queuing. Tier 3 candidates also pass through triage before calling `proposal-create`.
- **`proposal-create`: pre-creation gate** — calls `claude-code-hermit:proposal-triage` before writing any file. Stops with a caller-facing message on DUPLICATE or SUPPRESS. Eliminates redundant proposals without requiring the operator to review them.
- **`pulse --full`** — new flag that appends infrastructure health sections after the session block: proposal counts by status, pending micro-proposals, routines on/off, last reflect/heartbeat timestamps, and knowledge file counts (`raw/`, `compiled/`, `raw/.archive/`).
- **`heartbeat`: IDLE-TASKS management** — when the operator asks about idle tasks (add, remove, manage), heartbeat now reads/writes `.claude-code-hermit/IDLE-TASKS.md` instead of HEARTBEAT.md. Creates the file from template if absent. Warns if `idle_behavior` is not `"discover"`.
- **`weekly-review.js`: simplified via shared lint** — knowledge health section now calls `knowledgeLint()` from `knowledge-lint.js` instead of duplicating the logic inline. Output format updated to per-finding lines with file, age, and reason.
- **`HEARTBEAT.md.template`: removed two redundant built-in checks** — "Check for NEXT-TASK.md" and "Check if current task has blocked items that may have resolved" are handled natively by the heartbeat skill. Removed to reduce LLM reasoning load per tick.
- **Test runner unified** — `tests/run-hooks.sh` refactored to use shared lib. All suites now accessible via `bash tests/run-all.sh`. Smoke-test-runner agent updated to use the unified entry point.
- **`CLAUDE.md` and `CLAUDE-APPEND.md`** — `proposal-triage` and `reflection-judge` added to agent listings. `/knowledge` added to CLAUDE-APPEND.md Quick Reference. Subagent section in CLAUDE-APPEND.md expanded with descriptions for all four agents.

### Files affected

| File | Change |
|------|--------|
| `agents/proposal-triage.md` | New agent |
| `agents/reflection-judge.md` | New agent |
| `skills/knowledge/SKILL.md` | New skill |
| `scripts/knowledge-lint.js` | New shared lint module |
| `tests/run-all.sh` | New unified test entry point |
| `tests/lib.sh` | New shared test assertions library |
| `tests/run-scripts.sh` | New script/static test suite |
| `tests/run-hooks.sh` | Refactored to use lib.sh |
| `skills/reflect/SKILL.md` | Evidence validation + triage gate |
| `skills/proposal-create/SKILL.md` | Pre-creation triage gate |
| `skills/pulse/SKILL.md` | `--full` infrastructure health flag |
| `skills/heartbeat/SKILL.md` | IDLE-TASKS management subcommand |
| `scripts/weekly-review.js` | Delegates knowledge lint to shared module |
| `state-templates/HEARTBEAT.md.template` | Removed redundant built-in check items |
| `state-templates/CLAUDE-APPEND.md` | Added `/knowledge`, agent descriptions |
| `CLAUDE.md` | Added proposal-triage and reflection-judge to agent list |
| `docs/skills.md` | knowledge skill entry; pulse --full documented |
| `docs/architecture.md` | Minor updates |
| `README.md` | Updated |
| `.claude/agents/smoke-test-runner.md` | Updated to use run-all.sh |
| `.claude/skills/test-run/SKILL.md` | Updated for unified test runner |
| `.claude/skills/release/SKILL.md` | Release process improvements |

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **CLAUDE-APPEND refresh** — refresh CLAUDE-APPEND.md to pick up `/knowledge` in Quick Reference and the updated Subagents section (replaces the old single-line `## Subagent: session-mgr` entry).
2. **No config.json changes required** — all new behavior is in skill/agent files.
3. **New agents are available immediately** — `proposal-triage` and `reflection-judge` ship with the plugin; no per-project action needed. Skills that call them (`reflect`, `proposal-create`) will use them automatically.

**Clean up HEARTBEAT.md (if applicable):**

1. Read `.claude-code-hermit/HEARTBEAT.md`. If the file does not exist, skip these steps.
2. Remove the line `- Check for NEXT-TASK.md` if present. Remove the line `- Check if current task has blocked items that may have resolved` if present.
3. After both removals, for each of `## Idle Checks` and `## Task Checks`: if the header now has no remaining checklist items beneath it, remove that header too.
4. If any changes were made, write the file back and report what was cleaned up. If nothing changed, skip silently.

## [1.0.2] - 2026-04-15

### Fixed

- **Fully qualified agent/skill names enforced throughout skill instructions** — Bare names (e.g., `:session-mgr`) were silently misrouted by the harness. All skill instruction files now use the canonical `claude-code-hermit:<name>` form. Affects every skill that spawns a subagent or invokes another skill.
- **session-mgr: null `session_id` fallback on runtime.json write** — If `session_id` was null or missing when setting `session_state` to `in_progress`, the session would archive under `S-null`. Step 7 now pre-computes the ID in the same write if it wasn't set in step 6.
- **session-mgr: invocation payload takes precedence over stale SHELL.md** — On both close and idle-transition, if the caller passes structured task data (status, blockers, lessons, changed files), those values are used directly instead of re-reading potentially stale SHELL.md fields.

### Changed

- **session-start: fast-path gate skips session-mgr on normal startup** — When `runtime.json` is healthy (`session_state` ∈ {`in_progress`, `idle`, `waiting`}, no transition, no last_error) and SHELL.md exists, session-mgr is not spawned. SHELL.md content is already injected by the startup hook. This eliminates a full agent spawn on every normal session start.
- **session / session-close: compile final data in-context before handing off to session-mgr** — Callers now gather status, blockers, lessons, and changed files in-context and pass a compact structured payload to session-mgr. This removes the previous pattern where session-mgr had to re-read SHELL.md fields that the caller already knew, and prevents stale reads from overwriting in-context data.
- **session-mgr: maxTurns reduced from 15 to 12** — Consistent with actual observed turn counts; the previous ceiling was never reached.
- **hermit-settings: improved guidance** — Clearer instructions for configuring hermit behavior.

### Files affected

| File | Change |
|------|--------|
| `agents/session-mgr.md` | maxTurns 15→12; null session_id fallback; payload-precedence rule on close/idle |
| `skills/session-start/SKILL.md` | Fast-path gate: skip session-mgr when runtime state is clean |
| `skills/session/SKILL.md` | Compile final data in-context; structured compact payload to session-mgr |
| `skills/session-close/SKILL.md` | Compile final data in-context; structured compact payload to session-mgr |
| `skills/hermit-settings/SKILL.md` | Improved configuration guidance |
| All skill/agent instruction files | Bare agent/skill names replaced with fully qualified `claude-code-hermit:` form |

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **CLAUDE-APPEND refresh** — No changes to CLAUDE-APPEND.md in this release; refresh is not required.
2. **No template changes** — State templates and `config.json` are unchanged.
3. **Behavioral changes are in skill/agent instruction files only** — These take effect immediately via the plugin; no per-project migration needed.

No `config.json` changes required.

## [1.0.1] - 2026-04-15

### Fixed

- **State JSON files now copied from templates during hatch** — `alert-state.json`, `routine-queue.json`, and `micro-proposals.json` were previously created by the LLM writing inline JSON from memory. This could produce malformed content (e.g. `[]` instead of `{"queued": []}`) that silently broke routine queuing. They are now copied from canonical templates in `state-templates/`, matching the pattern used for all other hatch-created files.
- **Smoke-test now validates and repairs state file schema** — New step 6 checks all three schema-sensitive state files. If a file is missing, unparseable, or has the wrong shape, it is repaired (backfilling missing keys, overwriting wrong-type keys) without discarding existing data. Each repaired file emits a WARN.

### Added

- `state-templates/routine-queue.json.template` — canonical initial content `{"queued": []}`
- `state-templates/alert-state.json.template` — canonical initial content with `alerts`, `self_eval`, `total_ticks`, `last_digest_date`
- `state-templates/micro-proposals.json.template` — canonical initial content `{"active": null}`

### Files affected

| File | Change |
|------|--------|
| `state-templates/routine-queue.json.template` | New template |
| `state-templates/alert-state.json.template` | New template |
| `state-templates/micro-proposals.json.template` | New template |
| `skills/hatch/SKILL.md` | Copy 3 state files from templates instead of inline LLM JSON |
| `skills/smoke-test/SKILL.md` | Add step 6: state file validation and repair |

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **CLAUDE-APPEND refresh** — No changes to CLAUDE-APPEND.md in this release; refresh is not required.
2. **Template copy** — The three new `.template` files are only used during `hatch`. Existing hermit state files are not touched automatically; if you suspect a malformed state file, run `/claude-code-hermit:smoke-test` to detect and repair it.

No `config.json` changes required.

## [1.0.0] - 2026-04-14

Initial public release.
