# Changelog

## [Unreleased]

### Added

- **`bin/hermit-attach` helper** — one short command (`.claude-code-hermit/bin/hermit-attach`) to reconnect to the running hermit in either tmux or docker mode. Reads `state/runtime.json` and dispatches to `tmux attach` or `hermit-docker attach`. `hermit-start` now prints `bin/hermit-attach` as the primary attach hint; `hermit-status` echoes it for non-docker runtimes.

- **`hermit-docker update` subcommand** — explicit command to update the Claude Code CLI and refresh plugin marketplace catalogs. Three modes: full (image rebuild + marketplace refresh), `--cc-only` (rebuild only), `--plugins-only` (marketplace refresh + `/reload-plugins` into the live tmux session, zero downtime). Includes `--dry-run`, `--yes`, and preview output. Logs each run to `state/update-history.jsonl`.

### Changed

- **channel-responder: recognize slash commands** — added a `Slash command` branch at the top of step 2 classification. Messages starting with `/` (e.g. `/simplify`, `/plugin:command`) are now routed to the matching skill, slash command, or subagent via the appropriate tool instead of being misclassified and drawing an improvised "don't recognize this command" reply.

### Files affected

| File | Change |
|------|--------|
| `state-templates/bin/hermit-attach` | New helper — reconnect to tmux or docker session |
| `state-templates/bin/hermit-docker` | `update` subcommand added |
| `state-templates/bin/hermit-status` | Attach hint added for tmux runtime |
| `scripts/hermit-start.py` | Attach hint now shows `bin/hermit-attach` |
| `skills/docker-setup/SKILL.md` | `update` added to step 9 command reference |
| `skills/hatch/SKILL.md` | `update-history.jsonl` added to state init list |
| `skills/channel-responder/SKILL.md` | Slash command branch added to classifier |

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **bin/hermit-docker update support:** rewrite `.claude-code-hermit/bin/hermit-docker` from the updated template (step 5b already does this wholesale). No operator action needed.
2. **update-history.jsonl:** create empty `.claude-code-hermit/state/update-history.jsonl` if it does not exist.
3. **bin/hermit-attach:** copy `state-templates/bin/hermit-attach` to `.claude-code-hermit/bin/hermit-attach` and `chmod +x`. Overwrite if present.
4. **bin/hermit-status:** rewrite `.claude-code-hermit/bin/hermit-status` from the updated template (step 5b already does this).

## [1.0.16] - 2026-04-22

### Changed

- **reflect-scheduled-checks: decoupled from reflect** — now a self-contained routine skill; `reflect` no longer runs or adjusts scheduled checks. New `scheduled-checks` routine fires at `5 9 * * *`.
- **reflect-scheduled-checks: split unavailable/error gating** — `unavailable` backs off 4 hours only; `error` backs off `interval_days`. Adds `last_error_at` field to state.
- **micro-proposals: drop single-slot constraint** — schema changes from `{active: null}` to `{pending: []}`, allowing multiple concurrent proposals; channel-responder matches by ID.
- **hermit-start.py: export `CLAUDE_PLUGIN_ROOT` to always-on tmux session** — Bash tool calls inside cron-triggered skills now have the variable available.

### Fixed

- **reflect-scheduled-checks: false-negative unavailable classification** — uses loaded-skills list instead of filesystem grep for presence checks.
- **proposal-triage: prevent turn exhaustion on multi-file dedup runs** — `maxTurns` raised from 5 to 8; verdict directive added to prevent early exit.

### Files affected

