# Changelog

## [1.0.5] - 2026-04-16

### Fixed

- **`docker-entrypoint`: channel schema mismatch + silent marketplace failure** — The entrypoint was reading `channels` as a list but `config.json` stores it as an object (`{"discord": {"enabled": true, ...}}`). This was harmless for name extraction (iterating a dict yields keys) but `enabled: false` was never checked, so disabled channels still triggered MCP enablement and plugin install attempts. More critically, `claude plugin marketplace add anthropics/claude-plugins-official` was followed by `|| true`, swallowing failures silently and leaving channel/recommended plugin installs broken on the first boot with no diagnostic output. Fixed: channel extraction now reads the object shape and filters by `enabled`; marketplace add failure surfaces a clear `ERROR:` block and sets `NEEDS_OFFICIAL=false` to skip downstream install loops that would only produce noise.
- **`docker-entrypoint`: channel and recommended plugins installed but left disabled** — `claude plugin install` installs plugins in a disabled state by default. The entrypoint was not calling `claude plugin enable` after install, so channel and recommended plugins were present but dormant — their commands never registered. Fixed: `claude plugin enable` is now called immediately after each successful install for both channel plugins and recommended plugins.
- **`claude login` → `claude /login`** — The correct Claude Code CLI invocation for OAuth login is `claude /login`, not `claude login`. Updated everywhere: `hermit-docker` executable, `docker-entrypoint.hermit.sh.template` echo messages, `docker-setup/SKILL.md`, and all docs (`faq.md`, `troubleshooting.md`, `always-on.md`, `config-reference.md`, `architecture.md`, `hermit-start.py`).
- **`hermit-docker`: `_require_running` preflight for `attach`, `bash`, `login`, `restart`** — These subcommands now check that `$SERVICE` specifically is running (not just any service in the compose file) before attempting `docker compose exec`. If the container is down they print a clear `Container is not running. Start it first: .claude-code-hermit/bin/hermit-docker up` message instead of a raw Docker error.
- **`docker-setup` Step 8: container readiness gates** — Prevents the skill from issuing `docker exec` commands against a non-running container. Three gates added: (1) "No — manual" branch now prints a self-contained manual deployment guide and skips directly to Step 9 — Login, Workspace trust, and Channel pairing are not attempted when the container hasn't been started. (2) "Yes — build now" polls `docker compose ps --status running` for up to 10s after `hermit-docker up` and shows container logs for diagnosis if the service never appears. (3) Workspace trust and Channel pairing both gate on `tmux has-session` (30s retry) before issuing `tmux send-keys`, preventing the `no server running on /tmp/tmux-.../default` error when the entrypoint is still installing plugins.
- **`docker-setup` Step 8: `access.json` verification** — Channel pairing now checks `.claude.local/channels/<plugin>/access.json` after ~3s (one retry at ~8s) and falls through to `tmux capture-pane` diagnostics if absent, instead of silently declaring success after "a few seconds".
- **`docker-setup`: broken doc link** — `docs/recommended-plugins.md` link at the end of Step 7b fixed to `../../docs/recommended-plugins.md` (relative to the skill file).

### Changed

- **`hatch` completion message** — "Go always-on" step now leads with `docker-setup` (recommended) before the bare-tmux option. `smoke-test` moved to a troubleshooting note rather than a required step. `bypassPermissions` promoted to first option in the permissions question with a clearer description.

### Files affected

| File | Change |
|------|--------|
| `state-templates/bin/hermit-docker` | `_require_running` helper; `claude login` → `claude /login` |
| `state-templates/docker/docker-entrypoint.hermit.sh.template` | `claude login` → `claude /login` in echo messages and comment |
| `skills/docker-setup/SKILL.md` | Step 8 readiness gates; doc link fix; `claude login` → `claude /login` |
| `skills/hatch/SKILL.md` | Completion message reorder; permissions option order; formatting |
| `docs/faq.md` | `claude login` → `claude /login` |
| `docs/troubleshooting.md` | `claude login` → `claude /login` |
| `docs/always-on.md` | `claude login` → `claude /login` |
| `docs/config-reference.md` | `claude login` → `claude /login` |
| `docs/architecture.md` | `claude login` → `claude /login` |
| `scripts/hermit-start.py` | `claude login` → `claude /login` in comment |
| `README.md` | Restructured introduction and quick start |

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **`hermit-docker` script** — Copy updated `state-templates/bin/hermit-docker` to `.claude-code-hermit/bin/hermit-docker`. This picks up the `_require_running` helper and the `claude /login` fix.
2. **`docker-entrypoint.hermit.sh`** — If Docker is in use, patch the rendered entrypoint at the project root: replace `claude login` with `claude /login` (two echo lines in the timeout paths). This is a cosmetic fix; the container still works — it only affects the error message shown when the 10-minute credential wait times out.

