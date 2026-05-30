# Changelog

All notable changes to this project will be documented in this file.

---

## [Unreleased]

### Added

- **activity-deep-dive: labeled coaching observations to SHELL.md Findings** — signal-bearing observations (cardiac drift, zone anomalies, RPE/recovery conflicts, efficiency regressions) are appended under `## Findings` as `Coaching observation [<label>] (activity <id>)`, feeding reflect's `current-session` evidence path. Dedup-guarded against repeated runs.

---

## [0.0.5] - 2026-05-21

### Fixed

- **hermit-evolve: duplicate Fitness block after core 1.1.1 target migration** — when core migrated its block to `CLAUDE.local.md`, the Fitness block was left in `CLAUDE.md` and a second one appended, producing duplicates. Upgrade Instructions strip the stray block.

### Changed

- **hatch: Step 6 is now target-aware** — reads `hatch-options.json` and writes the CLAUDE-APPEND block to `CLAUDE.local.md` or `CLAUDE.md` based on `target`. Detects scope from `claude plugin list --json` and stamps `hatch-options.json` when core hatch hasn't run yet.
- **hatch: Upgrade Instructions Step 3 is fully unattended** — dropped hand-edit detection since `/hatch`'s single-source-of-truth contract makes the marked block template-authoritative.

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill executes the following steps automatically (via Step 7's sibling upgrade flow, which runs every plugin's `### Upgrade Instructions` before its CLAUDE-APPEND sync). The migration is unattended — no operator prompts. `hermit-evolve` Step 7 re-syncs the canonical block to `hatch_target` afterwards.

1. **Resolve `hatch_target`.** Use the same fallback chain `hermit-evolve` Step 2a uses, substituting the Fitness marker: read `.claude-code-hermit/state/hatch-options.json` and use the `"target"` field; else check `CLAUDE.local.md` for `<!-- claude-code-fitness-hermit: Fitness Workflow -->` → `hatch_target = "local"`; else check `CLAUDE.md` for the same marker → `hatch_target = "committed"`; else stop — the Fitness block is in neither file, nothing to migrate.

2. **Identify the non-target file.** `non_target = (hatch_target == "local") ? "CLAUDE.md" : "CLAUDE.local.md"`.

3. **If the marker is present in `non_target`, silently strip the marked block** (everything from the opening `<!-- claude-code-fitness-hermit: Fitness Workflow -->` through the matching closing `<!-- /claude-code-fitness-hermit: Fitness Workflow -->`, inclusive). Per `/hatch`'s single-source-of-truth contract, the CLAUDE-APPEND template is authoritative and operator overrides belong outside the marked block, so no hand-edit preservation is needed. Step 7's sync re-appends the canonical block to `hatch_target` afterwards.

4. **If the marker is only in `hatch_target`:** no-op. Steady state — Step 7's normal sync handles routine version-bump replacement.

No `config.json` changes required.

## [0.0.4] - 2026-05-21

### Changed

- **deps: core hermit floor raised to >=1.1.1** — aligns with the >=1.1.1 requirement now enforced across all fleet plugins; operators on older core builds will be prompted to update.
- **docs: README updated to reflect RPE skills** — `capture-activity-rpe` and `set-rpe` now listed in the skills overview and features section.
- **docs: min Claude Code prerequisite raised to v2.1.140+** — reflects the actual minimum tested version.

### Files affected

| File | Change |
|------|--------|
| `.claude-plugin/hermit-meta.json` | `required_core_version` and `requires` bumped to `>=1.1.1` |
| `.claude-plugin/plugin.json` | `dependencies.claude-code-hermit` bumped to `^1.1.1` |
| `README.md` | RPE skills added to features and skills overview; CC prerequisite raised to v2.1.140+ |

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Verify core version** — confirm the installed `claude-code-hermit` core is >=1.1.1. If not, run `claude plugin update claude-code-hermit` first.

No `config.json` changes required.

---

## [0.0.3] - 2026-05-14

### Added

