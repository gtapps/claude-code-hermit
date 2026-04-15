# Changelog

## [1.0.2] - 2026-04-15

### Fixed

- **Fully qualified agent/skill names enforced throughout skill instructions** — Bare names (e.g., `:session-mgr`) were silently misrouted by the harness. All skill instruction files now use the canonical `claude-code-hermit:<name>` form. Affects every skill that spawns a subagent or invokes another skill.
- **session-mgr: null `session_id` fallback on runtime.json write** — If `session_id` was null or missing when setting `session_state` to `in_progress`, the session would archive under `S-null`. Step 7 now pre-computes the ID in the same write if it wasn't set in step 6.
- **session-mgr: invocation payload takes precedence over stale SHELL.md** — On both close and idle-transition, if the caller passes structured task data (status, blockers, lessons, changed files), those values are used directly instead of re-reading potentially stale SHELL.md fields.

### Changed

- **session-start: fast-path gate skips session-mgr on normal startup** — When `runtime.json` is healthy (`session_state` ∈ {`in_progress`, `idle`, `waiting`}, no transition, no last_error) and SHELL.md exists, session-mgr is not spawned. SHELL.md content is already injected by the startup hook. This eliminates a full agent spawn on every normal session start.
- **session / session-close: compile final data in-context before handing off to session-mgr** — Callers now gather status, blockers, lessons, and changed files in-context and pass a compact structured payload to session-mgr. This removes the previous pattern where session-mgr had to re-read SHELL.md fields that the caller already knew, and prevents stale reads from overwriting in-context data.
- **session-mgr: maxTurns reduced from 15 to 12** — Consistent with actual observed turn counts; the previous ceiling was never reached.
- **hermit-settings: improved guidance** — Clearer instructions for configuring hermit behavior.

### Files affected

| File | Change |
|------|--------|
| `agents/session-mgr.md` | maxTurns 15→12; null session_id fallback; payload-precedence rule on close/idle |
| `skills/session-start/SKILL.md` | Fast-path gate: skip session-mgr when runtime state is clean |
| `skills/session/SKILL.md` | Compile final data in-context; structured compact payload to session-mgr |
| `skills/session-close/SKILL.md` | Compile final data in-context; structured compact payload to session-mgr |
| `skills/hermit-settings/SKILL.md` | Improved configuration guidance |
| All skill/agent instruction files | Bare agent/skill names replaced with fully qualified `claude-code-hermit:` form |

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **CLAUDE-APPEND refresh** — No changes to CLAUDE-APPEND.md in this release; refresh is not required.
2. **No template changes** — State templates and `config.json` are unchanged.
3. **Behavioral changes are in skill/agent instruction files only** — These take effect immediately via the plugin; no per-project migration needed.

No `config.json` changes required.

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