No `config.json` changes required.

## [1.0.4] - 2026-04-16

### Fixed

- **`waiting_reason` field in `runtime.json`** — New field that records why a session entered `waiting` state: `"unclean_shutdown"`, `"dead_process"`, `"conservative_pickup"`, or `"operator_input"`. Cleared to `null` when exiting `waiting`. Fixes `channel-responder` routing: on unclean shutdown or dead process, an operator reply of `(1)` / `(2)` now correctly triggers archive-or-resume via `session-mgr` instead of being treated as a task instruction.
- **`session-mgr`: `session_id` written to SHELL.md on open** — Step 6 now patches the `**ID:**` placeholder in SHELL.md with the actual `S-NNN` value so the session header is correct from the first tick. Previously the placeholder persisted until close.
- **`session-mgr`: `cost_usd` reads `.status.json` first** — On session close, `cost_usd` is read from `.claude-code-hermit/sessions/.status.json` (written by the cost-tracker hook) before falling back to parsing the SHELL.md `## Cost` section. Fixes sessions where the hook-written cost was silently discarded.
- **`session-start`: fast-path gate patches SHELL.md ID placeholder** — When the fast path fires (no session-mgr spawn), if `runtime.json` has a `session_id` and SHELL.md still shows the `S-NNN` placeholder, it is updated in-context without spawning session-mgr.
- **`routine-watcher.sh`: drain stale queue entries on startup** — Entries older than 2 hours (one heartbeat cycle) are pruned from `routine-queue.json` at watcher start. Prevents phantom stale-routine alerts from accumulating across restarts.
- **`heartbeat`: micro-proposal pending alert** — New step 6 checks `micro-proposals.json` for pending tier-1 entries and appends a monitoring alert using semantic key `micro-proposal-pending:<id>`. Prevents tier-1 micro-proposals from silently expiring if the operator doesn't notice them. Stale queue alert message now includes elapsed time for clarity.

### Changed

- **`proposal-act`: accept no longer stamps `resolved_date`** — Accept flow now sets only `status: accepted` + `accepted_date`. `resolved_date` is set later by `reflect` when it confirms the pattern is actually gone (3 consecutive session reports with no recurrence). This fixes a semantic mismatch where `weekly-review.js`'s resolution count was always zero despite accepted proposals.
- **`reflect`: concrete Resolution Check procedure** — Added a bounded round-robin step (up to 5 accepted proposals per reflect cycle) that reads each proposal's evidence, scans the last 3 session reports, and marks resolved if the pattern is absent. Tracks round-robin position in `state/reflection-state.json` under `last_resolution_check`. Appends a `resolved` metrics event on each transition.
- **`reflection-judge`: explicit gate for `Sessions: none`** — Added a step 0 rule: if `Sessions: none` is passed, the judge immediately returns `SUPPRESS: <title> — no cross-session evidence cited`. No evidence verification or tier check is performed. `reflect` notes SUPPRESSED candidates in SHELL.md Findings for future revisit.
- **`proposal-create`: `created` events now include `source` and `category`** — The metrics payload for proposal creation now includes `source` (manual / auto-detected / operator-request) and `category` (improvement / routine / capability / constraint / bug). Adds `operator-request` and `bug` to enums (previously documented in `frontmatter-contract.md` but absent from the skill).
- **`generate-summary.js`: per-source acceptance rates and resolved count** — New metrics: auto-detected acceptance rate, manual acceptance rate, resolved proposal count. Frontmatter gains `proposals_resolved` and `auto_detect_accept_rate` fields. Allows answering "are autonomous proposals good?" for the first time.
- **`reflect`, `session-start`: notification routing de-duplicated** — The "Always-On Notification Rule" block (identical in both skills) replaced with a one-liner deferring to CLAUDE.md § Operator Notification. Single source of truth stays in `CLAUDE-APPEND.md`.
- **`reflect`: micro-proposal `question` text preserved in JSONL** — `micro-queued` events now include `question` (full text). The question is also stored in `micro-proposals.json` active slot so `channel-responder` and `brief` can echo it in `micro-resolved` events. Enables post-hoc analysis of what was asked and operator response patterns.
- **`heartbeat`: `noise_ticks` self-eval field** — Self-eval entries gain a `noise_ticks` counter incremented when an alert fires and is linked to a dismissed proposal (via `self_eval_key`). Lazy reset when a linked proposal is accepted or resolved. At 20+ noise ticks across 3+ sessions, creates a proposal to retune or remove the noisy check — mirrors the existing `clean_ticks` removal pathway.
- **`docs/frontmatter-contract.md`: lifecycle table updated** — `resolved_date` writer changed from `proposal-act` to `reflect skill (pattern absence)`.

