# Changelog

All notable changes to `claude-code-homeassistant-hermit` / `ha-agent-lab` are documented here.

## [Unreleased]

### Added

- **`ha integration-health` CLI command and `integration_health.py` module** — promotes `ha-integration-health` from a pure-skill arithmetic pass to a Python-backed command. The CLI replicates the skill's existing stdout contract (`ha-integration-health findings — <date>` / `Degraded domains: N` / per-domain lines) so `reflect-scheduled-checks` sees no change. New side effect: every run writes `.claude-code-hermit/state/integration-health-degraded-domains.json`, a machine-readable list of degraded entity-domain prefixes consumed by the upcoming `silence.py` module to suppress overlapping `long_unavailable` findings in `ha-analyze-patterns`. Thresholds (`min_total=3`, `min_ratio=0.5`) are defined once in `compute_degraded_domains()` and no longer duplicated across skills. `ha-integration-health/SKILL.md` is updated to a single Bash delegate.
- **`silence_summary` block in `snapshot-ha-normalized-latest.json`** — `compute_silence_summary()` in the new `silence.py` module mines the snapshot's existing `last_triggered`, `last_changed`, and `device_class` fields to produce four finding categories: `dead_automations` (enabled automations not fired in 30+ days), `silent_event_sensors` (motion/door/window binary sensors silent for 7+ days), `inactive_candidates_by_domain` (lights/switches/covers/climates unchanged for 7+ days — informational only), and `long_unavailable` (individual entities unavailable 7+ days that aren't already covered by a degraded domain from `ha-integration-health`). `suppressed_entity_domains` lists which entity-domain prefixes were skipped because integration-health already covers them. Both `refresh-context` and `refresh-context --incremental` attach this block before writing the artifact — including on no-diff incremental runs, since thresholds advance daily.
- **`ha-analyze-patterns` surfaces silence findings** — step 4 maps each `silence_summary` category to the documented stdout buckets (`Reliability issues:` for dead automations, silent sensors, long-unavailable; `inactive_candidates_by_domain` is Markdown-only). `What to Look For` retains explicit coverage for manual-action pattern detection under Time/Correlation patterns. `ha-pattern-analyst` agent Data Sources updated to describe `silence_summary`; its output schema clarified to exclude fields the skill reads directly from the snapshot. `docs/knowledge-schema.md` documents the new block.
- **`HomeAssistantClient.get_history()`** — new method on the REST client that fetches state-change history from HA's `/api/history/period` endpoint. Accepts explicit `start_time` and `end_time` datetimes; rejects empty `entity_ids` to prevent an unbounded all-entity fetch; sends bare query flags (`&minimal_response`, `&significant_changes_only`) matching HA REST API docs rather than `=true` suffixes; maps the response by `inner_list[0]["entity_id"]` (resilient to HA reordering); entities with no events in the window are absent from the result dict so callers detect zero-count entities explicitly.
- **`history.py` aggregator and `ha fetch-history` CLI** — new `history.py` module produces per-entity aggregates from `get_history()` responses: `event_count`, `returned`, `hour_histogram` (24-bucket UTC-hour distribution), `last_event_iso`, `stuck_for_days`, and `state_durations` (seconds spent in each state, clipped to `[window_start, window_end]`). Entities in the requested scope that HA omits from its response get synthesized zero-count rows so downstream consumers see a complete picture. `detect_time_patterns()` flags entities where a single UTC hour accounts for > 50% of events (minimum 5 total). `fetch_history_snapshot()` orchestrates fetch → aggregate → detect and writes `.claude-code-hermit/raw/snapshot-ha-history-{N}d-<date>.json` plus a fixed-name `latest` alias; the `ha fetch-history [--window-days N] [--entities …]` CLI subcommand drives it. Default scope: `light.*`, `switch.*`, `cover.*`, `climate.*`, `automation.*`, and motion/door/window/opening/occupancy `binary_sensor.*`.
- **Skill and agent wiring for history** — `ha-analyze-patterns` now fetches 7d history as step 3, cross-references `time_patterns` into `Automation opportunities:`, and promotes zero-count inactive candidates to `Reliability issues:` when corroborated by a 30d `last_changed` threshold; fetch failures log to SHELL.md Monitoring and never surface to scheduled-check stdout. `ha-morning-brief` fetches 1d history and renders a `Durante a noite:` section (top-active overnight entity, stuck sensors, HVAC duration from `state_durations`) between `Estado actual:` and `Energia:`; the section is silently omitted if the fetch fails. `ha-pattern-analyst` agent Data Sources updated to include `snapshot-ha-history-7d-latest.json`; `time_patterns` added to output schema. `docs/knowledge-schema.md` documents the two new artifact rows.

