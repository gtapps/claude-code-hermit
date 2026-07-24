# Changelog

## [Unreleased]

### Added
- `fitness-brief` skill — daily morning/evening brief (`--morning|--evening|--slot <name>`), composed in the operator's configured voice. Morning is forward-looking (readiness + today's plan); evening is backward-looking (today's training, or an earned-rest note, + tomorrow's setup) and absorbs `strava-sync`'s activity-sync/RPE/deep-dive mechanics.
- Two new routines, `morning-brief` and `evening-brief`, registered by `hatch`.

### Changed
- `strava-sync` and `strava-health-check` ship `enabled: false` by default on new hatches — `fitness-brief` now owns those daily beats. Both routines remain registered and independently callable; flip `enabled` back in `config.json` to run them standalone.

### Upgrade Instructions
For already-installed hermits, `hermit-evolve` should:
1. Copy `state-templates/compiled/routine-fitness-brief-morning.md` and `routine-fitness-brief-evening.md` into `.claude-code-hermit/compiled/` (skip if already present).
2. Add `morning-brief` and `evening-brief` to `config.json routines[]` (same entries as hatch Step 8b), `enabled: true`.
3. Set the existing `strava-sync` and `strava-health-check` routine entries to `enabled: false` — this is the one non-additive step; it consolidates the daily channel sends into the two new briefs and avoids a double notification. Both remain in `config.json` and fully callable on demand; the operator can flip `enabled` back to `true` at any time to restore standalone behavior.

## [0.0.15] - 2026-07-21

### Fixed
- No-op `Write(<path>)` rules are gone from `settings.json`; their `Edit(...)` equivalents already cover file-editing tools and avoid the boot warning.

## [0.0.14] - 2026-07-12

### Fixed
- `getAccessToken` now prefers the unexpired Strava MCP token in `~/.config/strava-mcp/config.json`, falling back to `.env`'s `STRAVA_ACCESS_TOKEN`.

## [0.0.13] - 2026-07-06

### Added
- Hatch Step 8d seeds `www.strava.com` in `autoMode.environment` through `scripts/automode-env.ts` for nightly `strava-sync` fetches.

## [0.0.12] - 2026-07-03

### Added
- `scripts/fitness-lab.ts` provides deterministic `analyze`, `weekly-load`, `weekly-patterns`, and `rpe` commands, reproducible Strava reductions, and hard auth-failure recovery.

### Changed
- `activity-deep-dive`, RPE, and coaching skills now delegate calculations to `fitness-lab.ts`; `strava-data-cruncher` falls back to MCP only for unsupported shapes.
- CLAUDE-APPEND now routes load analysis through `fitness-lab.ts`, with MCP stream and detail tools reserved for ad-hoc questions.
- Hatch Step 4 now offers to reuse an existing Strava MCP server instead of writing a duplicate `.mcp.json` entry.
- README references now use `/hermit-health` after the `hermit-brain` merge.
- `weekly-coaching-patterns` now invokes `reflect --scheduled-checks` after the scheduled-check runner merged into `reflect`.
- Reduced CLAUDE-APPEND from 5.3 KB to about 3.9 KB by removing catalog tables while retaining the all-time-totals guidance.

### Fixed
- `weekly-load` now propagates the exit-1 `strava_auth` recovery signal for `/athlete/zones` 401s instead of degrading zone load.
- `weekly-load --weeks` now rejects non-positive values, and `analyze` fetches activity details within its batch.

### Upgrade Instructions
- No manual steps. The Fitness CLAUDE-APPEND block is synced automatically via `hermit-evolve` Step 7's sibling-upgrade flow when this version's gap is processed.

## [0.0.11] - 2026-06-29

### Changed
- `strava-data-cruncher` no longer sets `maxTurns`; its internal 30-API-call governor remains the limit.

## [0.0.10] - 2026-06-24

### Fixed
- Hatch now writes a state marker before core delegation so the core terminus resumes the domain skill automatically.

## [0.0.9] - 2026-06-23

### Fixed

- Hatch Step 1 now prints its re-run instruction before terminal core invocation so subsequent steps are not dropped.

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Refresh the fitness hermit plugin** — `/claude-code-hermit:hermit-evolve` pulls the updated skill.

No `config.json` changes required.

## [0.0.8] - 2026-06-12

### Changed

- Tests now use Bun and TypeScript, including the test runner and domain-brainstorm inline evaluation.
- `strava-data-cruncher` now uses the forward-compatible `haiku` model alias.
- Raised the core dependency floor to `>=1.2.0`.

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Verify core version** — confirm the installed `claude-code-hermit` core is >=1.2.0. If not, run `claude plugin update claude-code-hermit` first.

No `config.json` changes required.

---

## [0.0.7] - 2026-06-04

### Added

- `strava-sync` and `weekly-load-review` now surface strength-session recovery signals and persist `strength_minutes` to `strava-weekly-baselines.json`.
- An on-demand `domain-brainstorm` skill now surfaces up to two Strava-backed training coverage or imbalance proposals.
- Training-history facts now require full-history Strava queries rather than memory; recent-activity questions are unchanged.
- `activity-deep-dive` now supports trail running with terrain-aware metrics, observations, recovery windows, and artifact frontmatter.

### Changed