### Files affected

| File | Change |
|------|--------|
| `agents/session-mgr.md` | `waiting_reason` field docs; `session_id` → SHELL.md on open; `cost_usd` reads `.status.json` first |
| `scripts/routine-watcher.sh` | Drain stale queue entries older than 2h on startup |
| `skills/channel-responder/SKILL.md` | Route `waiting_reason` for unclean shutdown / dead process replies |
| `skills/heartbeat/SKILL.md` | `micro-proposal-pending` alert key; step 6 micro-proposal check; `noise_ticks` self-eval field; stale queue message includes elapsed time; `waiting_reason` on NEXT-TASK.md conservative pickup |
| `skills/session-start/SKILL.md` | Set `waiting_reason` on unclean shutdown / dead process; fast-path patches SHELL.md ID; de-duplicate notification routing |
| `skills/proposal-act/SKILL.md` | Remove `resolved_date` stamp from accept flow |
| `skills/reflect/SKILL.md` | Add resolution check procedure; de-duplicate notification routing; preserve micro-proposal `question` in JSONL |
| `agents/reflection-judge.md` | Add explicit `Sessions: none` suppression gate |
| `skills/proposal-create/SKILL.md` | Add `source` and `category` to `created` metrics events |
| `scripts/generate-summary.js` | Per-source acceptance rates and resolved count |
| `docs/frontmatter-contract.md` | Update `resolved_date` lifecycle table |

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **No config.json changes required** — all changes are in skill/agent files.
2. **`state/reflection-state.json`** — if it exists and lacks a `last_resolution_check` key, no action needed; the resolution check procedure initializes it on first run.
3. **`state/alert-state.json` self_eval entries** — existing entries lack `noise_ticks`. The heartbeat self-eval step initializes missing fields as 0 on first read; no manual migration needed.
4. **Existing `proposal-metrics.jsonl` events** — old `created` events without `source`/`category` fields are handled by `generate-summary.js` bucketing them as `unknown`. No backfill required.
5. **Accepted proposals with `resolved_date` already set** — these were stamped at accept time under the old behavior. They may show a `resolved_date` even though `status` is `accepted`, not `resolved`. On first reflect run, the resolution check will re-evaluate them. If the pattern is gone, they'll be promoted to `resolved` (updating `resolved_date` to the current time). If not, `resolved_date` stays set but `status` remains `accepted` — a cosmetically odd but non-breaking state that will self-heal.

## [1.0.3] - 2026-04-16

### Added

- **`proposal-triage` agent (Haiku)** — pre-creation gate for the proposal pipeline. Deduplicates against existing PROP-NNN files and applies the three-condition rule before any proposal is queued. Called by both `proposal-create` and `reflect` (Tier 1/2 micro-approvals). Returns `CREATE | SUPPRESS:<reason> | DUPLICATE:<id>`.
- **`reflection-judge` agent (Sonnet)** — post-reflect validator that verifies cross-session evidence citations actually exist in S-NNN-REPORT.md before proposals or micro-approvals are queued. Returns `ACCEPT | DOWNGRADE:<tier> | SUPPRESS` per candidate. Prevents phantom proposals from reflect runs with weak or fabricated evidence.
- **`knowledge` skill** — read-only lint of `raw/` and `compiled/`. Flags stale, unreferenced, missing-type, and oversized artifacts with actionable advice. Delegates to `scripts/knowledge-lint.js`. Activates on "check knowledge", "lint knowledge", "knowledge health".
- **`scripts/knowledge-lint.js`** — shared lint module extracted from `weekly-review.js`. Called by the `knowledge` skill and imported by the weekly review script. Eliminates the duplicate inline logic that previously lived only in the weekly review.
- **Test infrastructure: `tests/run-all.sh`, `tests/lib.sh`, `tests/run-scripts.sh`** — unified test entry point running hook, contract, and script suites in sequence. Script suite covers `knowledge-lint.js`, `check-upgrade.sh`, `deny-patterns.json`, bin executability, and knowledge lint scenarios. `lib.sh` provides shared assertions for shell test scripts.

### Changed