## [0.1.2] - 2026-05-12

### Fixed

- **`SimulationResult.is_valid` no longer treats ASK-severity policy reasons as hard blocks** — regression missed when the `ask` tier was added in v0.1.1. **Operator action: if you added `alarm_control_panel.*` to `HA_SAFE_ENTITIES` as a workaround, remove it after updating.** Root causes: (1) `simulate_artifact` was calling `evaluate_references` without `root`, so `ha_safety_mode` was always read from `Path.cwd()` instead of the project config; (2) `is_valid` gated on `bool(blocked_reasons)`, but that list includes ASK-severity entries — only BLOCK entries should prevent apply. Fix adds `policy_blocked: bool` (sourced from `PolicyDecision.blocked`, True only for BLOCK) and threads `root` through to `evaluate_references`. Under `ha_safety_mode: ask` the YAML apply pipeline now proceeds after operator confirmation, matching the MCP hook and `ha-apply-change` skill.
- **`ha policy-check <yaml>` now honors the project's `ha_safety_mode`** — `evaluate_yaml_policy` was calling `evaluate_references` without `root`, so the CLI's policy-check command silently fell back to `Path.cwd()` for policy config. Invoking from a subdirectory degraded to fail-closed `strict`. Fix threads `root` (from `load_config().root`) through the CLI handler and into `evaluate_yaml_policy`. Same class of latent bug as the apply-path fix above; no operator-visible regression reported, fixed for consistency.

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

- **`ha audit-scripts` CLI command and `audit_scripts` function** — mirrors `audit-automations` for `script.*` entities. Uses `GET /api/config/script/config/{id}`, runs the same safety policy check, and writes artifacts to `.claude-code-hermit/raw/audit-ha-script-safety-*`. `ha-safety-audit` skill updated to run both commands and concatenate findings.
- **Acknowledgement scaffold** — `_load_acknowledged` reads `automation_ids` and `script_ids` from `.claude-code-hermit/compiled/acknowledged-violations.md` frontmatter. Violations whose ids are listed there are routed to a new `acknowledged` bucket in the audit summary instead of `violations`, so repeat proposals are suppressed for operator-approved exceptions. `hatch` copies the template on first setup.
- **`state-templates/compiled/acknowledged-violations.md`** — template for the per-project suppression list, copied by `hatch`.
- **`ha_safety_mode` two-tier dial** — configurable behaviour for sensitive-domain actuation (`lock`, `alarm_control_panel`, security-related `cover`/`button`/`switch`). Two values:
  - `strict` (default, existing behaviour) — always block; work goes through a proposal.
  - `ask` — operator is prompted before any sensitive actuation. `ha-apply-change` uses `AskUserQuestion` before pushing; direct MCP calls emit `permissionDecision: "ask"` so Claude Code's permission system prompts the operator natively (matches the convention already used by `hooks/curl-host-gate.py`). Both paths are harness-enforced, not convention-driven.
  Set during `hatch` (new §7.5 question) or by editing `ha_safety_mode` in `.claude-code-hermit/config.json` directly. An unknown value (e.g. `permissive`) falls back to `strict`.
- **`Severity` enum in `policy.py`** (`block` / `ask` / `allow`) — replaces the internal `bool` return from `classify_entity()`. `is_sensitive_entity()` kept as a backward-compatible shim (True for BLOCK or ASK, False for ALLOW). `evaluate_references()` `PolicyDecision` gains a `severity` field alongside the existing `blocked` bool.
- **`severity` field in `ha policy-check` JSON output** — callers can now distinguish `block`, `ask`, and `allow` without re-implementing the policy logic.

### Changed

