# Changelog

All notable changes to this project will be documented in this file.

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