| File | Change |
|------|--------|
| `skills/reflect-scheduled-checks/SKILL.md` | Standalone routine; unavailable/error gating split; loaded-skills presence check |
| `skills/reflect/SKILL.md` | Removed scheduled-checks section and interval-adjustment logic |
| `agents/proposal-triage.md` | maxTurns 5→8; terminal verdict directive added |
| `skills/channel-responder/SKILL.md` | Multi-slot micro-proposals: ID-based answer matching |
| `skills/heartbeat/SKILL.md` | Multi-slot micro-proposals: pending array |
| `skills/brief/SKILL.md` | Multi-slot micro-proposals: pending array |
| `skills/smoke-test/SKILL.md` | Multi-slot micro-proposals: pending array |
| `scripts/generate-summary.js` | Multi-slot micro-proposals: pending array |
| `scripts/hermit-start.py` | CLAUDE_PLUGIN_ROOT export; scheduled-checks routine in DEFAULT_CONFIG |
| `state-templates/config.json.template` | scheduled-checks routine added |
| `state-templates/micro-proposals.json.template` | Schema: `{active: null}` → `{pending: []}` |
| `CLAUDE.md` | `reflect-scheduled-checks` added to skills list |
| `state-templates/CLAUDE-APPEND.md` | `reflect-scheduled-checks`, `channel-responder` added to quick reference |

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Migrate `micro-proposals.json`:** Read `micro-proposals.json`. If it has a top-level `active` key: if value is null, rewrite as `{"pending": []}`. If value is an object, rewrite as `{"pending": [<that object with tier: 1 if missing>]}`. Remove `active` in both cases.

2. **Add `scheduled-checks` routine:** If `config.json` routines contains no entry with `id: "scheduled-checks"`, append `{"id": "scheduled-checks", "schedule": "5 9 * * *", "skill": "claude-code-hermit:reflect-scheduled-checks", "run_during_waiting": true, "enabled": true}`. Skip if already present.

3. **Add `last_error_at` field:** For each entry under `state/reflection-state.json → scheduled_checks`, if `last_error_at` is absent, add `"last_error_at": null`.

4. **Restart always-on session:** Run `hermit-stop` then `hermit-start` so the new `CLAUDE_PLUGIN_ROOT` export takes effect in the tmux environment.

No `config.json` schema changes required beyond the routine addition in step 2.

## [1.0.15] - 2026-04-22

### Added

- **iMessage channel support in channel-hook** — `scripts/channel-hook.js` now recognizes `imessage` tool names (via both `SERVER_TO_CHANNEL` and the tool-name regex), so `dm_channel_id` persistence works for iMessage MCP bots the same way it does for Discord and Telegram. `hooks/hooks.json` PostToolUse matcher extended to `(discord|telegram|imessage).*reply`. Test added to `tests/run-hooks.sh` (17b).
- **plugin-validator: native `claude plugin validate` as Check 0** — the agent now runs the official Claude Code validator first and treats its findings as authoritative for schema compliance; hermit-specific checks (1–7) layer cross-references on top.
- **release-auditor: marketplace.json version cross-check** — audits `plugins[0].version` in marketplace.json against `plugin.json.version`. The plugin manifest wins silently when they differ, so a mismatch is a FAIL.

### Changed

- **marketplace.json: full metadata** — adds top-level `metadata.description`, and per-plugin `author`, `license`, `homepage`, `repository`, and `keywords` so marketplace listings render correctly.
- **release skill: native validator + marketplace version sync** — step 1 now runs `/plugin validate .` before tests; step 4 verifies plugin.json and marketplace.json versions agree via `jq`; step 6 derives the tag name from `jq` instead of a typed literal so the tag can't drift from the bumped version.
- **docs/security.md: Docker plugin trust model** — reflects the current policy: the entrypoint installs every enabled entry in `docker.recommended_plugins` regardless of marketplace; the trust gate is at configuration time (explicit operator confirmation during `/docker-setup` or `/hermit-settings docker`), with preselection restricted to `claude-plugins-official` and `gtapps/*`.
- **brief skill: no longer auto-closes sessions** — if SHELL.md is `in_progress`, brief notes "run /session-close to archive" and lets the operator decide instead of delegating to `/session-close --idle`. Idle transitions are owned by the `session` skill and `session-mgr`. Output cap relaxed to 6 lines (5 content + optional proposal line).
- **smoke-test skill: cron schedule validation** — routine validator now requires the `schedule` key (5-field cron) and FAILs on legacy `time`/`days` fields, matching the routines schema in config.

### Fixed