- **Migrated project-root `MEMORY.md` / `memory/` references to the right storage location for each value** — house profile, learned patterns, known issues, and cross-session suppression signals (in `ha-pattern-analyst` / `ha-safety-reviewer`) now live in Claude Code's platform auto memory (`~/.claude/projects/<key>/memory/`), which loads automatically at session start. The three agents (`ha-automation-builder`, `ha-pattern-analyst`, `ha-safety-reviewer`) already declared `memory: project` frontmatter — their body instructions now match. No more manual `MEMORY.md` reads/writes for Claude-derived knowledge.
- **Locale now lives in `.claude-code-hermit/OPERATOR.md` under a `## HA hermit` section, not auto memory** — locale is operator-set config, not Claude-derived knowledge: it should survive project moves, be CLI-readable, and be visible to the operator. `boot status` reports the language again (`BootStatus.language` / `BootStatus.needs_language` restored); the setup checklist's `Language` entry points at `.claude-code-hermit/OPERATOR.md`. `boot store --language <locale>` writes to OPERATOR.md, creating the `## HA hermit` section on first use. Future HA operator preferences (room defaults, alert channels, etc.) belong under the same section.
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

- **`agents/ha-safety-reviewer.md`: added `## Memory Cross-Check` section** — reviewer now consults auto-memory (`MEMORY.md` index + matching topic files) before issuing a verdict. If memory records an operator decision that would change the verdict, the reviewer returns `approve` with a single `info` Finding coded `covered-by-memory` plus a `[memory: <filename>]` breadcrumb. Sensitive-domain blocks (`lock`, `alarm_control_panel`, security-related `cover`/`button`/`switch`) are carved out — memory cannot override them regardless of any operator note.
- **`agents/ha-pattern-analyst.md`: added `## Memory Cross-Reference` section** — analyst now consults auto-memory before emitting candidates; covered candidates move to a new top-level `suppressed[]` array with fields `{code, reason, quoted_line, memory_ref}`. Omitted when empty. Mirrors the canonical `covered-by-memory` code introduced in `claude-code-hermit` v1.0.32.
- **deps: bump core requirement to `>=1.0.32` / `^1.0.32`** — `required_core_version` and `requires.claude-code-hermit` in `hermit-meta.json`, and `dependencies[0].version` in `plugin.json`, all updated. The `covered-by-memory` code was introduced in core hermit v1.0.32 (`proposal-triage`, `reflection-judge`); this release adopts it for the HA suggestion agents and the floor declares the dependency.

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

- **`ha validate-apply` now pushes config to HA via REST** — `POST /api/config/{domain}/config/{id}` is called before the domain reload, fixing the silent failure where `reload_attempted: true` was returned but the automation never appeared in HA (PROP-005). The automation `id:` field is used as the REST config ID; if absent, it is derived from the alias or filename with a drift warning in the output.
- **`ha delete-automation <id>` and `ha delete-script <id>`** — remove an automation or script config from HA via `DELETE /api/config/{domain}/config/{id}`. Output includes `ok`, `message`, and a report path.
- **`ha list-automations` and `ha list-scripts`** — lightweight enumeration of live HA automations/scripts (entity_id, config id, friendly_name, state, deletable). Sorted by entity_id. The `deletable: false` flag identifies YAML-packaged automations that lack a numeric `id` and cannot be removed via REST. Intended as a quick lookup before delete, without the full policy audit of `audit-automations`.
- **`ha-delete-config` skill** — operator-facing workflow for discovering a target automation/script, confirming deletion, and optionally triggering a reload.
- **Structured HA error messages surfaced verbatim** — all HA error responses carry `{"message":"..."}`. This field is now extracted and included in apply/remove reports, replacing the opaque "Home Assistant request failed (status=400)".

### Changed

- **`validate-apply` JSON output** — includes three new fields: `config_id`, `creation_attempted`, `creation_ok`. The `creation_ok` field distinguishes a pushed-and-verified config from a reload-only operation (e.g. YAML mode fallback).
- **`ApplyResult` dataclass** — extended with `config_id`, `domain`, `creation_attempted`, `creation_ok`.
- **deps: bump core requirement to `>=1.0.30` / `^1.0.30`** — was `>=1.0.29`; `required_core_version` and `requires.claude-code-hermit` in `hermit-meta.json` and `dependencies[0].version` in `plugin.json` all updated together.

