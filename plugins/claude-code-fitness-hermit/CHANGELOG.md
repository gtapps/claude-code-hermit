# Changelog

All notable changes to this project will be documented in this file.

---

## [0.0.5] - 2026-05-21

### Fixed

- **Duplicate Fitness block after core 1.1.1 target migration.** When an operator upgraded core hermit to 1.1.1 and chose `target = "local"`, core's `hermit-evolve` migrated its own block from `CLAUDE.md` to `CLAUDE.local.md` but the fitness-hermit block was left behind. The subsequent sibling-sync in `hermit-evolve` Step 7 found no marker in `CLAUDE.local.md` and appended a fresh Fitness block there, while the pre-existing block in `CLAUDE.md` was never removed — resulting in duplicate `<!-- claude-code-fitness-hermit: Fitness Workflow -->` blocks in both files. The Upgrade Instructions below run a one-shot migration via `hermit-evolve` Step 7 to remove the stray block.

### Changed

- **`/hatch` Step 6 is now target-aware (GH #111 follow-up).** Reads `.claude-code-hermit/state/hatch-options.json` written by core hatch and writes the CLAUDE-APPEND block to `CLAUDE.local.md` (when `target = "local"`) or `CLAUDE.md` (when `target = "committed"`). If core hatch hasn't run yet, the skill detects `core_install_scope` from `claude plugin list --json` and presents the scope-derived default at position 0 of the Visibility prompt, then stamps `hatch-options.json` with the canonical 5-field schema (`target`, `core_install_scope`, `stamped_at`, `stamped_by`, `version`). Step 6 preserves fitness-hermit's defer-to-evolve semantics: marker absent → append; marker present → skip (block replacement on upgrade is `hermit-evolve`'s job, not hatch's). The greenfield `target_file` missing case (`CLAUDE.local.md` not yet created) is handled explicitly. Stray-block migration is handled one-shot by the Upgrade Instructions below — hatch itself stays focused on target-aware setup.
- **Polish aligned with `claude-code-dev-hermit` PR #116 and `claude-code-homeassistant-hermit` PR #117.** Upgrade Instructions Step 3 is fully unattended — dropped the hand-edit detection / Carry-forward branch since `/hatch`'s single-source-of-truth contract already makes the marked block template-authoritative. Step 6 prose names both opening and closing markers explicitly, matching the closing-marker convention established in `claude-code-homeassistant-hermit` PR #117.

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

- **capture-activity-rpe**: new fleet-owned skill that captures RPE when the operator replies to a `strava-sync` channel notification. Self-triggers via skill description match (intentionally more specific than `claude-code-hermit:channel-responder`) while `state/strava-pending-rpe.json` is fresh. Re-checks `allowed_users` itself rather than relying on `channel-responder`'s gate. Binds the RPE to the most-recently synced activity and persists to `state/activity-notes.json`. Channel-agnostic (Discord, Telegram, iMessage).
- **set-rpe**: new slash command for manual and retroactive RPE entry (`/claude-code-fitness-hermit:set-rpe <id|latest> <rpe> [notes]`). Primary escape hatch for non-latest activities, backfilling, and corrections.
- **strava-sync**: appends an RPE prompt to the daily channel summary. After a successful send, writes `state/strava-pending-rpe.json` with the latest synced activity for `capture-activity-rpe` to consume.
- **activity-deep-dive**: reads `state/activity-notes.json` for the analyzed activity (after ID resolution) and surfaces `Subjective: RPE N/10 — <notes>` in the output and compiled-artifact frontmatter when present.
- **weekly-load-review**: reads `state/activity-notes.json` for this week's activities and appends `💬 Avg RPE: X.X/10 (N=<count>)` to the channel summary when 2 or more entries exist.
- **knowledge-schema.md**: documents the JSON shape of `activity-notes.json` and `strava-pending-rpe.json`, including the invariant that `notes` is always present (`null` when empty, never missing). Cross-skill consumers (`activity-deep-dive`, `weekly-load-review`) can rely on this.

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