- **capture-activity-rpe**: new skill that captures RPE when the operator replies to a `strava-sync` notification. Binds RPE to the latest synced activity via `strava-pending-rpe.json` and persists to `activity-notes.json`. Channel-agnostic.
- **set-rpe**: new slash command for manual and retroactive RPE entry (`/claude-code-fitness-hermit:set-rpe <id|latest> <rpe> [notes]`).
- **strava-sync**: appends an RPE prompt to the daily channel summary and writes `strava-pending-rpe.json` for `capture-activity-rpe` to consume.
- **activity-deep-dive**: surfaces `Subjective: RPE N/10 — <notes>` from `activity-notes.json` in output and compiled-artifact frontmatter when present.
- **weekly-load-review**: appends avg RPE summary to the channel message when 2 or more `activity-notes.json` entries exist for the week.
- **knowledge-schema.md**: documents the JSON shape of `activity-notes.json` and `strava-pending-rpe.json`.

### Files affected

| File | Change |
|------|--------|
| `skills/capture-activity-rpe/SKILL.md` | New skill: channel-reply RPE capture |
| `skills/set-rpe/SKILL.md` | New skill: manual and retroactive RPE entry |
| `skills/activity-deep-dive/SKILL.md` | Surface RPE and notes from `activity-notes.json` |
| `state-templates/compiled/routine-strava-sync.md` | Append RPE prompt after successful channel send |
| `state-templates/compiled/routine-weekly-load-review.md` | Append avg RPE summary when ≥2 entries present |
| `docs/knowledge-schema.md` | Document `activity-notes.json` and `strava-pending-rpe.json` shapes |
| `CLAUDE.md` | Memory conventions for new state files |
| `state-templates/CLAUDE-APPEND.md` | Fitness Workflow block updated with new state refs |

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Overwrite routine templates** — copy `state-templates/compiled/routine-strava-sync.md` and `state-templates/compiled/routine-weekly-load-review.md` from the plugin into `.claude-code-hermit/compiled/`. These are bot-owned prompts; overwriting is safe.
2. **Seed activity notes store** — create `.claude-code-hermit/state/activity-notes.json` as `{}` if the file does not exist.
3. **Update Fitness Workflow block** — in the project `CLAUDE.md`, between the `<!-- claude-code-fitness-hermit: Fitness Workflow -->` markers, append to the Conventions section:
   - `Subjective notes: state/activity-notes.json (written by capture-activity-rpe + set-rpe, read by activity-deep-dive + weekly-load-review)`
   - `Pending RPE: state/strava-pending-rpe.json (written by strava-sync after a successful channel send, read and deleted by capture-activity-rpe)`

No `config.json` changes required.

---

## [0.0.2] - 2026-05-03

### Changed

- **hatch: core hermit floor raised to ≥1.0.26** — prerequisite for docker-security overlay and recent hermit-evolve reliability fixes. Hatch now warns and stops if the installed core version is below `1.0.26`.
- **hatch: docker-security DNS allowlist** — added `strava.com` domain entry under a new `## Docker network requirements` section so `/claude-code-hermit:docker-security` can surface it when the operator enables LAN containment.

### Files affected

| File | Change |
|------|--------|
| `.claude-plugin/hermit-meta.json` | `required_core_version` and `requires` bumped to `>=1.0.26` |
| `.claude-plugin/plugin.json` | `dependencies.claude-code-hermit` bumped to `^1.0.26` |
| `skills/hatch/SKILL.md` | Version check floor raised to `1.0.26`; docker-security DNS block added |
| `CLAUDE.md` | Core version reference updated to `≥1.0.26` |
| `README.md` | Core version badge updated |

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Verify core hermit version** — run `/claude-code-hermit:hermit-doctor` and confirm it reports `claude-code-hermit ≥1.0.26`. If not, run `/claude-code-hermit:hermit-evolve` on the core plugin first.

No `config.json` changes required.

---

## [0.0.1] — 2026-04-28

### Added

- **Initial public release.**

### Upgrade Instructions

No previous version — first install; run `/claude-code-fitness-hermit:hatch`.
