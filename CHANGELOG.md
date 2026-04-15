# Changelog

## [1.0.1] - 2026-04-15

### Fixed

- **State JSON files now copied from templates during hatch** — `alert-state.json`, `routine-queue.json`, and `micro-proposals.json` were previously created by the LLM writing inline JSON from memory. This could produce malformed content (e.g. `[]` instead of `{"queued": []}`) that silently broke routine queuing. They are now copied from canonical templates in `state-templates/`, matching the pattern used for all other hatch-created files.
- **Smoke-test now validates and repairs state file schema** — New step 6 checks all three schema-sensitive state files. If a file is missing, unparseable, or has the wrong shape, it is repaired (backfilling missing keys, overwriting wrong-type keys) without discarding existing data. Each repaired file emits a WARN.

### Added

- `state-templates/routine-queue.json.template` — canonical initial content `{"queued": []}`
- `state-templates/alert-state.json.template` — canonical initial content with `alerts`, `self_eval`, `total_ticks`, `last_digest_date`
- `state-templates/micro-proposals.json.template` — canonical initial content `{"active": null}`

### Files affected

| File | Change |
|------|--------|
| `state-templates/routine-queue.json.template` | New template |
| `state-templates/alert-state.json.template` | New template |
| `state-templates/micro-proposals.json.template` | New template |
| `skills/hatch/SKILL.md` | Copy 3 state files from templates instead of inline LLM JSON |
| `skills/smoke-test/SKILL.md` | Add step 6: state file validation and repair |

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **CLAUDE-APPEND refresh** — No changes to CLAUDE-APPEND.md in this release; refresh is not required.
2. **Template copy** — The three new `.template` files are only used during `hatch`. Existing hermit state files are not touched automatically; if you suspect a malformed state file, run `/claude-code-hermit:smoke-test` to detect and repair it.

No `config.json` changes required.

## [1.0.0] - 2026-04-14

Initial public release.