- `routine-weekly-load-review` now uses elevation-weighted `adjusted_km` for load flags while retaining raw-distance output.
- Raised the core dependency floor to `>=1.1.9`.

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Sync the CLAUDE-APPEND block** — Step 7 re-appends the updated canonical block to the hatch target, adding `domain-brainstorm` to the quick-reference skills table and the new Fitness Proposal Categories section.
2. **Overwrite the routine template** — copy `state-templates/compiled/routine-weekly-load-review.md` from the plugin into `.claude-code-hermit/compiled/` so the weekly review picks up load-adjusted distance. This is a bot-owned prompt; overwriting is safe.

No `config.json` changes required.

---

## [0.0.6] - 2026-05-31

### Added

- A weekly `weekly-coaching-patterns` check now detects four-session rising cardiac-drift trends through `reflect-scheduled-checks`.
- `strava-sync` now triggers coaching deep dives for up to three new runs and logs non-retried failures.
- `activity-deep-dive` now reports cadence, coefficient of variation, and over-striding or variability flags for runs.

### Changed

- `capture-activity-rpe` now reruns `activity-deep-dive` for `Run` activities so artifacts include RPE.
- `activity-deep-dive` now identifies interval and steady-state sessions, recording `session_kind` with tailored metrics.
- `activity-deep-dive` now appends deduplicated labeled coaching observations to `SHELL.md` findings.

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Sync the CLAUDE-APPEND block** — Step 7 re-appends the updated canonical block to the hatch target, adding `weekly-coaching-patterns` to the quick-reference skills table.

No `config.json` changes required.

---

## [0.0.5] - 2026-05-21

### Fixed

- Removed duplicate Fitness blocks left in `CLAUDE.md` after the core 1.1.1 target migration.

### Changed

- Hatch Step 6 now writes the CLAUDE-APPEND block to the target selected in `hatch-options.json`.
- Upgrade Instructions Step 3 now runs unattended because marked blocks are template-authoritative.

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill executes the following steps automatically (via Step 7's sibling upgrade flow, which runs every plugin's `### Upgrade Instructions` before its CLAUDE-APPEND sync). The migration is unattended — no operator prompts. `hermit-evolve` Step 7 re-syncs the canonical block to `hatch_target` afterwards.

1. **Resolve `hatch_target`.** Use the same fallback chain `hermit-evolve` Step 2a uses, substituting the Fitness marker: read `.claude-code-hermit/state/hatch-options.json` and use the `"target"` field; else check `CLAUDE.local.md` for `<!-- claude-code-fitness-hermit: Fitness Workflow -->` → `hatch_target = "local"`; else check `CLAUDE.md` for the same marker → `hatch_target = "committed"`; else stop — the Fitness block is in neither file, nothing to migrate.

2. **Identify the non-target file.** `non_target = (hatch_target == "local") ? "CLAUDE.md" : "CLAUDE.local.md"`.

3. **If the marker is present in `non_target`, silently strip the marked block** (everything from the opening `<!-- claude-code-fitness-hermit: Fitness Workflow -->` through the matching closing `<!-- /claude-code-fitness-hermit: Fitness Workflow -->`, inclusive). Per `/hatch`'s single-source-of-truth contract, the CLAUDE-APPEND template is authoritative and operator overrides belong outside the marked block, so no hand-edit preservation is needed. Step 7's sync re-appends the canonical block to `hatch_target` afterwards.

4. **If the marker is only in `hatch_target`:** no-op. Steady state — Step 7's normal sync handles routine version-bump replacement.

No `config.json` changes required.

## [0.0.4] - 2026-05-21

### Changed

- Raised the core dependency floor to `>=1.1.1`.
- README now lists `capture-activity-rpe` and `set-rpe` in its skills overview and features.
- Raised the minimum tested Claude Code version to v2.1.140+.

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Verify core version** — confirm the installed `claude-code-hermit` core is >=1.1.1. If not, run `claude plugin update claude-code-hermit` first.

No `config.json` changes required.

---

## [0.0.3] - 2026-05-14

### Added

- `capture-activity-rpe` now captures channel-reply RPE in `activity-notes.json`.
- `/claude-code-fitness-hermit:set-rpe` now supports manual and retroactive RPE entry.
- `strava-sync` now writes `strava-pending-rpe.json` and adds an RPE prompt to daily summaries.
- `activity-deep-dive` now includes subjective RPE notes in output and compiled artifact frontmatter.
- `weekly-load-review` now adds an average RPE summary when the week has at least two activity notes.
- Added `knowledge-schema.md` documentation for `activity-notes.json` and `strava-pending-rpe.json`.

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

- Raised the core dependency floor to `>=1.0.26`; Hatch now warns and stops on older installations.
- Added `strava.com` to Docker network requirements for `/claude-code-hermit:docker-security`.

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Verify core hermit version** — run `/claude-code-hermit:hermit-doctor` and confirm it reports `claude-code-hermit ≥1.0.26`. If not, run `/claude-code-hermit:hermit-evolve` on the core plugin first.

No `config.json` changes required.

---

## [0.0.1] — 2026-04-28

### Added

- Initial public release.

### Upgrade Instructions

No previous version — first install; run `/claude-code-fitness-hermit:hatch`.