- **hermit-stop in interactive mode no longer corrupts runtime state** — when the operator is driving Claude in a terminal (no tmux session), `hermit-stop.py` prints the "terminate Claude manually" message and exits early instead of falling through to `update_runtime_field({session_state: 'idle', ...})`. The Stop hook owns the idle transition when Claude actually exits; preempting it left `runtime.json` claiming `idle` while Claude was still running.
- **docs/skills.md: smoke-test vs test-run descriptions swapped** — the table had the two descriptions transposed; smoke-test is post-hatch validation, test-run is the full test suite.
- **docs/testing.md: frontmatter validator path** — script moved from `tests/` to `scripts/`; doc updated to match.
- **README.md: `/claude-code-hermit:evolve` → `/claude-code-hermit:hermit-evolve`** — upgrade instructions referenced the old skill name.
- **SHELL.md.template: `/monitor` → `/watch`** — monitoring section pointed to the old skill name.

### Added

- **knowledge-lint: `schema-empty` and `schema-missing` findings** — previously, a freshly-hatched hermit with an all-commented `knowledge-schema.md` silently disabled all type enforcement (the template's example bullets are inside `<!-- -->`, so `parseSchema` returned `null`). Both new findings now emit at normal verbosity (no `--verbose` required). Findings are suppressed when the hermit has no artifacts yet (empty hermit).
- **knowledge-schema.md template: starter bullets** — the template now ships with one uncommented entry under `## Work Products` (`note`) and one under `## Raw Captures` (`input`). Fresh hermits start with type enforcement active; operators replace these with their real types.
- **startup-context: `---Storage Drift---` section** — at session start, scans `.claude-code-hermit/` for artifacts in paths invisible to session injection and archival: unknown top-level dirs, and subdirs under `raw/`/`compiled/`. Emits a capped warning only when drift is present; completely silent when the hermit is clean (zero recurring context cost).

### Changed

- **knowledge-lint: `parseSchema` sentinel split** — `parseSchema` now returns `false` for a missing file and `null` for a present-but-empty schema (previously both returned `null`). Removes the `fs.accessSync` TOCTOU pre-check that existed only to distinguish those two cases, and drops the redundant `verbose && !schemaPresent` info line in the findings-present path (covered by the `schema-missing` finding and advice line).
- **update-reflection-state: simplified `last_sparse_nudge` fallback** — the fallback `state.last_sparse_nudge ?? null` was unreachable when `mergedNudge` is empty (empty merge implies existing state was also empty); simplified to `null`.
- **`plugin_checks` renamed to `scheduled_checks`** — the config key, state key, `/hermit-settings` subcommand, and `reflect-plugin-checks` sub-skill were named for their original use case (running installed plugin skills on a cadence), but the execution path is fully generic: any skill that conforms to the contract (idempotent, returns findings or nothing, no self-scheduling, safe during reflect cadence) can be registered. The "plugin" framing misled hermit authors into thinking custom skills needed a separate mechanism. Rename surfaces:
  - Config key: `config.json.plugin_checks` → `config.json.scheduled_checks`
  - State key: `state/reflection-state.json.plugin_checks` → `state/reflection-state.json.scheduled_checks`
  - Subcommand: `/hermit-settings plugin-checks` → `/hermit-settings scheduled-checks`
  - Sub-skill: `claude-code-hermit:reflect-plugin-checks` → `claude-code-hermit:reflect-scheduled-checks`
  - Evidence Source tag: `plugin-check/<id>` → `scheduled-check/<id>` (proposal pipeline provenance)
  - Operator-facing copy: "Plugin Checks" → "Scheduled Checks" in docs and `/hermit-settings` output
  - The check execution pipeline is unchanged; only names change.

### Added

- **reflection-judge: `ACCEPT (operator-request)` verdict tag** — adds `operator-request` as a valid source tag in the judge's output grammar, completing coverage alongside `current-session` and `scheduled-check`. Test suite (section 4 of `recurrence-gate-matrix.sh`) now validates all three tags have example verdict lines in the agent definition.
- **tests: DOWNGRADE grammar and verdict-tag coverage checks** — `recurrence-gate-matrix.sh` gains two new sections: section 3 verifies `reflection-judge.md` contains a `DOWNGRADE` example; section 4 verifies all source tags (`current-session`, `scheduled-check`, `operator-request`) have example verdict lines.
- **docs: `source` field semantics clarified in frontmatter-contract** — `source:` is documented as origin-only; gate bypass is governed by the candidate-level `Evidence Source:` field, not by `source:`. The `session` field exemption for `operator-request` is now annotated as a structural legacy rule with a pointer to the validating code.
- **CLAUDE.md: "Avoid overengineering" constraint** — added to development constraints.
- **.gitignore: `.codex` entry** — excludes Codex CLI working directory from version control.

- **reflect/proposal pipeline: Evidence Source provenance tags** — `reflection-judge`, `proposal-triage`, `proposal-create`, and `reflect` now accept an optional `Evidence Source:` field (`archived-session` | `current-session` | `scheduled-check/<id>` | `operator-request`). Scheduled-check and operator-request sources bypass the cross-session recurrence check (Three-Condition Rule #1) at every gate; conditions #2 and #3 still apply. Structured suppress codes (`no-evidence`, `no-sessions`, `weak-recurrence`, `weak-consequence`, `not-actionable`) replace free-text reasons for machine-parseable audit trails.
- **reflect: evidence integrity rule** — for `current-session` candidates, reflect must not inject evidence into `SHELL.md` before `reflection-judge` reads it; doing so would make the system self-certifying. Inferred patterns (cost, timing, token counts) are ineligible for `current-session` sourcing in the same run.
- **reflect: suppression detail in Progress Log** — when suppressions occur, the progress-log line now appends a `suppressed: [<slug>: <code>, ...]` suffix (capped at 3 entries) for compact audit.
- **tests: recurrence-gate-matrix test suite** — `tests/recurrence-gate-matrix.sh` added to `run-all.sh`; validates Evidence Source bypass behaviour across all pipeline gates.

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill executes these steps:

1. **Rename config key in `.claude-code-hermit/config.json`:** if a top-level `plugin_checks` array exists, rename it to `scheduled_checks`. If both `plugin_checks` and `scheduled_checks` exist, merge entries by `id` (scheduled_checks wins on conflict); log the merge to stderr and continue. Preserve all other top-level keys unchanged. If neither exists, no-op.
2. **Rename state key in `.claude-code-hermit/state/reflection-state.json`:** if a top-level `plugin_checks` object exists, rename it to `scheduled_checks` (pure key move, values unchanged). If `reflection-state.json` is missing, no-op. Preserve all other top-level keys unchanged.
3. **Evidence Source tag in proposals:** no automated migration. If `.claude-code-hermit/proposals/PROP-*.md` contains the string `plugin-check/`, it refers to historical provenance and can be left as-is — the tag is human-readable and does not affect gate behavior for accepted/resolved proposals. Operators may manually search-replace to `scheduled-check/` if desired.
4. **Operators invoking `/hermit-settings plugin-checks` will get "unknown subcommand"** after upgrade. Use `/hermit-settings scheduled-checks` instead.
5. **Seed starter bullets if `knowledge-schema.md` parses empty:** if `.claude-code-hermit/knowledge-schema.md` exists and has no uncommented bullet lines under `## Work Products` or `## Raw Captures` (all bullets inside HTML comments), append `- note: general-purpose compiled note. location: compiled/note-<slug>-<date>.md` under `## Work Products` and `- input: general-purpose raw capture. location: raw/input-<slug>-<date>.md` under `## Raw Captures`. Preserve all existing content and comments. If the section headers are missing, append them with the bullets. If the file is missing, no-op (hatch creates it on first run).

## [1.0.14] - 2026-04-20

### Added

- **docker-setup: plugin-declared apt dependencies (step 7b.packages)** — domain plugins can now declare the apt packages their own scripts require by adding a `## Docker apt dependencies` section to their `hatch` SKILL.md or a `DOCKER.md` file at the plugin root. `docker-setup` reads these declarations for every confirmed mirrored plugin (step 7b.packages), unions them with the project-level scan results, validates each name against `^[a-z0-9][a-z0-9+\-.]+$`, and presents a single unified confirmation prompt with origin labels before baking the approved set into `Dockerfile.hermit` via `{{PACKAGES_BLOCK}}`. Packages installed at image build time eliminate the need for runtime venvs or post-install scripts inside ephemeral container volumes.
- **boot_skill: domain hermits can override the always-on bootstrap skill** — `hermit-start.py` now reads an optional top-level `boot_skill` field from `config.json`. When set (e.g. `"/claude-code-homeassistant-hermit:ha-boot"`), it replaces the default `/claude-code-hermit:session` bootstrap the core boot script sends into the tmux REPL. The domain boot skill is responsible for invoking `/claude-code-hermit:session-start` itself before running domain-specific setup (HA probes, context refresh, etc.). Domain hermits declare their skill once in `.claude-plugin/plugin.json` under `hermit.boot_skill`; `hatch` reads that field when activating the hermit and writes it into the project config. No new bin scripts, no shim-swapping — boot stays core-owned, composition lives in the skill layer. Operators can view/clear/change via `/claude-code-hermit:hermit-settings boot-skill`.

### Changed

- **docker-setup: package confirmation deferred to after plugin selection** — the project-signal apt scan (step 2.3) now collects candidates without immediately writing `docker.packages`; final confirmation happens in new step 7b.packages after the plugin list is finalized, so plugin-declared deps can be included in a single unified prompt.

### Fixed

- **hermit-docker: revert login to REPL `/login`** — `claude auth login` can't complete OAuth in Docker/tmux (no browser callback path); reverted to `docker compose exec` REPL with post-exit credential verification.
- **docker-setup: setup-mode bootstrap suppression** — first boot now lands on an idle REPL prompt; `hermit-start.py` reads-and-deletes `.setup-mode` marker, skipping bootstrap send (one-shot).
- **docker-setup: channel pairing confirmation gates** — skill blocks with `AskUserQuestion` before pair command and before `access.json` verification; eliminates race past unfinished pairing.
- **docker-setup: login gate** — skill asks "Done / Failed" after `hermit-docker login`; on failure surfaces logs and stops.
- **docker-setup: drop `/reload-plugins` pre-pair** — was a workaround for bootstrap-turn collision; no longer needed.
- **docker-setup step 9: clarify no-session on fresh setup** — explicit note prevents LLM adding sleep loops waiting for a session.
- **docker-setup: pre-create channel state dirs before compose up** — if `.claude.local/channels/<plugin>/` doesn't exist on the host when `docker compose up` runs, Docker creates it as root; the `claude` user inside the container then can't write to the bind-mount. Skill now runs `mkdir -p .claude.local/channels/<plugin>` for each channel before `docker compose up -d --build`.
- **tmux send-keys: split text and Enter into two calls** — Claude Code's TUI treated one-shot `send-keys '<text>' Enter` as bracketed paste, turning `Enter` into a literal newline instead of submit. Pair commands, policy commands, and graceful-shutdown requests now send text and `Enter` as separate `send-keys` calls with a 0.5s pause between them (same fix already applied in `scripts/hermit-start.py`). Affects `state-templates/bin/hermit-docker`, `state-templates/docker/docker-entrypoint.hermit.sh.template`, and `skills/docker-setup/SKILL.md` (manual deployment + channel pairing steps).
- **docker-setup: verify channel token before pairing** — before asking for a pairing code, step 8 now checks that `.claude.local/channels/<plugin>/.env` exists and contains the expected `*_BOT_TOKEN` var; if missing, pairing is skipped for that channel with a clear next-step message instead of prompting for a code that can't be used.
- **config template: add boot_skill field** — `boot_skill` was used by `hermit-start.py` but absent from `config.json.template` and `DEFAULT_CONFIG`; new projects now have the field populated as `null`.

### Files affected

| File | Change |
|------|--------|
| `state-templates/bin/hermit-docker` | Login reverts to REPL via `compose exec`; post-exit credential verification; use `CLAUDE_CONFIG_DIR` env var |
| `state-templates/docker/docker-entrypoint.hermit.sh.template` | Banner updated to match REPL-based login flow |
| `scripts/hermit-start.py` | Setup-mode marker check: read-and-delete `.setup-mode`, skip bootstrap if present; `boot_skill` config field overrides the default `/claude-code-hermit:session` bootstrap |
| `skills/hatch/SKILL.md` | Step 3 reads `hermit.boot_skill` from activated hermit's `plugin.json`; step 5 writes it to `config.boot_skill` |
| `skills/hermit-settings/SKILL.md` | New `boot-skill` argument to view/clear/change `config.boot_skill` |
| `skills/docker-setup/SKILL.md` | Login gate; setup-mode touch before build; blank-prompt note; drop reload-plugins; pairing gates; step 9 no-session note; step 2.3 defers confirmation; new step 7b.packages unions project + plugin-declared apt deps |
| `docs/creating-your-own-hermit.md` | New Docker dependencies section documenting the `## Docker apt dependencies` convention (hermit-owned vs project-owned scope split); simplified hatch naming to just `hatch` (plugin namespace disambiguates) |
| `state-templates/config.json.template` | Added `boot_skill: null` top-level key |
| `scripts/hermit-start.py` | Added `boot_skill: None` to `DEFAULT_CONFIG` |

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Replace** `state-templates/bin/hermit-docker` with the updated version from the plugin.
2. **Replace** `state-templates/docker/docker-entrypoint.hermit.sh.template` with the updated version from the plugin.
3. **Sync `boot_skill` from any activated domain hermit.** For each hermit recorded in `_hermit_versions` (excluding `claude-code-hermit`):
   - Locate the hermit's `plugin.json` via the same sibling-plugin scan used at init (`${CLAUDE_PLUGIN_ROOT}/../*/.claude-plugin/plugin.json`).
   - If its manifest declares `hermit.boot_skill` (e.g. `"/claude-code-homeassistant-hermit:ha-boot"`):
     - If the project's `config.boot_skill` is `null` or missing: set it to the declared value.
     - If `config.boot_skill` is already set and matches the declared value: no-op.
     - If `config.boot_skill` is set to a skill in a *different* plugin's namespace: leave it alone and warn the operator about the conflict.
   - If the hermit's manifest omits `hermit.boot_skill` but `config.boot_skill` currently points at a skill in that hermit's namespace: clear `config.boot_skill` to `null` so the default `/claude-code-hermit:session` takes over.
   - If no domain hermit is activated: leave `config.boot_skill` as-is (likely `null`).

**If you have root-owned `.claude.local/channels/` dirs from a previous setup:** fix them on the host with `sudo chown -R $USER .claude.local/` from the project root, then restart the container.

`config.json` gains an optional top-level `boot_skill` field (string or `null`). Step 3 above handles population for existing projects with a domain hermit; core-only projects need no manual change.

---

## [1.0.13] - 2026-04-20

### Added

- **reflect: adaptive phase gates** — `newborn` (<3d) / `juvenile` (3–13d) / `adult` (14+d) gate recurrence and sub-threshold surfacing; closes the cold-start silence on fresh installs. Tier 2/3 still require real cross-session evidence in every phase.
- **reflect: operator-value self-check** — reflection questions now include dismiss-ratio and deferred-proposal-buildup checks from `proposal-metrics.jsonl`.
- **reflect: cost-spike detection** — today's cost vs 7-day median; `>2×` records a sub-threshold observation eligible for recurrence graduation.
- **reflect: Component Health agent check** — flags `reflection-judge` when `judge_suppress > 2× judge_accept` with ≥5 verdicts.
- **reflect: mandatory Progress Log entry** — every run (including empty) appends `[HH:MM] reflect (<phase>) — ...` to SHELL.md.

### Changed

- **reflect: silent by default** — unconditional top-of-skill operator notification removed; notify only on outcomes.
- **reflect: Three-Condition Rule hoisted** — defined once before first reference.
- **reflect: sub-threshold → project memory** — recorded with pattern label + session_id so recurrence can graduate them.
- **reflect: Resolution Check 14-day guard** — requires both pattern absence from 3 sessions AND ≥14 days since `accepted_date`.
- **reflect: Skill Health → Component Health** — broadened to agents and hooks (hooks out-of-scope pending telemetry).
- **reflection-judge: `(current-session)` verdict variants** — explicit trigger for SHELL.md fallback when no archived report exists; callers can tell evidence isn't archived yet.
- **CLAUDE-APPEND.md quick reference** — added `/session-start`, `/reflect`, `/channel-setup`, `/hatch`, `/smoke-test`.

### Fixed

- **heartbeat: reflect no longer inline** — long reflect runs (30–40 min) occupied the REPL and delayed CronCreate routines 90+ min. Reflect is now routine-only (default `0 9 * * *`, seeded in `config.json.template` and `DEFAULT_CONFIG`). Heartbeat reverts to a pure health tick.

### Files affected

| File | Change |
|------|--------|
| `skills/reflect/SKILL.md` | Adaptive phase gates, cost-spike detection, operator-value self-check, mandatory Progress Log entry, Component Health broadened, Resolution Check 14-day guard |
| `agents/reflection-judge.md` | Current-session fallback path and `(current-session)` verdict variants |
| `scripts/update-reflection-state.js` | `preserve()` helper extracted; `last_digest_at` passthrough added |
| `skills/heartbeat/SKILL.md` | Reflection section removed from Idle Agency |
| `state-templates/config.json.template` | `reflect` routine added (`0 9 * * *`, enabled by default) |
| `scripts/hermit-start.py` | `reflect` routine added to `DEFAULT_CONFIG` |
| `state-templates/CLAUDE-APPEND.md` | Quick reference updated with 5 previously missing skills |

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Add reflect routine** — append `{"id": "reflect", "schedule": "0 9 * * *", "skill": "claude-code-hermit:reflect", "enabled": true}` to the `routines` array in `config.json` if no entry with `"id": "reflect"` exists.
2. **Register the new routine** — invoke `/claude-code-hermit:hermit-routines load` after updating `config.json`.
3. **Refresh CLAUDE-APPEND** — copy the updated `state-templates/CLAUDE-APPEND.md` into the project's `.claude/` injection point.

No other config changes required.

**Note:** Hermits <14 days old will start surfacing sub-threshold observations in SHELL.md Findings — `Noticed: <pattern>` in `newborn` phase, `Noticed (digest): ...` weekly in `juvenile`. Hermits ≥14 days old land in `adult` (identical to prior behavior). To opt out: set `"enabled": false` on the reflect routine.

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

- **docker: hermit plugin installed but not enabled** — entrypoint now runs idempotent `claude plugin enable` every boot so containers self-heal on restart.
- **docker-setup: stale REPL swallowed channel pairing** — sends `/reload-plugins` once before first pair command.
- **docker-compose: `stop_grace_period` raised to 60s** — 10s SIGKILL'd mid graceful session-close.
- **docker-setup: avoids `hermit-docker up` echo hints** — uses `docker compose up -d` directly during setup so the outer LLM doesn't follow the trailing "attach" suggestion.
- **docker-setup: recommended plugins mirror host install** — step 7b reads host project/local plugins instead of a canned list; entrypoint adds marketplace before install; safelist preselects `claude-plugins-official` + `gtapps/*` only, third-party requires explicit opt-in; `org/repo` regex validator rejects malformed values.
- **entrypoint: recommended-plugin re-install loop** — `install_target in installed` set-membership check never matched raw line output; switched to substring match.
- **hermit-docker login: double-OAuth race** — REPL's auth check + `/login` opened two URLs racing on `.credentials.json`. Now uses one-shot `claude auth login` gated by `claude auth status --json`.

### Added

- **docker-setup step 8b: clean restart** — `hermit-docker down` + `up -d` so first real session has plugins loaded and no setup chatter in transcript.
- **routine fire metrics** — `routine-watcher.sh` appends `queued`/`fired`/`dequeued` to `state/routine-metrics.jsonl`; reflect uses it to propose retiming idle routines.

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

- **docker-entrypoint: channel schema + silent marketplace failure** — channels read as list instead of object so `enabled: false` was ignored; `marketplace add` failures swallowed by `|| true`. Now filters disabled channels and surfaces marketplace errors explicitly.
- **docker-entrypoint: plugins installed but left disabled** — `claude plugin install` leaves plugins dormant; now calls `claude plugin enable` after each channel/recommended install.
- **`claude login` → `claude /login`** — correct CLI invocation; updated across `hermit-docker`, entrypoint, skills, and docs.
- **hermit-docker: `_require_running` preflight** — `attach`/`bash`/`login`/`restart` now check `$SERVICE` is up before `docker compose exec` and print a clear start-it-first message.
- **docker-setup step 8: readiness gates** — manual branch skips exec'd steps; "build now" polls `docker compose ps` 10s; workspace trust + channel pairing gate on `tmux has-session` to avoid "no server running" races.
- **docker-setup step 8: `access.json` verification** — channel pairing polls `.claude.local/channels/<plugin>/access.json` (~3s, retry ~8s) and shows `tmux capture-pane` on miss instead of declaring success.
- **docker-setup: broken doc link** — `recommended-plugins.md` path fixed to `../../docs/...`.

### Changed

- **hatch completion message** — "Go always-on" leads with `docker-setup`; `smoke-test` moved to troubleshooting note; `bypassPermissions` promoted to first permissions option.
- **migrate: scope confirmation gate (step 0)** — reads `config.json.scope` as authoritative, surfaces divergence with `.gitignore`, prompts to switch. Switching reconciles `config.json`, `.gitignore`, and `git rm --cached` for newly-ignored tracked paths behind one confirmation.

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

- **runtime.json: `waiting_reason` field** — records why session entered `waiting` (`unclean_shutdown`/`dead_process`/`conservative_pickup`/`operator_input`) so `channel-responder` routes `(1)`/`(2)` replies to archive-or-resume instead of treating them as task instructions.
- **session-mgr: `session_id` patched into SHELL.md on open** — header now correct from first tick instead of holding the placeholder until close.
- **session-mgr: `cost_usd` reads `.status.json` first** — hook-written cost was silently discarded when SHELL.md parse won; now status file takes precedence.
- **session-start fast-path: patches SHELL.md ID placeholder** — updates in-context without spawning session-mgr when runtime has the ID.
- **routine-watcher: drains stale queue entries on startup** — prunes entries >2h old to prevent phantom stale-routine alerts across restarts.
- **heartbeat: micro-proposal pending alert** — step 6 flags tier-1 entries in `micro-proposals.json` via `micro-proposal-pending:<id>` so they don't silently expire; stale queue message now includes elapsed time.

### Changed

- **proposal-act: accept no longer stamps `resolved_date`** — only sets `accepted_date`. `reflect` stamps `resolved_date` later once the pattern is absent from 3 sessions. Fixes `weekly-review.js` resolution count always being zero.
- **reflect: concrete Resolution Check procedure** — bounded round-robin (≤5/cycle) reads each accepted proposal's evidence, scans last 3 reports, marks resolved if absent. Position tracked in `reflection-state.json.last_resolution_check`.
- **reflection-judge: explicit `Sessions: none` gate** — step 0 short-circuits to `SUPPRESS` without evidence verification; reflect notes the suppression in SHELL.md Findings for revisit.
- **proposal-create: `source` + `category` in `created` events** — metrics now distinguish manual / auto-detected / operator-request and improvement / routine / capability / constraint / bug.
- **generate-summary.js: per-source acceptance + resolved count** — new `proposals_resolved` and `auto_detect_accept_rate` frontmatter fields answer "are autonomous proposals good?".
- **reflect + session-start: notification routing de-duplicated** — "Always-On Notification Rule" block replaced with one-liner deferring to CLAUDE-APPEND's Operator Notification section.
- **reflect: preserves micro-proposal `question` text in JSONL + active slot** — enables post-hoc analysis of what was asked vs operator response.
- **heartbeat: `noise_ticks` self-eval field** — counters increment when a dismissed-proposal-linked alert fires; at 20+ across 3+ sessions, proposes retuning or removing the check (mirrors `clean_ticks`).
- **docs/frontmatter-contract.md** — `resolved_date` writer updated to `reflect (pattern absence)`.

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
