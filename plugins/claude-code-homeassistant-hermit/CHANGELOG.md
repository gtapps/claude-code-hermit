# Changelog

All notable changes to `claude-code-homeassistant-hermit` / `ha-agent-lab` are documented here.

## [Unreleased]

### Added
- **`ha list-dashboards` / `ha get-dashboard [--url-path]`** — read Lovelace dashboards via WebSocket (`lovelace/dashboards/list`, `lovelace/config`). First slice of the dashboard build/maintain surface; writes (apply/create/delete) land in a follow-up once their WS payload shapes are live-verified.
- **`ha apply-dashboard` / `ha create-dashboard` / `ha delete-dashboard`** — gated dashboard writes via WebSocket (`lovelace/config/save`, `lovelace/dashboards/create|delete`). Payload shapes cross-checked against `home-assistant/core`'s generic storage-collection handler (same pattern as areas/helpers); gated by `ha_safety_mode` like every other structural mutation. Completes the Phase 1 dashboard build surface.
- **`ha render-template <file|->` / `ha check-config`** — render a Jinja2 template against live state (`POST /api/template`) and validate the HA config (`POST /api/config/core/check_config`). Not gated (read-only against HA's engines). First slice of Phase 2's dev/test/maintain loop primitives.
- **`ha call-service <domain.service> [--data json]`** — call any HA service (`POST /api/services/...`). A new `gateServiceCall` policy gate (in `policy.ts`) classifies the target `domain.service` and any `entity_id`/`device_id`/`target` references in `--data` via the existing per-entity policy: sensitive domains (lock/alarm) block as a proposal under strict and require `--confirm` under ask; non-sensitive calls (reloads, `notify.*`, `recorder.purge`) proceed in both modes, since gating every call would defeat call-service's maintenance purpose. Malformed or unresolvable targeting (wrong-shaped `target`, non-string `entity_id`, an `area_id`/`floor_id`/`label_id`/`device_id` selector) fails closed regardless of mode.
- **`ha set-core-config`** — partial update of HA's core config (`--latitude`, `--longitude`, `--elevation`, `--unit-system`, `--currency`, `--time-zone`, `--country`) via WebSocket (`config/core/update`, gated write, only the provided fields are sent). Completes Phase 2's dev/test/maintain loop primitives.
- **`ha error-log` / `ha logbook [--window-days N] [--entity <id>]` / `ha system-log`** — the maintenance/observability half: raw error log (`GET /api/error_log`, plain text — deployment-dependent, 404s if HA hasn't registered `DATA_LOGGING`), logbook entries (`GET /api/logbook/<ts>`, single-entity filter only per the upstream API), and structured system log with levels (WS `system_log/list`). All read-only, not gated. Completes Phase 3.
- **`ha list-floors` / `create-floor` / `delete-floor` and `ha list-labels` / `create-label` / `delete-label`** — WebSocket registry CRUD (`config/floor_registry/*`, `config/label_registry/*`), gated by `ha_safety_mode` like areas/helpers. First slice of Phase 4's organization primitives.
- **`ha rename-area` / `set-area-icon` / `set-area-floor` / `set-area-labels`** — a new generic `updateArea` (mirroring `updateEntity`/`updateDevice`) over `config/area_registry/update`, gated. `--labels` accepts multiple values (`--labels a b c`).
- **`ha set-entity-icon` / `set-entity-hidden` / `set-entity-labels` / `set-entity-categories` / `set-entity-aliases`** — extends the existing `updateEntity` (no new function, just new callers) over `config/entity_registry/update`'s remaining fields. `set-entity-hidden true|false` maps to `hidden_by` `"user"`/`null`, mirroring `set-entity-enabled`'s `disabled_by` convention; `set-entity-categories` takes a JSON scoped mapping (`--categories '{"automation":"config"}'`).
- **`ha list-exposed-entities` / `expose-entity`** — read and set HA's expose-to-Assist boundary (WS `homeassistant/expose_entity/list`, `homeassistant/expose_entity`), gated. Config, not control — directly supports the "runtime control defers to HA Assist" boundary from `SAFETY.md`. Completes Phase 4.
- **`ha list-backups` / `create-backup`** — list backups and generate a new one (WS `backup/info`, `backup/generate`), gated. `create-backup` exposes the full schema (`--agent-ids`, `--name`, `--password`, `--include-addons`, `--include-all-addons`, `--include-database`, `--include-folders`, `--include-homeassistant`). Completes Phase 5.
- **`ha list-scenes` / `get-scene-config` / `delete-scene`** — scene CRUD parity with the existing automation/script commands (`/api/states`, `/api/config/scene/config/{id}`). Reuses the already domain-generic `listDomain`/`readConfig`/`removeConfig` — `scene` was already in `CONFIG_DOMAINS` from earlier scene-apply work, so this is purely new dispatch surface. First slice of Phase 6.

### Changed
- **`HomeAssistantClient.postText()` / `getText()`** — new raw-response GET/POST variants; `/api/template` and `/api/error_log` return plain text, not JSON, which the existing `post()`/`get()`'s unconditional `JSON.parse` would reject as malformed.
- **`extractEntityIds`/`hasUnresolvableTarget`/`isWellFormedEntityId` relocated to `policy.ts`** — moved out of the MCP safety hook so `call-service` can reuse the same fail-closed entity-resolution logic. Hook behavior is unchanged (`tests/gate-corpus.test.ts`/`tests/gate-fuzz.test.ts` verify byte-identical output).
- **`check-config` reuses `apply.ts`'s `isConfigCheckOk`** instead of a narrower inline check.
- **`time-utils.daysAgo()`** — extracted shared "N days before now" arithmetic, reused by `logbook`'s window-start computation.

## [0.3.1] - 2026-06-29

### Changed
- **ha-pattern-analyst: removed `maxTurns` cap** — workload grows with accumulated entity inventory and historical snapshots; a fixed cap silently truncates analysis on mature deployments.

## [0.3.0] - 2026-06-26

### Added
- **`ha trigger-automation <automation_id>`** — fires an automation on demand via `automation.trigger`; provides the fire-to-test step in the build → simulate → apply → fire → observe → restore loop. No policy gate (triggering an automation you've already applied is not a sensitive actuation path).
- **`ha_assist_control_enabled` config flag** — opt-in that passes HA Assist intent tools (`HassTurnOn`, `HassLightSet`, `HassSetPosition`, `HassFanSetSpeed`, etc.) through the MCP safety gate; HA's own expose-to-Assist setting becomes the control boundary. Disabled by default (fail-closed). Set via hatch Step 7.55 or write `ha_assist_control_enabled: true` to `.claude-code-hermit/config.json`.
- **ha-build-automation: helper provisioning step** — step 3 scans drafted YAML for missing `input_*/timer/counter/schedule` entities and creates them via `ha create-helper` before validation. Gate-respecting: strict → proposal, ask → operator prompt then `--confirm`. Runs `ha refresh-context --incremental` after creation so simulate sees the new helpers. (#471)
- **`/ha-setup-house` skill** — guided house build-out: create areas, assign entities and devices, provision helpers, scaffold starter automations. Thin orchestration of existing `ha-agent-lab` commands; all structural writes gated by `ha_safety_mode`.
- **`ha automation-diff`** — change memory across sessions: reports automations added/removed/edited/enabled/disabled since the last snapshot, including UI edits that bypass the plugin. Read-only; complements `ha-safety-audit` (policy drift vs. change drift). (#472)
- **`ha snapshot-states` / `ha restore-states`** — capture an entity set's state to a named artifact and restore it via `scene.apply`. Restore gated by `ha_safety_mode`: sensitive entities block under strict and require `--confirm` under ask. (#472)
- **`ha-automation-diff`, `ha-snapshot-restore` skills** — thin skill wrappers over the new CLI subcommands.
- **CLI: `scene` config domain** — `validate-apply --reload scene`, plus scene create/remove via `/api/config/scene/config/{id}` + `scene.reload`. (#466)
- **WebSocket client (`src/ha-ws.ts`)** — single-shot `wss://<host>/api/websocket` client; auth handshake + id-correlated commands. Reaches HA surfaces REST cannot. (#466)
- **CLI: helpers, areas, registries** — `list/create/delete-helper` (8 helper types), `list/create/delete-area`, `list-entities --registry`, `rename-entity`, `set-entity-area`, `set-entity-enabled`, `list-devices`, `set-device-area`, `rename-device`. (#466)
- **Safety: WS mutations gated by `ha_safety_mode`** — reads always allowed; under `strict` writes surface as proposal, under `ask` require `--confirm`. Each mutation writes an `audit-ha-ws-*` report. (#466)

### Changed
- **mcp-safety-gate: `Hass*` intent tools conditionally allowed** — when `ha_assist_control_enabled: true` is set, `Hass*` tools are passed through; HA's expose-to-Assist gate is the control boundary. Default (opt-in absent) is unchanged: hard-block.
- **CLI REST control surface removed** — `ha actuate`, `ha actuate-area`, `ha resolve-entity`, `ha-command-router`, `src/actuate.ts`, and `src/resolve.ts` deleted; these were unreleased and never reached operators via `/plugin update`. Runtime device control now routes through HA Assist intent tools.
- **mcp-safety-gate: confirmation-token bridge removed** — `consumeConfirmationToken`, `canonicalJson`, and `TOKEN_TTL_MS` deleted; the ask-tier path now emits `permissionDecision:"ask"` JSON directly.
- **policy: keyword heuristic removed** — `CONDITIONALLY_SENSITIVE_DOMAINS`, `SENSITIVE_KEYWORDS`, and `HA_EXTRA_SENSITIVE_KEYWORDS` removed; `classifyEntity` now uses domain-only matching. Cover/button/switch entities are no longer flagged by keyword.
- **hatch: domain auto-resume** — writes a state marker before delegating to core; core terminus invokes this skill via the Skill tool automatically. Removes the manual re-run. Requires `claude-code-hermit` ≥1.2.12.

### Fixed
- **safety-gate: cover script-derived MCP tools** — widened the PreToolUse matcher from `mcp__homeassistant__Hass.*` to `mcp__homeassistant__.*` so exposed HA scripts (which surface as MCP tools with no `Hass` prefix) reach the gate instead of actuating ungated (#469). Read-only `GetLiveContext`/`GetDateTime` are allowlisted in-gate; bare-named script tools with no classifiable target block under `strict` and prompt under `ask`.

### Security
- **mcp-safety-gate: widened to the whole `mcp__homeassistant__.*` namespace** — the matcher previously covered only `Hass*`, so script-derived actuation tools (e.g. `armar_alarme`) bypassed the gate entirely. Read-only tools are allow-listed by explicit name; every other non-entity tool fails closed. Intent tools (`HassTurnOn` etc.) now fail-close by design — they cannot carry `entity_id`. (G4)

### Files affected

| File | Change |
|------|--------|
| `hooks/hooks.json` | Matcher widened to `mcp__homeassistant__.*` |
| `hooks/mcp-safety-gate.ts` | Namespace widening, assist opt-in, token bridge removed |
| `src/policy.ts` | Keyword heuristic removed; domain-only classification |
| `src/ha-ws.ts` | New: WebSocket client |
| `src/structure.ts` | New: helpers/areas/registry WS commands |
| `src/automation-diff.ts` | New: automation change-diff logic |
| `src/snapshot-restore.ts` | New: entity state capture and scene.apply restore |
| `src/cli.ts` | New subcommands: trigger-automation, automation-diff, snapshot-states, restore-states, scene, helpers, areas, registries |
| `src/artifacts.ts` | Snapshot/diff artifact support |
| `src/ha-api.ts` | Scene REST path |
| `src/apply.ts` | Scene apply support |
| `skills/ha-automation-diff/SKILL.md` | New skill |
| `skills/ha-snapshot-restore/SKILL.md` | New skill |
| `skills/ha-setup-house/SKILL.md` | New skill |
| `skills/ha-build-automation/SKILL.md` | Helper provisioning step |
| `skills/hatch/SKILL.md` | Domain auto-resume; assist opt-in step 7.55 |
| `state-templates/CLAUDE-APPEND.md` | Added new skills to quick-reference table |

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Restore keyword-sensitive entity blocking if you relied on it.** Check whether you set `HA_EXTRA_SENSITIVE_KEYWORDS` in `.claude-code-hermit/.env`. If so, identify the domains those keywords targeted (e.g. `cover`, `switch`, `button`) and add them to `HA_EXTRA_SENSITIVE_DOMAINS` in `.env` instead (`HA_EXTRA_SENSITIVE_DOMAINS=cover,switch`). Remove the now-inert `HA_EXTRA_SENSITIVE_KEYWORDS` line.

**Note:** `ha_assist_control_enabled` defaults to `false`; HA Assist intent tools remain blocked unless you explicitly opt in via hatch Step 7.55 or by writing `ha_assist_control_enabled: true` to `.claude-code-hermit/config.json`.

No other `config.json` changes required.

## [0.2.2] - 2026-06-23

### Fixed

- **hatch: domain resume after core hatch** — Step 1 now prints the re-run instruction before invoking core as the terminal action, so the operator sees it. Removes the "then continue" assumption that silently dropped Step 2.

### Files affected

| File | Change |
|------|--------|
| `skills/hatch/SKILL.md` | Domain resume: print instruction before core hatch, then stop instead of continuing |

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Refresh the HA hermit plugin** — `/claude-code-hermit:hermit-evolve` pulls the updated skill.

No `config.json` changes required.

## [0.2.1] - 2026-06-13

### Fixed

- **mcp-safety-gate: operator-defined sensitivity restored under drifted cwd** — `projectRoot()` added to `src/config.ts` resolves the project root via `CLAUDE_PROJECT_DIR`+`existsSync` → cwd walk-up → fail-open, so `HA_EXTRA_SENSITIVE_*` overrides in `.env` are found even when hook cwd has drifted inside `.claude-code-hermit/`. Before this fix the gate failed open for those operator-configured domains. Fixes #384.

### Files affected

| File | Change |
|------|--------|
| `src/config.ts` | Adds `projectRoot()` — resolves project root surviving cwd drift |
| `hooks/mcp-safety-gate.ts` | Threads `projectRoot()` through `classifyEntity` call |
| `src/cli.ts` | Threads `projectRoot()` through `loadConfig` call |
| `tests/config.test.ts` | Tests for `projectRoot()` under drift and normal conditions |

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Update the plugin** — run `claude plugin update claude-code-homeassistant-hermit` to get the fixed hook.

No `config.json` changes required.

## [0.2.0] - 2026-06-12

### Fixed

- **CRITICAL — mcp-safety-gate was fail-open on all standard installs** — the Python hook's import never resolved without `pip install -e` (PYTHONPATH was never set by hooks.json), so the gate crashed with exit 1 on every call; Claude Code treats non-2 exits as non-blocking, so lock/alarm MCP calls were ALLOWED for the hook's entire shipped life. The TypeScript port fixes this and additionally fails closed on non-object JSON payloads.
- **mcp-safety-gate: three more bypass holes closed** — mixed safe/selector calls now blocked (selectors fan out server-side); sensitive-domain matching is case-insensitive; malformed empty-domain ids rejected. All pinned in the 80-case golden corpus.
- **apply/ha-api: write-path error handling** — defensive body reads so 403/400 handling survives mid-stream failures; verify-GET errors reported as unverified rather than rethrowing after POST landed.

### Changed

- **full TypeScript port; plugin is Python-free (bun migration, core #18)** — `src/ha_agent_lab/` Python package, `pyproject.toml`, `.venv`/pip hatch wizard, and both Python hooks deleted; `bin/ha-agent-lab` execs `bun src/cli.ts`, both gates run as `.ts` on bun. CLI argv, stdout shapes, and exit codes verified byte-identical to CPython via an 80-case golden corpus. 478 bun tests replace the pytest suite.
- **required_core_version: bumped to >=1.2.0** — tracks core 1.2.0 release.

### Files affected

| File | Change |
|------|--------|
| `hooks/mcp-safety-gate.ts` | TypeScript rewrite; fail-closed, import-safe, 3 bypass holes fixed |
| `hooks/curl-host-gate.ts` | TypeScript rewrite replacing curl-host-gate.py |
| `hooks/mcp-safety-gate.py` | Deleted |
| `hooks/curl-host-gate.py` | Deleted |
| `bin/ha-agent-lab` | Swapped Python invocation for `bun src/cli.ts` |
| `src/cli.ts` | TypeScript CLI replacing `src/ha_agent_lab/cli.py` |
| `src/policy.ts` | Policy engine replacing `src/ha_agent_lab/policy.py` |
| `src/yaml.ts` | PyYAML-parity YAML wrapper |
| `src/ha-api.ts` | urllib → fetch, defensive body reads |
| `src/apply.ts` | Verify-GET error handling fixed |
| `src/ha_agent_lab/` | Entire Python package deleted |
| `pyproject.toml` | Deleted |
| `.claude-plugin/hermit-meta.json` | `required_core_version` and `requires` bumped to `>=1.2.0` |
| `.claude-plugin/plugin.json` | dependencies bumped to `^1.2.0`; description updated |

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Verify core version** — confirm installed `claude-code-hermit` is >=1.2.0. If not, run `claude plugin update claude-code-hermit` first.
2. **Delete the Python venv** — remove `.venv/` from the HA hermit project directory if it exists; Python is no longer required.

No `config.json` changes required.

## [0.1.9] - 2026-06-04

### Changed

- **deps: core requirement raised to >=1.1.9** — tracks core 1.1.9 release.

### Fixed

- **ha-integration-health: refresh stale/missing snapshot before analysis** — the daily check used to skip and exit 0 when `snapshot-ha-normalized-latest.json` was stale or missing, so in always-on deployments (where `daily-ha-context` doesn't run during waiting) it never produced output and `reflect-scheduled-checks` filed a backwards proposal to lengthen the interval. It now self-heals by running `refresh-context` first; if HA is unreachable it skips with a distinct `refresh failed` message so the backoff counter isn't tripped.

### Files affected

| File | Change |
|------|--------|
| `.claude-plugin/hermit-meta.json` | `required_core_version` and `requires` bumped to `>=1.1.9` |
| `.claude-plugin/plugin.json` | `dependencies.claude-code-hermit` bumped to `^1.1.9` |
| `skills/ha-integration-health/SKILL.md` | Self-heal stale/missing context snapshot before analysis |
| `src/ha_agent_lab/cli.py` | Refresh context before integration-health check |

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`.

1. **Ensure core is at least 1.1.9.** Run `/plugin update claude-code-hermit` if not already on 1.1.9 or later.

No `config.json` changes required.

## [0.1.8] - 2026-06-01

### Added

- **domain-brainstorm: new operator-invoked skill** — reads entity inventory, automation/script listings, and operator intent to surface at most 2 capability-gap proposals (`[automation-gap]` / `[coverage-asymmetry]` / `[unbuilt-intent]`), each gated by `proposal-triage`. Health/reliability findings act as suppression filters only, never idea sources. Never runs autonomously.

### Fixed

- **hatch: knowledge-schema.md now seeded with HA artifact types** — weekly-review Knowledge Health no longer flags HA `.md` artifacts as `undeclared-type`. Covers `brief`, `context`, `presence-report` (Work Products) and `audit`, `simulation`, `apply`, `remove`, `analysis` (Raw Captures).
- **ha-refresh-context: foundational pinning spec** — `foundational: true` frontmatter was never detected by `startup-context.js` (which checks `tags`); updated spec to `tags: [..., foundational]` with `injection_stub` for large-profile injection.
- **README: install scope** — `--scope project` corrected to `--scope local` in install and upgrade commands.

### Files affected

| File | Change |
|------|--------|
| `skills/domain-brainstorm/SKILL.md` | New skill: capability-gap brainstorm, proposal-triage gated |
| `state-templates/CLAUDE-APPEND.md` | Add domain-brainstorm to quick-reference table |
| `skills/hatch/SKILL.md` | New Step 7.6: idempotent knowledge-schema extension; final-report line |
| `tests/test_hatch_skill.py` | Structural tests for Step 7.6 |
| `skills/ha-refresh-context/SKILL.md` | Fix House Profile frontmatter: `tags` array + `injection_stub` |
| `docs/knowledge-schema.md` | Update foundational-pinning guidance to match core contract |
| `README.md` | `--scope project` → `--scope local` in install/upgrade snippets |

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill executes the following step automatically (via Step 7's sibling upgrade flow).

1. **Extend knowledge-schema.md with HA types.** Read `.claude-code-hermit/knowledge-schema.md`. Check if either `- analysis:` or `- **analysis**:` is present — if so, skip (already up to date). If absent, append the following under `## Work Products`:

   ```
   - brief: morning/evening house brief. location: compiled/brief-<morning|evening>-<date>.md
   - context: foundational house/system profile. location: compiled/context-house-profile-<date>.md
   - presence-report: presence history and tracker diagnostics. location: compiled/presence-report-<date>.md
   ```

   And under `## Raw Captures`:

   ```
   - audit: HA operational audit (safety, integration-health, context-refresh). location: raw/audit-ha-<type>-<date>.md
   - simulation: HA automation simulation result. location: raw/audit-ha-simulation-<slug>-<date>.md
   - apply: HA automation apply result. location: raw/audit-ha-apply-<slug>-<date>.md
   - remove: HA automation/script delete audit. location: raw/audit-ha-remove-<slug>-<date>.md
   - analysis: HA pattern analysis. location: raw/patterns-<date>.md
   ```

   Use Edit to append.

2. **Sync the CLAUDE-APPEND block** — re-writes the HA section with the updated skills table including `domain-brainstorm`.

No `config.json` changes required.

**Note:** Existing house profiles written with `foundational: true` will not be auto-pinned until re-generated via `/claude-code-homeassistant-hermit:ha-refresh-context`.

---

## [0.1.7] - 2026-05-31

### Added

- **ha-presence-report: new on-demand skill** — presence history, tracker-health, arrival/departure transitions, and activity patterns for `person.*` / `device_tracker.*` entities. Gives operators a direct diagnostic path when presence-dependent automations misbehave.

### Changed

- **fetch-history `--entities`: glob expansion** — tokens containing `*` are now expanded against `entity_index` via `fnmatch`; exact IDs still pass through. Fixes the documented `--entities <glob> …` contract, which previously passed patterns verbatim to HA's REST API and returned empty data.
- **fetch-history `--include-transitions`** — new flag; each entity aggregate in the snapshot includes a `transitions` list of ordered `{ts, state}` dicts with consecutive duplicates collapsed. Default off; existing callers unaffected.
- **ha-automation-explorer: browse and explain active automations** — read-only skill with three modes: list all automations grouped by inferred topic (Mode 1), explain a keyword-filtered automation's YAML in plain language (Mode 2), sort by last-fired using snapshot data (Mode 3). Dead/stale detection reuses `silence_summary` from the context snapshot.
- **ha-evening-brief: new skill and routine** — end-of-day security check (locks, alarm, open covers), device status (robovac, lights), and energy snapshot at 22:30; subsumes core `evening` routine when both plugins are installed.

### Files affected

| File | Change |
|------|--------|
| `skills/ha-presence-report/SKILL.md` | New skill: presence history and tracker diagnostics |
| `skills/ha-automation-explorer/SKILL.md` | New skill: browse and explain automations by topic, keyword, or last-fired |
| `skills/ha-evening-brief/SKILL.md` | New skill: end-of-day security and device status brief |
| `src/ha_agent_lab/history.py` | Glob expansion for `--entities`; `--include-transitions` flag |
| `tests/test_cli_fetch_history.py` | Tests for new fetch-history flags |
| `tests/test_history.py` | Unit tests for glob expansion and transitions logic |
| `tests/test_automation_explorer_skill.py` | Skill validation tests |
| `state-templates/CLAUDE-APPEND.md` | Add new skills to quick reference table; update fetch-history CLI line |

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Sync the CLAUDE-APPEND block** — re-writes the HA section in your target CLAUDE file with the updated skills table and CLI reference.

No `config.json` changes required.

## [0.1.6] - 2026-05-21

### Fixed

- **hatch/hermit-evolve: duplicate HA block after core 1.1.1 target migration** — block stranded in old file; Upgrade Instructions run a one-shot migration via `hermit-evolve` Step 7 to remove it.

### Changed

- **hatch: Step 7 is now target-aware** — writes CLAUDE-APPEND block to `CLAUDE.local.md` or `CLAUDE.md` based on `hatch-options.json`; stamps canonical 5-field schema; three-branch marker logic (absent/match/stale).
- **hatch: Upgrade Instructions Step 3 is fully unattended** — dropped hand-edit detection; stamped-version source pinned to `config.json`; absent-stamp case folded into stale branch. Tests added via `tests/test_hatch_skill.py`.

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill executes the following steps automatically (via Step 7's sibling upgrade flow, which runs every plugin's `### Upgrade Instructions` before its CLAUDE-APPEND sync). The migration is unattended — no operator prompts. `hermit-evolve` Step 7 re-syncs the canonical block to `hatch_target` afterwards.

1. **Resolve `hatch_target`.** Use the same fallback chain `hermit-evolve` Step 2a uses, substituting the HA marker: read `.claude-code-hermit/state/hatch-options.json` and use the `"target"` field; else check `CLAUDE.local.md` for `<!-- claude-code-homeassistant-hermit: Home Assistant Workflow -->` → `hatch_target = "local"`; else check `CLAUDE.md` for the same marker → `hatch_target = "committed"`; else stop — the HA block is in neither file, nothing to migrate.

2. **Identify the non-target file.** `non_target = (hatch_target == "local") ? "CLAUDE.md" : "CLAUDE.local.md"`.

3. **If the marker is present in `non_target`, silently strip the marked block** (everything from the opening `<!-- claude-code-homeassistant-hermit: Home Assistant Workflow -->` through the matching closing `<!-- /claude-code-homeassistant-hermit: Home Assistant Workflow -->`, inclusive). Per `/hatch`'s single-source-of-truth contract, the CLAUDE-APPEND template is authoritative and operator overrides belong outside the marked block, so no hand-edit preservation is needed. Step 7's sync re-appends the canonical block to `hatch_target` afterwards.

4. **If the marker is only in `hatch_target`:** no-op. Steady state — Step 7's normal sync handles routine version-bump replacement.

No `config.json` changes required.

## [0.1.5] - 2026-05-21

### Changed

- **deps: bump core requirement to `>=1.1.1` / `^1.1.1`** — was `>=1.0.40`; aligns with core v1.1.1 release.

### Fixed

- **ha fetch-history: fix Cloudflare HTTP 520 on large entity sets** (gh #107) — chunks entity IDs at 50 to keep `filter_entity_id` short enough for Nabu Casa proxy; dedupes IDs before chunking.

### Files affected

| File | Change |
|------|--------|
| `src/ha_agent_lab/ha_api.py` | Add `_HISTORY_CHUNK_SIZE = 50`; split `get_history()` into chunk loop + `_fetch_history_chunk()`; dedupe entity IDs with `dict.fromkeys()` |
| `tests/test_ha_api.py` | Add tests for chunked path and dedup behaviour |
| `.claude-plugin/hermit-meta.json` | Bump `required_core_version` and `requires` to `>=1.1.1` |
| `.claude-plugin/plugin.json` | Bump `claude-code-hermit` dependency to `^1.1.1` |

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Update core** — run `/plugin update` and confirm `claude-code-hermit` is at v1.1.1 or later before this plugin's features are used.

No `config.json` changes required.

## [0.1.4] - 2026-05-16

### Added

- **ha get-automation-config / get-script-config: new CLI commands** — fetch a single automation or script config from HA REST and print as JSON; exits 1 with structured error on 400/403.

### Changed

- **ha-morning-brief: subsumes core `brief --morning`** — eliminates duplicate-notification UX issue (#78); adds micro-proposals lifecycle and `Awaiting decision:` section; routine id fixed (`morning` → `morning-brief`).
- **hatch: morning-brief routine offers unified mode** — fresh installs choose unified (08:30, disables core `morning`) or legacy (09:00, disabled); re-hatch detects old schedule and offers upgrade.
- **ha-morning-brief: skill output translated to English** — section headers and examples changed from Portuguese; runtime language still adapts to operator locale.
- **deps: bump core requirement to `>=1.0.40` / `^1.0.40`** — was `>=1.0.38`; aligns with core v1.0.40 release.

### Fixed

- **state-templates/CLAUDE-APPEND.md: backfill previously shipped CLI commands** — `list-automations`, `list-scripts`, `delete-*`, `integration-health`, `fetch-history`, `probe`, and the two new `get-*-config` commands were missing from the hatch-injected template.

### Upgrade Instructions

1. In `.claude-code-hermit/config.json`, locate `routines[id=morning-brief]`. If `enabled: true` and `schedule: "0 9 * * *"`: rewrite to `schedule: "30 8 * * *"` and `run_during_waiting: true`.
2. In the same array, locate `routines[id=morning]` (core). If both it and the updated `morning-brief` are enabled: set `morning.enabled = false`.
3. Report the changes to the operator; do not prompt — these are deterministic.

No `config.json` schema changes beyond the routine values above.

## [0.1.3] - 2026-05-14

### Added

- **ha integration-health: new CLI command and `integration_health.py` module** — promotes skill from arithmetic pass to Python-backed command; writes `state/integration-health-degraded-domains.json` for `silence.py` cross-reference; thresholds centralized in `compute_degraded_domains()`.
- **silence_summary block in normalized snapshot** — new `silence.py` module adds four finding categories (`dead_automations`, `silent_event_sensors`, `inactive_candidates_by_domain`, `long_unavailable`) to every `refresh-context` run; suppresses domains already flagged by integration-health.
- **ha-analyze-patterns: surfaces silence findings** — step 4 maps `silence_summary` categories to stdout buckets; `ha-pattern-analyst` Data Sources and output schema updated; `docs/knowledge-schema.md` updated.
- **HomeAssistantClient.get_history(): new REST client method** — fetches `/api/history/period`; rejects empty entity_ids; maps by `entity_id` for reorder resilience; absent entities omitted from result dict.
- **ha fetch-history: new CLI command and `history.py` aggregator** — produces per-entity `event_count`, `hour_histogram`, `state_durations`; synthesizes zero-count rows for absent entities; writes `raw/snapshot-ha-history-{N}d-<date>.json` and `latest` alias.
- **ha-analyze-patterns / ha-morning-brief: history wiring** — analyze-patterns fetches 7d history as step 3; morning-brief fetches 1d and renders an overnight section; fetch failures log silently.

### Changed

- **time_utils: extract shared `parse_iso` / `days_since` helpers** — deduplicates the private helpers from `silence.py` and `history.py` into a shared module.
- **silence._classify_automation: gate `never_fired` on `last_changed` age** — avoids false positive on freshly-added automations; only fires once `last_changed` is ≥30d old.
- **silence._sort: explicit None-aware sort key** — replaces falsy-chain fallback with `is None` checks to prevent silent wrong-key fallthrough.
- **ha fetch-history: document refresh fallback in `--help`** — triggers `refresh-context` when no normalized snapshot exists; drops lazy import in favor of top-level `cli.py` import.

### Removed

- **`stuck_for_days` field from `entity_aggregates` rows** — the field was always `None` for both synthesized and returned entries and had no consumer. Removed from the schema to avoid downstream code relying on a value that never materialized.

### Files affected

| File | Change |
|------|--------|
| `src/ha_agent_lab/integration_health.py` | New module: `compute_degraded_domains()`, `run_integration_health()`, stdout formatter |
| `src/ha_agent_lab/silence.py` | New module: `compute_silence_summary()` and four finding-category classifiers |
| `src/ha_agent_lab/history.py` | New module: `aggregate_history()`, `detect_time_patterns()`, `fetch_history_snapshot()` |
| `src/ha_agent_lab/time_utils.py` | New module: shared `parse_iso()` and `days_since()` helpers |
| `src/ha_agent_lab/ha_api.py` | Add `get_history()` method to REST client |
| `src/ha_agent_lab/cli.py` | Add `integration-health` and `fetch-history` subcommands; top-level history import |
| `skills/ha-integration-health/SKILL.md` | Replaced arithmetic steps with single CLI delegate |
| `skills/ha-analyze-patterns/SKILL.md` | Step 3 fetches 7d history; step 4 maps silence findings to stdout buckets |
| `skills/ha-morning-brief/SKILL.md` | Fetches 1d history; adds `Durante a noite:` section |
| `agents/ha-pattern-analyst.md` | Data Sources updated: `silence_summary` and history snapshot |
| `docs/knowledge-schema.md` | Documents `silence_summary` block and two new history artifact rows |

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Run `ha refresh-context`** — regenerates the normalized snapshot with the new `silence_summary` block. Required for `ha-analyze-patterns` and `ha-integration-health` to read silence data.
2. **Run `ha integration-health`** — seeds the `integration-health-degraded-domains.json` state file consumed by `silence.py`. Required before the first `ha-analyze-patterns` run that cross-references degraded domains.

No `config.json` changes required.

## [0.1.2] - 2026-05-12

### Fixed

- **SimulationResult.is_valid: ASK-severity reasons no longer block apply** — regression from v0.1.1 `ask` tier; adds `policy_blocked` field (True only for BLOCK); threads `root` into `evaluate_references`. **Remove `alarm_control_panel.*` from `HA_SAFE_ENTITIES` if added as workaround.**
- **ha policy-check: honor project `ha_safety_mode`** — `evaluate_yaml_policy` was missing `root`, silently falling back to `Path.cwd()` and defaulting to `strict` from subdirectories.

### Changed

- **hooks: converted `mcp-safety-gate` and `curl-host-gate` to exec form** — aligns with core's exec-form sweep; fixes path-with-spaces fragility on installs whose plugin dir contains a space.
- **deps: bump core requirement to `>=1.0.38` / `^1.0.38`** — was `>=1.0.37`; aligns with core v1.0.38 release.

### Files affected

| File | Change |
|------|--------|
| `src/ha_agent_lab/simulate.py` | Add `policy_blocked` field to `SimulationResult`; `is_valid` gates on it instead of `blocked_reasons`; thread `root` into `evaluate_references` |
| `src/ha_agent_lab/cli.py` | Thread `root` into `_handle_policy_check` and `evaluate_yaml_policy` |
| `hooks/hooks.json` | Convert both hooks to exec form (`command` + `args` array) |
| `.claude-plugin/hermit-meta.json` | Bump `required_core_version` and `requires` to `>=1.0.38` |
| `.claude-plugin/plugin.json` | Bump `dependencies` to `^1.0.38` |

### Upgrade Instructions

1. **Update Claude Code to 2.1.139 or newer** — the exec-form hook syntax (`args: []`) was introduced in this version; hooks will fail to register on older clients.
2. **Run `/claude-code-hermit:hermit-evolve`** — pulls the plugin update and applies the new hook configuration.

No `config.json` changes required.

## [0.1.1] - 2026-05-11

### Added

- **ha audit-scripts: new CLI command** — mirrors `audit-automations` for `script.*`; writes artifacts to `raw/audit-ha-script-safety-*`; `ha-safety-audit` skill updated to concatenate both.
- **audit: acknowledgement scaffold** — `_load_acknowledged` reads ids from `compiled/acknowledged-violations.md` frontmatter; matched violations route to `acknowledged` bucket instead of `violations`; `hatch` copies the template.
- **state-templates/compiled/acknowledged-violations.md** — new per-project suppression list template copied by `hatch`.
- **ha_safety_mode: two-tier dial for sensitive-domain actuation** — `strict` (default): always block via proposal; `ask`: prompt operator before actuation (both YAML apply and MCP); unknown values fall back to `strict`. Set via hatch §7.5 or `config.json`.
- **policy.py: Severity enum** (`block`/`ask`/`allow`) — replaces `bool` return from `classify_entity()`; `is_sensitive_entity()` kept as backward-compatible shim; `PolicyDecision` gains `severity` field.
- **ha policy-check: add `severity` field to JSON output** — callers can distinguish `block`, `ask`, and `allow` without re-implementing policy logic.

### Changed

- **agents: migrate MEMORY.md references to platform auto memory** — house profile, patterns, and suppression signals now live in `~/.claude/projects/<key>/memory/`; agent body instructions updated to match existing `memory: project` frontmatter.
- **locale: move from auto memory to OPERATOR.md** — locale is operator config, not Claude-derived knowledge; `boot status` reports language again; `boot store --language` writes to `OPERATOR.md` `## HA hermit` section.
- **deps: bump core requirement to `>=1.0.37` / `^1.0.37`** — was `>=1.0.32`; aligns with core v1.0.37 release.

### Design notes

- The dial is deliberately two-tier. A third `permissive` level (no block, no prompt) was considered and rejected — sensitive-domain actuation has no software undo, and a set-and-forget "owner takes the risk" mode is a footgun across long-running sessions. Both surviving tiers route through explicit operator approval.
- The hook switched from a leaky `exit 0 + stderr warning` convention to harness-enforced `permissionDecision: "ask"` so YAML apply and direct MCP calls have the same enforcement model.

### Files affected

| File | Change |
|------|--------|
| `src/ha_agent_lab/policy.py` | Added `Severity` enum (`block`/`ask`/`allow`), `safety_mode()`, `_load_safety_mode()`; updated `classify_entity()`, `evaluate_references()`, `check_entity()` |
| `hooks/mcp-safety-gate.py` | Branches on severity: BLOCK → exit 2, ASK → JSON output with `permissionDecision: "ask"`, ALLOW → exit 0 |
| `src/ha_agent_lab/cli.py` | `policy-check` output includes `severity` field |
| `skills/hatch/SKILL.md` | Added §7.5 Safety mode question (strict / ask) |
| `skills/ha-apply-change/SKILL.md` | Step 1 branches on `severity` field from policy-check |
| `skills/ha-build-automation/SKILL.md` | Step 4 and Safety section updated for mode-awareness |
| `agents/ha-automation-builder.md` | Safety section updated: mode-conditional drafting |
| `agents/ha-safety-reviewer.md` | Safety carve-out updated: mode drives finding severity |
| `SAFETY.md` | Added "Safety Mode" section documenting the dial |
| `CLAUDE.md` | Core rule updated to reference `ha_safety_mode` |
| `state-templates/CLAUDE-APPEND.md` | Core rule updated |
| `tests/test_policy.py` | New mode-related tests, including a regression test asserting `permissive` falls back to `strict` |
| `tests/test_safety_hook.py` | New hook tests asserting `permissionDecision: "ask"` JSON output under ask mode |
| `tests/test_config.py` | Updated 3 tests to use `Severity` enum return type |
| `tests/conftest.py` | New `make_ha_config` factory fixture |
| `.claude-plugin/hermit-meta.json` | `required_core_version` and `requires.claude-code-hermit` bumped `>=1.0.32` → `>=1.0.37` |
| `.claude-plugin/plugin.json` | `dependencies[0].version` bumped `^1.0.32` → `^1.0.37` |

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. After updating the plugin:

1. If `ha_safety_mode` is absent from `.claude-code-hermit/config.json`, merge it in with the default value: `"ha_safety_mode": "strict"`. No behaviour change.
2. Optional: re-run `/claude-code-homeassistant-hermit:hatch` to step through the new §7.5 question interactively.

## [0.1.0] - 2026-05-07

### Changed

- **ha-safety-reviewer: add Memory Cross-Check** — consults auto-memory before verdict; returns `covered-by-memory` approval if memory records an operator decision; sensitive-domain blocks immune to memory override.
- **ha-pattern-analyst: add Memory Cross-Reference** — covered candidates move to `suppressed[]` array with `{code, reason, quoted_line, memory_ref}`; mirrors `covered-by-memory` code from core v1.0.32.
- **deps: bump core requirement to `>=1.0.32` / `^1.0.32`** — `covered-by-memory` code introduced in core v1.0.32.

### Files affected

| File | Change |
|------|--------|
| `agents/ha-safety-reviewer.md` | Added `## Memory Cross-Check` with `covered-by-memory` suppression and sensitive-domain carve-out |
| `agents/ha-pattern-analyst.md` | Added `## Memory Cross-Reference`; added `suppressed[]` to JSON output schema |
| `.claude-plugin/hermit-meta.json` | Bumped `required_core_version` and `requires.claude-code-hermit` to `>=1.0.32` |
| `.claude-plugin/plugin.json` | Bumped `dependencies.claude-code-hermit` to `^1.0.32` |

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Update the plugin** — install `claude-code-homeassistant-hermit` v0.1.0 to activate the memory cross-reference in both subagents.

No `config.json` changes required.

## [0.0.9] - 2026-05-05

### Added

- **ha validate-apply: push config to HA via REST before reload** — fixes silent failure (PROP-005) where reload succeeded but automation was never pushed; derives `id` from alias/filename if absent.
- **ha delete-automation / delete-script: new CLI commands** — remove automation or script via `DELETE /api/config/{domain}/config/{id}`; output includes `ok`, `message`, report path.
- **ha list-automations / list-scripts: new CLI commands** — enumerate live automations/scripts with `deletable` flag; sorted by entity_id; quick lookup before delete.
- **ha-delete-config: new skill** — operator workflow for discovering, confirming, and deleting an automation/script config.
- **ha_api: surface HA error messages verbatim** — extracts `{"message":"..."}` from all HA error responses into apply/remove reports.

### Changed

- **validate-apply: new output fields** — `config_id`, `creation_attempted`, `creation_ok` distinguish a pushed-and-verified config from a reload-only YAML-mode fallback.
- **ApplyResult: extended with `config_id`, `domain`, `creation_attempted`, `creation_ok`.**
- **deps: bump core requirement to `>=1.0.30` / `^1.0.30`** — was `>=1.0.29`.

### Fixed

- **validate-apply: no longer silently succeeds when config was never pushed** — reports `creation_ok: false` in YAML-mode fallback instead of returning success after reload-only.
- **ha-delete-config: remove erroneous `validate-apply` post-delete advice** — step 5 now points to HA Developer Tools → Services.
- **ha-build-automation: require `id:` as first field in generated YAML** — without it, `validate-apply` derives a fragile alias-based ID that breaks on rename.
- **CLI tests: consolidate `_make_config` into shared `make_mock_config` fixture** — used by `test_cli_probe.py` and `test_cli_delete.py`; test renamed to `test_delete_automation_not_found_exits_nonzero`.
- **validate-apply: run `can_reload_domain` check before REST POST** — prevents pushing config that would then return `reload-blocked`.
- **list-automations / list-scripts: rename `alias` → `friendly_name`** — matches HA's `attributes.friendly_name`; results sorted by `entity_id`.

### Files affected

| File | Change |
|------|--------|
| `src/ha_agent_lab/apply.py` | REST push (`POST /api/config/{domain}/config/{id}`) added before reload; `ApplyResult` extended with `config_id`, `domain`, `creation_attempted`, `creation_ok` |
| `src/ha_agent_lab/cli.py` | `list-automations`, `list-scripts`, `delete-automation`, `delete-script` subcommands added |
| `src/ha_agent_lab/ha_api.py` | `extract_ha_error_message` helper added; all error responses now surface HA's `{"message":"..."}` field |
| `skills/ha-apply-change/SKILL.md` | Apply workflow updated to reflect REST push flow and new `creation_ok` output field |
| `skills/ha-build-automation/SKILL.md` | `id:` field marked required as first field in generated YAML |
| `skills/ha-delete-config/SKILL.md` | New skill: delete workflow with list → confirm → delete → optional reload |
| `state-templates/CLAUDE-APPEND.md` | `ha-delete-config` row added to skills table |
| `CLAUDE.md` | `list-automations`, `list-scripts`, `delete-automation`, `delete-script` CLI commands documented |
| `.claude-plugin/hermit-meta.json` | `required_core_version` and `requires.claude-code-hermit` bumped `>=1.0.29` → `>=1.0.30` |
| `.claude-plugin/plugin.json` | `dependencies[0].version` bumped `^1.0.29` → `^1.0.30`; manifest `version` bumped `0.0.8` → `0.0.9` |
| `CHANGELOG.md` | New `[0.0.9]` entry |

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Refresh skill files** — replace `skills/ha-apply-change/SKILL.md`, `skills/ha-build-automation/SKILL.md`, and `skills/ha-delete-config/SKILL.md` from this release.
2. **Add `ha-delete-config` to the injected skills table** — in the operator project's `CLAUDE.md`, find the `### Skills` table under `## Home Assistant Workflow` and append: `| /claude-code-homeassistant-hermit:ha-delete-config | Discover and delete an automation/script config from HA |`

No `config.json` changes required.

## [0.0.8] - 2026-05-04

### Added

- **hatch: add `READ_FROM_ENV:HOMEASSISTANT_URL` to docker network requirements** — allows `/docker-security` step 3a to resolve custom HA hostnames dynamically; requires core `>=1.0.29`.

### Changed

- **deps: bump core requirement to `>=1.0.29` / `^1.0.29`** — was `>=1.0.26`; required by `READ_FROM_ENV:HOMEASSISTANT_URL` allowlist entry (resolver in core 1.0.29's `/docker-security`).

### Fixed

- **hatch: read token via Read tool instead of Python subprocess** — `python -c "from dotenv…"` was blocked by the `TOKEN` deny-pattern hook; Read tool is hook-safe.
- **hatch: remove non-existent `.env.example` copy step** — no such file ships with the plugin; replaced with direct "create `.env`" instruction.

### Files affected

| File | Change |
|------|--------|
| `skills/hatch/SKILL.md` | Token-read instruction switched from Bash python one-liner to Read tool; `.env`-missing message dropped non-existent `cp .env.example .env` step; new `READ_FROM_ENV:HOMEASSISTANT_URL` entry under `### Domains (DNS allowlist)` with explanatory prose |
| `.claude-plugin/hermit-meta.json` | `required_core_version` and `requires.claude-code-hermit` bumped `>=1.0.26` → `>=1.0.29` |
| `.claude-plugin/plugin.json` | `dependencies[0].version` bumped `^1.0.26` → `^1.0.29`; manifest `version` bumped `0.0.7` → `0.0.8` |
| `CHANGELOG.md` | New `[0.0.8]` entry |

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Refresh the `hatch` skill content** — replace `plugins/claude-code-homeassistant-hermit/skills/hatch/SKILL.md` with the new file from this release.

**Note:** The `READ_FROM_ENV:HOMEASSISTANT_URL` entry only takes effect when the operator runs `/claude-code-hermit:docker-security` and the fleet scan reads this plugin's `## Docker network requirements` section. Until then, the change is inert.

No `config.json` changes required.

## [0.0.7] - 2026-05-03

### Added

- **hatch: add Docker network requirements section** — declares `nabu.casa` and `ASK_OPERATOR_FOR_HA_IP` for `/docker-security` step 3a fleet scan; operators are prompted per-entry.

### Changed

- **deps: bump core requirement to `>=1.0.26` / `^1.0.26`** — was `>=1.0.21`; required by `## Docker network requirements` section (parsed by core 1.0.26's `/docker-security`).

### Removed

- **ha-automation-errors: scheduled check retired end-to-end** — `/api/error_log` unreliable on current HA installs (404 or unparseable plain-text); `/api/logbook` rejected as replacement (state changes, not errors). Removed audit function, CLI subcommand, skill, hatch registration, and docs.
- **ha automation-errors CLI subcommand** (`./bin/ha-agent-lab ha automation-errors [--min-hits N]`).
- **ha-automation-error-review skill** (`/claude-code-homeassistant-hermit:ha-automation-error-review`).

### Files affected

| File | Change |
|------|--------|
| `src/ha_agent_lab/audits.py` | `review_automation_errors`, `ERROR_PATTERNS`, `ERROR_REGEX` removed; `import re` no longer needed |
| `src/ha_agent_lab/cli.py` | `automation-errors` subparser, dispatcher branch, and `_print_automation_errors_summary` removed |
| `tests/test_audits.py` | `review_automation_errors` import + two tests removed |
| `skills/ha-automation-error-review/` | Directory deleted |
| `skills/hatch/SKILL.md` | `ha-automation-errors` removed from `scheduled_checks` registration, success-message bullet, and surrounding prose ("all four" → "all three"); new `## Docker network requirements` section appended for `/docker-security` fleet scan |
| `state-templates/CLAUDE-APPEND.md` | Skills-table row and CLI-usage line removed |
| `CLAUDE.md` | CLI line and scheduled-checks listing updated |
| `docs/knowledge-schema.md` | Artifact row removed |

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. It will execute the steps below.

1. **Detect leftover references.** Check each location independently:
   - `.claude-code-hermit/config.json` — is there an entry whose `id == "ha-automation-errors"` in `scheduled_checks`?
   - `.claude-code-hermit/state/reflection-state.json` — does `scheduled_checks["ha-automation-errors"]` exist?

   If both are absent, print `ha-automation-errors not present in config or runtime state — nothing to retire.` and do not execute steps 2 or 3.

2. **Ask the operator using `AskUserQuestion`:**
   - Question: `"The 'ha-automation-errors' daily check has been retired — its skill and CLI are gone in this release. Clean up any leftover references from config and runtime state?"`
   - Header: `"Retire check"`
   - Options:
     1. Label: `"Remove (Recommended)"` — Description: `"Drop the entry from scheduled_checks and prune the matching runtime-state key. Cleanest end state. A replacement may be added in a future release."`
     2. Label: `"Skip — handle manually"` — Description: `"Do nothing. The entry will point at a missing skill; the next scheduled-checks pass will log a 'skill not found' warning until you remove it."`
   - `multiSelect`: `false`
   - (AskUserQuestion also auto-injects an `Other` option for free-text input.)

3. **If the operator picked `Remove`, apply the cleanup:**
   - In `.claude-code-hermit/config.json` (if `scheduled_checks` contains the entry): filter it out. Preserve every other entry, key ordering, and 2-space indentation. Write back.
   - In `.claude-code-hermit/state/reflection-state.json` (if the key exists): delete `scheduled_checks["ha-automation-errors"]`. Preserve every sibling key. Write back.
   - Print `Retired ha-automation-errors check: removed from config and runtime state.` Omit whichever location was already clean.

   If the operator picked `Skip — handle manually`, print `Left ha-automation-errors references in place — expect a 'skill not found' warning on the next scheduled-checks pass.` and do not modify any files.

   If the operator picked `Other`, ask them what specifically they want done before modifying anything.

No template, CLAUDE-APPEND, or settings changes required for this release.

---

## [0.0.6] - 2026-04-27

### Changed

- **manifest: migrate hermit-internal fields to `hermit-meta.json`** — `required_core_version`, `requires`, and `hermit.boot_skill` removed from `plugin.json` so native validator passes.
- **deps: bump core requirement to `>=1.0.21` / `^1.0.21`** — was `>=1.0.17`.
- **plugin.json: add native `dependencies` field** — enables Claude Code's dependency resolver to auto-install core.
- **docs: raise Claude Code prerequisite to v2.1.110+** — required by dep resolver and `claude plugin tag`.
- **docs: tighten CLAUDE.md for contributor audience** — remove duplicate install block; promote dev constraints to top-level section.

### Files affected

| File | Change |
|------|--------|
| `.claude-plugin/hermit-meta.json` | Hermit-internal fields migrated here; `required_core_version` + `requires` bumped to `>=1.0.21` |
| `.claude-plugin/plugin.json` | Hermit-internal fields removed; `dependencies` field added; version bumped to `^1.0.21` |
| `README.md` | Prereq `v2.1.98+` → `v2.1.110+`; architecture core pin updated to `≥ 1.0.21` |
| `CLAUDE.md` | Contributor docs restructured; stale version references corrected |

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. No file changes required for this release.

**Note:** Operators on core `<1.0.21` should upgrade core first; `hermit-doctor` will flag the version gap.

No `config.json` changes required.

## [0.0.5] — 2026-04-27

### Added

- **CI: add GitHub Actions workflow `Test HA Hermit`** — runs pytest on every PR touching HA-hermit; path-filtered to `plugins/claude-code-homeassistant-hermit/**`.

### Changed

- **manifest: monorepo housekeeping** — plugin moved into `plugins/claude-code-homeassistant-hermit/`; inner marketplace.json removed; `required_core_version` set to `>=1.0.17`; URLs updated to monorepo paths.

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. No operator action required — internal manifest cleanup plus CI-only addition.

No `config.json` changes required.

---

## [0.0.4] — 2026-04-24

### Fixed

- **audit_automations: fix 404 on non-existent bulk endpoint** — replaced with two-step fetch (`/api/states` enumerate + per-id parallel GET); YAML-packaged automations counted in `unmanaged`.

### Added

- **ha probe: new CLI subcommand** — GETs a raw HA REST path and pretty-prints JSON; safe alternative to `curl` when the `TOKEN` deny-pattern hook is active.
- **CLAUDE.md: add HA API references** — links to REST/WebSocket docs; verification rule and known-gotchas section.

### Changed

- **artifacts: align naming to core 1.0.17 convention** — produces `<slug>-<YYYY-MM-DD>.<ext>` filenames; adds `standard_metadata()` and `current_session_id()` helpers; all reports now carry full frontmatter with `session:` field.
- **ha-analyze-patterns: write to `raw/` not `compiled/`** — pattern analyses are weekly snapshots, not durable work-products; output path corrected to `raw/patterns-<date>.md`.
- **ha-morning-brief: write to `compiled/` and cite in SHELL.md** — briefs are durable; writes `compiled/brief-morning-<date>.md` and appends wikilink to SHELL.md for session-close archival.
- **ha-refresh-context: document house-profile compiled/ write path** — Output section now describes when to write `compiled/context-house-profile-<date>.md`.
- **audit frontmatter: rename `source: "plugin-check"` → `"scheduled-check"`** — aligns with v1.0.15 terminology rename missed in artifact frontmatter.
- **docs/knowledge-schema.md: update frontmatter requirements and filename patterns.**
- **CLAUDE.md: expand bucket list** — document four canonical buckets (`raw/`, `compiled/`, `state/`, `proposals/`) with purpose descriptions.
- **deps: bump core requirement to `>=1.0.17`** — requires `## Artifacts` section, `hermit-attach`, and `prompt-context` hook.

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Rename legacy artifacts under `.claude-code-hermit/raw/`.** For each file whose name matches the pattern `<YYYYMMDD>T<HHMMSS>Z__<slug>.<ext>` (old double-underscore format):
   - Compute new name `<slug>-<YYYY-MM-DD>.<ext>` (date is the first 8 characters of the timestamp, reformatted as `YYYY-MM-DD`).
   - If the target name already exists in the same directory, append the time portion to disambiguate: `<slug>-<YYYY-MM-DD>-<HHMMSS>.<ext>`.
   - Use `git mv` if the file is tracked by git; otherwise use `mv`.
   - Do not rewrite file bodies.

2. **Move pattern-analysis files from `compiled/` to `raw/`.** For each file matching `compiled/<YYYYMMDD>T<HHMMSS>Z__pattern-analysis.md` (legacy misbucketed writes):
   - Compute target: `raw/patterns-<YYYY-MM-DD>.md` (date from timestamp prefix, reformatted).
   - Apply the same collision rule as step 1 (`raw/patterns-<YYYY-MM-DD>-<HHMMSS>.md`).
   - If the file's YAML frontmatter lacks a `type:` field, insert `type: analysis` after the opening `---` line. Do not touch the body.
   - Use `git mv` if the file is tracked; otherwise `mv`.

3. **Backfill `session: null` frontmatter.** For each `.md` file renamed in steps 1–2 whose YAML frontmatter lacks a `session:` field, insert `session: null` after the last existing frontmatter key (before the closing `---`). Do not synthesize historical session IDs.

4. **Do not touch** files whose names already match `<slug>-<YYYY-MM-DD>.<ext>`, any `-latest.{md,json}` siblings, `automation-<slug>-<date>.yaml`, `script-<slug>-<date>.yaml`, `snapshot-ha-normalized-latest.json`, `compiled/context-house-profile-*.md`, or `compiled/brief-morning-*.md` — these are already correct shape or are intentional fixed-name caches.

5. **Prune if `compiled/` is now empty** — if `.claude-code-hermit/compiled/` contains no files after step 2, no action is needed; the directory remains and core hermit may write to it in future sessions.

No `config.json` changes required. Core hermit v1.0.17 is handled independently by core's own `hermit-evolve` pass; these instructions cover only this plugin's local artifact renames and frontmatter backfill.

---

## [0.0.3] — 2026-04-22

### Changed

- **align with core 1.0.16: scheduled-checks decoupled from reflect** — all `"plugin_check via reflect"` references updated to `"scheduled check via reflect-scheduled-checks"` across skills, hatch, and docs.
- **deps: bump core requirement to `>=1.0.16`** — ensures `scheduled-checks` routine is registered; on 1.0.15 it is absent and checks silently never fire.

---

## [0.0.2] — 2026-04-22

### Fixed

- **hatch: rename config key `plugin_checks` → `scheduled_checks`** — prior installs used the old key, which reflect silently ignored after core 1.0.15 upgrade.
- **hatch: write `config.boot_skill` on fresh installs** — field was handled by `hermit-evolve` for upgrades but never written on first setup, causing always-on mode to boot with generic session skill.

### Changed

- **Minimum core hermit requirement bumped to ≥ 1.0.15** — required for `scheduled_checks` key support and `boot_skill` config field.

## [0.0.1] — 2026-04-21

Initial public release.
