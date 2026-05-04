# Changelog

All notable changes to `claude-code-homeassistant-hermit` / `ha-agent-lab` are documented here.

## [Unreleased]

### Added

- **`READ_FROM_ENV:HOMEASSISTANT_URL` in docker network requirements** — added to the DNS allowlist section so `/claude-code-hermit:docker-security` step 3a can resolve the operator's configured HA hostname (e.g. `ha.mydomain.com`) dynamically, covering custom remote domains not under `nabu.casa`.

### Fixed

- **`hatch`: read token via Read tool, not Python subprocess** — replaced the `python -c "from dotenv import dotenv_values…"` one-liner with an instruction to use the Read tool on `.env` directly. The Python approach was blocked by the deny-pattern hook (any Bash argument containing the literal string `TOKEN` is rejected, including via `python -c`). The Read tool approach is hook-safe and avoids echoing the token to conversation output.
- **`hatch`: removed non-existent `.env.example` copy step** — the `.env` missing-credential message instructed users to run `cp .env.example .env`, but no such example file ships with this plugin. Replaced with a direct "create `.env` with these values" instruction.

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
