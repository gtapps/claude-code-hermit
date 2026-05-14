# Changelog

All notable changes to this project will be documented in this file.

---

## [Unreleased]

### Added

- **capture-activity-rpe**: new fleet-owned skill that auto-triggers when the operator replies to a `strava-sync` channel notification with an RPE rating. Binds the RPE to the most-recently synced activity and persists to `state/activity-notes.json`. Channel-agnostic (Discord, Telegram, iMessage). Duplicates `channel-responder`'s `allowed_users` auth check since it auto-triggers outside that gate.
- **set-rpe**: new slash command for manual and retroactive RPE entry (`/claude-code-fitness-hermit:set-rpe <id|latest> <rpe> [notes]`). Primary escape hatch for non-latest activities, backfilling, and corrections.
- **strava-sync**: appends an RPE prompt to the daily channel summary. After a successful send, writes `state/strava-pending-rpe.json` with the latest synced activity for `capture-activity-rpe` to consume.
- **activity-deep-dive**: reads `state/activity-notes.json` for the analyzed activity (after ID resolution) and surfaces `Subjective: RPE N/10 — <notes>` in the output and compiled-artifact frontmatter when present.
- **weekly-load-review**: reads `state/activity-notes.json` for this week's activities and appends `💬 Avg RPE: X.X/10 (N=<count>)` to the channel summary when 2 or more entries exist.

### Upgrade Instructions

1. Overwrite `.claude-code-hermit/compiled/routine-strava-sync.md` and `.claude-code-hermit/compiled/routine-weekly-load-review.md` from this plugin's `state-templates/compiled/`. These are bot-owned routine prompts; it is safe to overwrite them.
2. Create `.claude-code-hermit/state/activity-notes.json` as `{}` if the file does not exist. (`strava-pending-rpe.json` is created on the next routine run — no manual seeding needed.)
3. In the `Fitness Workflow` block of the project's `CLAUDE.md` (between the `<!-- claude-code-fitness-hermit: Fitness Workflow -->` markers), append these two lines to the Conventions section:
   - `Subjective notes: state/activity-notes.json (written by capture-activity-rpe + set-rpe, read by activity-deep-dive + weekly-load-review)`
   - `Pending RPE: state/strava-pending-rpe.json (written by strava-sync after a successful channel send, read and deleted by capture-activity-rpe)`

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
