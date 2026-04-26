# Changelog

All notable changes to `claude-code-homeassistant-hermit` / `ha-agent-lab` are documented here.

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