- **`reflect`: evidence validation pipeline** — before acting on any proposal candidate, `reflect` now delegates to `claude-code-hermit:reflection-judge` to verify that cited sessions actually describe the claimed pattern. Only ACCEPT and DOWNGRADE verdicts proceed. Additionally, all Tier 1/2 candidates pass through `claude-code-hermit:proposal-triage` before micro-approval queuing. Tier 3 candidates also pass through triage before calling `proposal-create`.
- **`proposal-create`: pre-creation gate** — calls `claude-code-hermit:proposal-triage` before writing any file. Stops with a caller-facing message on DUPLICATE or SUPPRESS. Eliminates redundant proposals without requiring the operator to review them.
- **`pulse --full`** — new flag that appends infrastructure health sections after the session block: proposal counts by status, pending micro-proposals, routines on/off, last reflect/heartbeat timestamps, and knowledge file counts (`raw/`, `compiled/`, `raw/.archive/`).
- **`heartbeat`: IDLE-TASKS management** — when the operator asks about idle tasks (add, remove, manage), heartbeat now reads/writes `.claude-code-hermit/IDLE-TASKS.md` instead of HEARTBEAT.md. Creates the file from template if absent. Warns if `idle_behavior` is not `"discover"`.
- **`weekly-review.js`: simplified via shared lint** — knowledge health section now calls `knowledgeLint()` from `knowledge-lint.js` instead of duplicating the logic inline. Output format updated to per-finding lines with file, age, and reason.
- **`HEARTBEAT.md.template`: removed two redundant built-in checks** — "Check for NEXT-TASK.md" and "Check if current task has blocked items that may have resolved" are handled natively by the heartbeat skill. Removed to reduce LLM reasoning load per tick.
- **Test runner unified** — `tests/run-hooks.sh` refactored to use shared lib. All suites now accessible via `bash tests/run-all.sh`. Smoke-test-runner agent updated to use the unified entry point.
- **`CLAUDE.md` and `CLAUDE-APPEND.md`** — `proposal-triage` and `reflection-judge` added to agent listings. `/knowledge` added to CLAUDE-APPEND.md Quick Reference. Subagent section in CLAUDE-APPEND.md expanded with descriptions for all four agents.

### Files affected

| File | Change |
|------|--------|
| `agents/proposal-triage.md` | New agent |
| `agents/reflection-judge.md` | New agent |
| `skills/knowledge/SKILL.md` | New skill |
| `scripts/knowledge-lint.js` | New shared lint module |
| `tests/run-all.sh` | New unified test entry point |
| `tests/lib.sh` | New shared test assertions library |
| `tests/run-scripts.sh` | New script/static test suite |
| `tests/run-hooks.sh` | Refactored to use lib.sh |
| `skills/reflect/SKILL.md` | Evidence validation + triage gate |
| `skills/proposal-create/SKILL.md` | Pre-creation triage gate |
| `skills/pulse/SKILL.md` | `--full` infrastructure health flag |
| `skills/heartbeat/SKILL.md` | IDLE-TASKS management subcommand |
| `scripts/weekly-review.js` | Delegates knowledge lint to shared module |
| `state-templates/HEARTBEAT.md.template` | Removed redundant built-in check items |
| `state-templates/CLAUDE-APPEND.md` | Added `/knowledge`, agent descriptions |
| `CLAUDE.md` | Added proposal-triage and reflection-judge to agent list |
| `docs/skills.md` | knowledge skill entry; pulse --full documented |
| `docs/architecture.md` | Minor updates |
| `README.md` | Updated |
| `.claude/agents/smoke-test-runner.md` | Updated to use run-all.sh |
| `.claude/skills/test-run/SKILL.md` | Updated for unified test runner |
| `.claude/skills/release/SKILL.md` | Release process improvements |

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **CLAUDE-APPEND refresh** — refresh CLAUDE-APPEND.md to pick up `/knowledge` in Quick Reference and the updated Subagents section (replaces the old single-line `## Subagent: session-mgr` entry).
2. **No config.json changes required** — all new behavior is in skill/agent files.
3. **New agents are available immediately** — `proposal-triage` and `reflection-judge` ship with the plugin; no per-project action needed. Skills that call them (`reflect`, `proposal-create`) will use them automatically.

**Clean up HEARTBEAT.md (if applicable):**

1. Read `.claude-code-hermit/HEARTBEAT.md`. If the file does not exist, skip these steps.
2. Remove the line `- Check for NEXT-TASK.md` if present. Remove the line `- Check if current task has blocked items that may have resolved` if present.
3. After both removals, for each of `## Idle Checks` and `## Task Checks`: if the header now has no remaining checklist items beneath it, remove that header too.
4. If any changes were made, write the file back and report what was cleaned up. If nothing changed, skip silently.

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