### Fixed

- **Apply flow no longer silently succeeds when HA never received the config** — previous behavior called `automation.reload` with no config push, returning success despite the automation being absent. Now reports `creation_ok: false` with a clear message in the YAML-mode fallback case.
- **`ha-delete-config` skill**: removed erroneous advice to use `validate-apply` for post-delete reload (it would also push the supplied YAML as a new config). Step 5 now correctly points to HA Developer Tools → Services.
- **`ha-build-automation` skill**: `id:` field is now required as the first field in generated YAML — without it, `validate-apply` derives a fragile ID from the alias that breaks on rename.
- **CLI tests**: `_make_config` helper consolidated into a shared `make_mock_config` fixture in `conftest.py`; `test_cli_probe.py` and `test_cli_delete.py` both use it. Renamed `test_delete_automation_missing_id_exits_nonzero` → `test_delete_automation_not_found_exits_nonzero` (the old name conflated a missing CLI argument with a missing HA resource).
- **`validate-apply` no longer pushes config when reload domain is disallowed** — the `can_reload_domain` authorization check now runs before the REST POST, not after. Previously the config could be pushed and then the result returned as `reload-blocked`, leaving HA state inconsistent with operator expectations. No-op in practice today (`_CONFIG_DOMAINS` and the reload allowlist are identical sets), but eliminates the latent footgun if those sets ever drift.
- **`list-automations` / `list-scripts` output shape** — renamed `alias` → `friendly_name` (matches HA's actual `attributes.friendly_name` — HA never exposes the YAML `alias:` field via `/api/states`), added `deletable: bool` flag (`false` for YAML-packaged automations that lack a numeric `id` and cannot be removed via REST), and results are now sorted by `entity_id` for deterministic operator UX. Field rename is contained within this unreleased v0.0.9 — no operator scripting is impacted.

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

- **`READ_FROM_ENV:HOMEASSISTANT_URL` in docker network requirements** — added to the DNS allowlist section so `/claude-code-hermit:docker-security` step 3a can resolve the operator's configured HA hostname (e.g. `ha.mydomain.com`) dynamically, covering custom remote domains not under `nabu.casa`. Requires the core `>=1.0.29` bump below — the `READ_FROM_ENV:` sentinel is parsed by core 1.0.29's `/docker-security` allowlist resolver.

### Changed

- **deps: bump core requirement to `>=1.0.29` / `^1.0.29`** — was `>=1.0.26`; `required_core_version` and `requires.claude-code-hermit` in `hermit-meta.json` and `dependencies[0].version` in `plugin.json` all updated together. Required by the new `READ_FROM_ENV:HOMEASSISTANT_URL` allowlist entry above (resolver lives in core 1.0.29's `/docker-security`).

### Fixed

- **`hatch`: read token via Read tool, not Python subprocess** — replaced the `python -c "from dotenv import dotenv_values…"` one-liner with an instruction to use the Read tool on `.env` directly. The Python approach was blocked by the deny-pattern hook (any Bash argument containing the literal string `TOKEN` is rejected, including via `python -c`). The Read tool approach is hook-safe and avoids echoing the token to conversation output.
- **`hatch`: removed non-existent `.env.example` copy step** — the `.env` missing-credential message instructed users to run `cp .env.example .env`, but no such example file ships with this plugin. Replaced with a direct "create `.env` with these values" instruction.

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

- **Docker network requirements section in `skills/hatch/SKILL.md`** — declares `nabu.casa` (DNS allowlist) and `ASK_OPERATOR_FOR_HA_IP` (LAN allowlist suggestion) for `/claude-code-hermit:docker-security` step 3a fleet scan. Operators running the docker-security wizard with this plugin installed are prompted per-entry; nothing is auto-applied. This is the consumer that requires the core `>=1.0.26` bump below.

### Changed

- **deps: bump core requirement to `>=1.0.26` / `^1.0.26`** — was `>=1.0.21`; `required_core_version` and `requires.claude-code-hermit` in `hermit-meta.json` and `dependencies[0].version` in `plugin.json` all updated together. README prereq line updated to match. Required by the new `## Docker network requirements` section in `skills/hatch/SKILL.md` (parsed by core 1.0.26's `/docker-security` step 3a).

### Removed

- **`ha-automation-errors` scheduled check retired end-to-end.** The check depended on `/api/error_log`, which is no longer reliably available on current Home Assistant installs (returns 404 for many operators; even on installs where it returned 200 the existing code couldn't parse the plain-text body — the JSON-only client raised `Malformed JSON`, crashing the check). Migrating to `/api/logbook` was evaluated and rejected: logbook surfaces state changes, not automation execution errors, so a clean run there would give operators false confidence that nothing is broken. Removing the check end-to-end (audit function, CLI subcommand, skill, hatch registration, docs) until a replacement signal is designed.
- **`ha automation-errors` CLI subcommand** (`./bin/ha-agent-lab ha automation-errors [--min-hits N]`).
- **`ha-automation-error-review` skill** (`/claude-code-homeassistant-hermit:ha-automation-error-review`).

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

- **manifest: migrate hermit-internal fields to `hermit-meta.json` sidecar** — `required_core_version`, `requires`, and `hermit.boot_skill` moved out of `plugin.json` so `claude plugin validate` and `claude plugin tag --push` pass the native validator cleanly.
- **deps: bump core requirement to `>=1.0.21` / `^1.0.21`** — was `>=1.0.17`; `required_core_version` and `requires.claude-code-hermit` in `hermit-meta.json` and `dependencies[0].version` in `plugin.json` all updated together.
- **plugin.json: native `dependencies` field added** — enables Claude Code's native dependency resolver to auto-install core; hermit-internal `requires` field remains for runtime version gating.
- **docs: Claude Code prerequisite raised to v2.1.110+** — dep resolver and `claude plugin tag` both require v2.1.110+.
- **docs: CLAUDE.md tightened for contributor audience** — install block removed (duplicated in README); development constraints promoted to a top-level section; safety rationale added to sensitive-domains rule.

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

- **GitHub Actions workflow `Test HA Hermit`.** New `.github/workflows/test-ha.yml` runs the existing pytest suite (`plugins/claude-code-homeassistant-hermit/tests/test_*.py`) on every PR or push that touches HA-hermit. Installs `pyproject.toml`'s `[dev]` extras (pytest≥8) on Python 3.12 and runs `pytest tests/ -v`. Filtered to `plugins/claude-code-homeassistant-hermit/**` so unrelated plugin edits don't trigger HA CI. Closes the gap from the monorepo migration where HA's tests had no CI runner of their own.

### Changed

- **Monorepo housekeeping.** Plugin source moved into `plugins/claude-code-homeassistant-hermit/` of the `gtapps/claude-code-hermit` monorepo. `required_core_version` standardized as a top-level semver-range field (`>=1.0.17`); `requires.claude-code-hermit` restored to mirror it. Inner `.claude-plugin/marketplace.json` removed (the repo-root marketplace catalog is now authoritative). `plugin.json` `homepage` and `repository` URLs point at the monorepo path. README and Documentation links point at the monorepo.

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. No operator action required — internal manifest cleanup plus CI-only addition.

No `config.json` changes required.

---

## [0.0.4] — 2026-04-24

### Fixed

- **`audit_automations` 404 on bulk endpoint** — replaced the non-existent `GET /api/config/automation/config` call with a two-step fetch: enumerate automation entities via `/api/states`, then fetch each config individually via `/api/config/automation/config/{id}` in parallel (up to 20 concurrent requests). Automations lacking a numeric `id` (YAML-packaged) are counted in `unmanaged`; per-ID 404s are counted in `fetch_failures`; other errors still propagate loudly. Fixes `ha audit-automations` and the `ha-safety-audit` scheduled check.

### Added

- **`ha probe <path>` CLI subcommand** — `bin/ha-agent-lab ha probe /api/config/automation/config/1234` GETs a raw HA REST path and pretty-prints the JSON response. Provides a safe alternative to `curl` when the `Bash(*TOKEN*)` deny-pattern hook is active, and a quick way to verify whether a REST endpoint exists before writing code against it.
- **HA API references in `CLAUDE.md`** — links to the authoritative REST and WebSocket API docs, a verification rule ("probe a live instance or WebFetch upstream before assuming an endpoint exists"), and a known-gotchas section seeded with the automation-listing lesson from this bug.

### Changed

- **Align with claude-code-hermit 1.0.17: artifact-naming convention** — `src/ha_agent_lab/artifacts.py` now produces `<slug>-<YYYY-MM-DD>.<ext>` filenames (was `<UTC-timestamp>__<slug>.<ext>`), matching the format declared in `docs/knowledge-schema.md`. Added `standard_metadata()` helper (enforces `title/type/created/session/tags` ordering) and `current_session_id()` helper (reads `.claude-code-hermit/state/runtime.json`). Simulation and apply reports now carry full frontmatter. All audit reports gain a `session:` field.
- **`ha-analyze-patterns`: write to `raw/` not `compiled/`** — pattern analyses are weekly rolling snapshots, not durable cross-session work-products. Skill output path corrected to `raw/patterns-<date>.md` with `type: analysis` and a `patterns-latest.md` sibling, aligning code with `docs/knowledge-schema.md`. Raw JSON data goes to `raw/snapshot-ha-pattern-analysis-<date>.json`.
- **`ha-morning-brief`: write brief to `compiled/` and cite in SHELL.md** — morning briefs are durable and injected at session start. Skill now writes `compiled/brief-morning-<YYYY-MM-DD>.md` (with `type: brief`, `session:` frontmatter) and appends a `[[compiled/brief-morning-<date>]]` wikilink to SHELL.md `### Artifacts produced this session` for core session-close to archive in `## Artifacts`.
- **`ha-refresh-context`: document house-profile compiled/ write path** — skill Output section now describes when to write `compiled/context-house-profile-<date>.md` (first run or when profile changes) and how to cite it in SHELL.md.
- **`source: "plugin-check"` → `source: "scheduled-check"` in audit frontmatter** — aligns with the v1.0.15 terminology rename that was applied to config/state keys but had been missed in artifact frontmatter.
- **`docs/knowledge-schema.md` updated** — frontmatter field requirements documented (with `session:` field), all filename patterns corrected to match code output, and a cross-reference to the core `artifact-naming.md` added.
- **`CLAUDE.md` bucket list expanded** — four canonical buckets documented (`raw/`, `compiled/`, `state/`, `proposals/`) with purpose descriptions.
- **Minimum core hermit requirement bumped to ≥ 1.0.17** — ensures the `## Artifacts` session-report section, `hermit-attach`, and `prompt-context` UserPromptSubmit hook are available on the operator's deployment.

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

- **Align with claude-code-hermit 1.0.16: scheduled-checks decoupled from reflect** — all references to "plugin_check via reflect" updated to "scheduled check via reflect-scheduled-checks" across skill descriptions, hatch instructions, and docs. The `scheduled-checks` routine (registered by core hermit 1.0.16's hatch/evolve) is now the correct driver of our four HA checks; reflect no longer runs them. Updated files: `skills/ha-safety-audit`, `ha-integration-health`, `ha-automation-error-review`, `ha-analyze-patterns`, `hatch`, `docs/knowledge-schema.md`, `CLAUDE.md`.
- **Minimum core hermit requirement bumped to ≥ 1.0.16** — ensures the core `scheduled-checks` routine is registered on fresh installs; on 1.0.15 that routine is absent and scheduled checks would silently never fire.

---

## [0.0.2] — 2026-04-22

### Fixed

- **`plugin_checks` → `scheduled_checks` (hermit 1.0.15 rename)** — `hatch` now writes scheduled checks under the `scheduled_checks` config key. Prior installs registered checks under the old `plugin_checks` key, which reflect silently ignored after the core hermit upgrade. Operator-facing copy ("Plugin Checks") updated to "Scheduled Checks" throughout.
- **Missing `config.boot_skill` write in hatch (hermit 1.0.14)** — `hatch` now explicitly writes `boot_skill: "/claude-code-homeassistant-hermit:ha-boot"` to `config.json` during setup. The field was declared in `plugin.json` and handled by `hermit-evolve` for upgrades, but was never written on fresh installs — so always-on mode booted with the generic session skill instead of `ha-boot`.

### Changed

- **Minimum core hermit requirement bumped to ≥ 1.0.15** — required for `scheduled_checks` key support and `boot_skill` config field.

## [0.0.1] — 2026-04-21

Initial public release.
