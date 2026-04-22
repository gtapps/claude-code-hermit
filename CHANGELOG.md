# Changelog

## [Unreleased]

### Changed

- **Minimum core version bumped to v1.0.16** — dev-hermit now requires `claude-code-hermit` v1.0.16+ so that the `scheduled-checks` standalone routine (which runs dev-hermit's `scheduled_checks` entries) is guaranteed to be present in the project config.

---

## [0.1.4] - 2026-04-22

### Changed

- **BREAKING: minimum core version bumped to v1.0.15** — dev-hermit now requires `claude-code-hermit` v1.0.15+ to reflect the `scheduled_checks` rename and other protocol changes in the core.
- **hatch: `plugin_checks` → `scheduled_checks`** — All five references in the hatch skill updated to match core v1.0.15's renamed config key; `RECOMMENDED-PLUGINS.md` and `CLAUDE.md` updated likewise.
- **hatch: dev-cleanup routine gate removed** — The `< 1.0.12` version guard is redundant now that the min floor is v1.0.15; the cleanup routine question is shown unconditionally.
- **hatch report: surfaces `hermit-settings boot-skill`** — "Other core skills" block now includes the v1.0.14 boot-skill management command.
- **CLAUDE-APPEND: reflect suppression codes** — The reflect note now mentions structured Progress Log suppression codes (`no-evidence`, `weak-recurrence`, etc.) for tuning proposal tiers.
- **CLAUDE-APPEND: knowledge-schema.md pointer** — Dev Knowledge section points at `knowledge-schema.md` if present, matching core v1.0.15's new template.
- **release skill: `claude plugin validate` step** — Release flow now runs validation between file updates and commit, surfacing errors before they land in git.
- **marketplace.json: full metadata** — Added `author`, `license`, `homepage`, `repository`, and `keywords` fields to match core v1.0.15's expanded schema.

---

## [0.1.3] - 2026-04-21

### Changed

- **Skill renamed: `dev-hatch` → `hatch`** — The `dev-` prefix was redundant; the plugin namespace (`claude-code-dev-hermit:`) already conveys scope. Invoke as `/claude-code-dev-hermit:hatch`.

---

## [0.1.2] - 2026-04-20

### Added

- **dev-hatch: weekly dev-cleanup routine** — Phase 3 wizard now offers an optional weekly branch cleanup routine (`0 10 * * 1`); requires hermit v1.0.12+. Routine is written to `config.json` and registered via `hermit-routines load` immediately.
- **dev-hatch report: `hermit-routines` entry** — "Other core skills" section now surfaces `/claude-code-hermit:hermit-routines` for managing the reflect routine and dev-cleanup.

### Changed

- **CLAUDE-APPEND: reflect phase note** — Step 6 (task boundary) now notes that reflect runs as a daily routine and that `newborn`-phase hermits (<3 days) produce fewer proposals — expected behaviour, not a gap.
- **CLAUDE-APPEND quick reference: `hermit-routines`** — Added entry with schedule details (reflect 9am daily, dev-cleanup weekly if enabled).

### Fixed

- **`plugin.json` invalid JSON** — Stray closing `}` removed.

---

## [0.1.1] - 2026-04-15

### Fixed

- **Fully qualified agent/skill names enforced throughout skill instructions** — Bare names (`implementer`, `/dev-quality`, `code-review`) were replaced with canonical forms (`claude-code-dev-hermit:implementer`, `/claude-code-dev-hermit:dev-quality`, `code-review:code-review`) in all skill and template files. Mirrors the fix applied in claude-code-hermit v1.0.2.

### Files affected

| File | Change |
|------|--------|
| `state-templates/CLAUDE-APPEND.md` | `implementer` → `claude-code-dev-hermit:implementer` (table + workflow step + checklist) |
| `skills/dev-hatch/SKILL.md` | `implementer` → `claude-code-dev-hermit:implementer` (report output) |
| `skills/dev-quality/SKILL.md` | `code-review` → `code-review:code-review`; `implementer` → `claude-code-dev-hermit:implementer` |

---

## [0.1.0] - 2026-04-15

Initial public release.
