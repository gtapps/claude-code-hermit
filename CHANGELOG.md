# Changelog

## [0.3.15] - 2026-04-12

### Added

- **Personal git tracking mode** — Hermits can now use git as their versioned personal backup. Set `git_tracking: "personal"` in config.json (or answer the new hatch question) to track sessions, proposals, config, obsidian, and all hermit state in git. Migration becomes `git clone` + machine-specific adjustments — no manifest or rsync needed. Default `"private"` preserves existing behavior for team/shared repos.
- **`GITIGNORE-APPEND-PERSONAL.txt`** — Minimal gitignore template for personal mode: only excludes `.env`/`.env.*`. Everything else is tracked.
- **Credential scan in `hermit-migrate`** — In personal mode, the skill scans for unprotected credentials (file-name patterns: `*.pem`, `*.key`, `id_rsa`, SSH keys, credential JSON; content patterns: `API_KEY=`, `TOKEN=`, `SECRET=`, `PASSWORD=`, channel tokens in `.claude.local/`) and proposes gitignore additions to the operator. Advisory only — never writes `.gitignore` automatically.

### Changed

- **`hatch` wizard Phase 6** — New "Git tracking" question added to the deployment batch. Answer "Personal" to opt into git-tracked hermit state. `git_tracking` is recorded in `config.json`.
- **`hermit-migrate` personal mode workflow** — Detects personal mode from `.gitignore` (absence of `.claude-code-hermit/sessions/` pattern). In personal mode: skips file classification steps (hermit state is already in git), runs credential scan instead, produces a simplified 5-step migration path.
- **`hermit-migrate` `.claude/` scoping fix** — The skill previously described `.claude/` as machine-local. Corrected: `.claude/` is project-scoped and migrates with `git clone`. `.claude.local/` is machine/user-scoped and must be recreated on destination. All references updated throughout.

### Files affected

| File | Change |
|------|--------|
| `state-templates/GITIGNORE-APPEND-PERSONAL.txt` | New — minimal gitignore for personal mode |
| `skills/hatch/SKILL.md` | Added git tracking question to Phase 6; conditional template selection in step 7; `git_tracking` in config.json template |
| `skills/hermit-migrate/SKILL.md` | Personal mode detection, credential scan step, dual output format, batch git commands, `.claude/` vs `.claude.local/` scoping fix |
| `docs/config-reference.md` | Added `git_tracking` field |
| `skills/hermit-evolve/SKILL.md` | Added `git_tracking` row to key table |

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Config update** — Adds `git_tracking: "private"` to `config.json` silently. Default `"private"` preserves existing gitignore behavior exactly — no files will be unignored for existing hermits.

No CLAUDE-APPEND changes. No template changes. No manual steps required.

## [0.3.14] - 2026-04-12

### Added

- **`hermit-migrate` skill** — A Git-first migration audit skill for moving a hermit-backed repo between machines. Inspects the repo, classifies ignored files into MUST_MIGRATE / DO_NOT_MIGRATE / REVIEW_MANUALLY, provides a dedicated hermit state assessment (including field-level config.json analysis), identifies bootstrap gaps, and produces a `migration-manifest.txt` with a verification checklist. Read-only by default.
- **`/watch` skill** — New skill wrapping the Claude Code Monitor tool for background watching. Replaces the old `/monitor` skill (which used `/loop`). Zero token cost when quiet — only stdout lines trigger conversation notifications. Supports declared config-driven watches (auto-registered at session start) and ad-hoc operator-driven watches (`/watch <instruction>`). Subcommands: `watch <instruction>`, `watch start`, `watch stop [id]`, `watch stop --all`, `watch status`.
- **`config.json` `monitors` key** — Optional array of declared watch definitions. Each entry has: `id` (unique), `description`, `command` (supports `${CLAUDE_PLUGIN_ROOT}` resolved at registration time), `persistent`, `enabled`, `class` (`"stream"` or `"poll"`, documentation label), optional `timeout_ms`. Not a required key — backward compatible.
- **`state/monitors.runtime.json`** — Runtime registry, sole source of truth for active watches. Cleared unconditionally on every session start (watches are session-scoped). Fields: `id`, `task_id` (CC task ID for TaskStop), `description`, `started_at`, `source` (`config` or `adhoc`), `class`.

### Changed

- **Migration documentation** — Added "How do I move my hermit to another machine?" to `docs/faq.md` and a "Moving to a new host" section to `docs/always-on.md` (Docker-specific steps with named volume gotcha). Added a dedicated Migration section to `docs/skills.md`.
- **`state_dir` now supports relative paths** — `hermit-start.py` resolves relative `channels.<name>.state_dir` values against the project root at boot. Absolute paths continue to work unchanged. `hatch` and `hermit-settings` now write `.claude.local/channels/<name>` (relative) instead of the full host path, making fresh `config.json` files portable across machines and clones. `hermit-migrate` no longer classifies `state_dir` as machine-specific when it contains a relative path.
- **`/monitor` skill renamed to `/watch`** — Avoids naming overlap with Claude Code's native Monitor tool. Update any config or OPERATOR.md references from `/claude-code-hermit:monitor` to `/claude-code-hermit:watch`. `hermit-evolve` handles the CLAUDE-APPEND update.
- **Session start** — Step 3b clears the watch registry unconditionally on every start (new, resume, crash recovery). Step 11b registers enabled config monitors after the session task is known.
- **Session close** — Stops all active watches before archiving (same pattern as heartbeat stop).
- **Config validation** — `validate-config.js` validates the optional `monitors` key: unique `id`, required `description` and `command`, type checks for `persistent`, `enabled`, `class`, `timeout_ms`. Wrong-typed monitors key (non-array) now emits an error rather than silently skipping. `validate` is now exported for direct unit-test access.
- **Monitors validation test coverage** — `TestMonitorsValidation` in `run-contracts.py` covers all monitors error and warning paths: non-array type, missing `id`, duplicate `id`, invalid `class`, `timeout_ms < 1000`, and missing required fields (`description`, `command`).
- **`hermit-evolve`** — Adds `monitors: []` silently on upgrade (non-interactive, default `[]`).

### Files affected

| File | Change |
|------|--------|
| `skills/hermit-migrate/SKILL.md` | New skill |
| `skills/watch/SKILL.md` | New skill (renamed + full rewrite from `/loop` to Monitor tool) |
| `skills/monitor/SKILL.md` | Deleted (superseded by `watch`) |
| `state-templates/CLAUDE-APPEND.md` | Added `/hermit-migrate` to quick reference; added `monitors.runtime.json` row, Watches section, `/watch` to quick reference |
| `CLAUDE.md` | Added `hermit-migrate`; updated `monitor` → `watch` in skill list |
| `docs/skills.md` | Added Migration section |
| `docs/faq.md` | Added migration FAQ entry; updated heartbeat/watch FAQ entry |
| `docs/always-on.md` | Added "Moving to a new host" section |
| `docs/always-on-ops.md` | Added Monitors comparison table and hybrid model note |
| `docs/troubleshooting.md` | Updated `/monitor stop` → `/watch stop` reference |
| `scripts/hermit-start.py` | `write_settings_env()`: expand relative `state_dir` to absolute via `Path.cwd()` before writing to `settings.local.json` |
| `scripts/validate-config.js` | Added monitors validation block; exported `validate` for unit testing |
| `skills/hatch/SKILL.md` | Write relative path in `channels.<name>.state_dir` instead of absolute |
| `skills/docker-setup/SKILL.md` | Match hatch — instruct relative path for `state_dir` |
| `skills/hermit-settings/SKILL.md` | Default to relative path in add-channel flow |
| `skills/hermit-migrate/SKILL.md` | `state_dir` is portable when relative; legacy absolute still machine-specific |
| `skills/hermit-evolve/SKILL.md` | Added `monitors` row to key table (`0.3.14`, default `[]`) |
| `skills/session-start/SKILL.md` | Added step 3b (unconditional registry clear) and step 11b (watch registration) |
| `skills/session-close/SKILL.md` | Added pre-step directive to stop all watches before archiving |
| `skills/heartbeat/SKILL.md` | Updated "Relationship to /monitor" → "Relationship to /watch" table |
| `skills/session/SKILL.md` | Updated reference to `/claude-code-hermit:watch` |
| `agents/hermit-config-validator.md` | Added "### 7. Monitor validation" section |
| `state-templates/config.json.template` | Added `"monitors": []` after routines |
| `docs/config-reference.md` | Updated `state_dir` description and examples |
| `tests/run-contracts.py` | Added `test_state_dir_relative_expanded`; added `TestMonitorsValidation` (7 cases) |

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **CLAUDE-APPEND refresh** — Adds `/hermit-migrate` to the quick reference line, `monitors.runtime.json` to the Agent State table, Watches guidance section, and `/watch` to the quick reference.
2. **Config update** — Adds `monitors: []` to `config.json` (non-interactive).
3. **Rename** — If your OPERATOR.md or any scripts reference `/claude-code-hermit:monitor`, update them to `/claude-code-hermit:watch`.

Existing absolute `state_dir` values in `config.json` continue to work. To make your config portable, optionally replace the machine-specific prefix with a relative path:

```json
"state_dir": ".claude.local/channels/discord"
```

Hermit will expand it to absolute on next boot.

**Worth considering:** If you've been using `/loop` for monitoring tasks (watching log files, polling endpoints, checking build status), `/watch` is now the better tool — zero token cost when quiet, no LLM evaluation per tick. Routines that fire on a fixed interval just to check something event-driven are also candidates. Heartbeat and scheduled routines stay as-is.

## [0.3.13] - 2026-04-09

### Fixed

- **AGENT_HOOK_PROFILE leaked from Docker container to host** — `hermit-start.py` wrote `AGENT_HOOK_PROFILE` to `.claude/settings.local.json`, which lives on the bind-mounted project directory. The host-side Claude Code read the same file, inheriting `strict` profile and blocking docker/ssh/kubectl commands. The profile is now set as a process environment variable instead: forwarded via tmux env file (host) or docker-compose `environment:` block (container). `settings.local.json` no longer contains `AGENT_HOOK_PROFILE`. Existing entries are automatically removed on next boot (migration).

### Changed

- **Docker-compose template includes `AGENT_HOOK_PROFILE`** — new `{{AGENT_HOOK_PROFILE}}` placeholder in `docker-compose.hermit.yml.template`. Docker-setup renders `strict` into the compose environment block instead of writing to `config.json` `env`. This keeps the profile container-scoped.

- **`hermit-start.py` forwards `AGENT_HOOK_PROFILE` via tmux env** — added to `forward_vars` alongside `CLAUDE_CONFIG_DIR` and `ANTHROPIC_API_KEY`. The tmux session inherits the profile; interactive host sessions don't.

### Files affected

| File | Change |
|------|--------|
| `scripts/hermit-start.py` | `write_settings_env()` pops profile from env dict, sets via `os.environ.setdefault()`, removes stale entries (migration); added to `forward_vars` |
| `state-templates/docker/docker-compose.hermit.yml.template` | Added `AGENT_HOOK_PROFILE={{AGENT_HOOK_PROFILE}}` to environment block |
| `skills/docker-setup/SKILL.md` | Step 3: no longer writes profile to config.json env; step 4: documents new placeholder |
| `tests/run-contracts.py` | Profile tests now verify `os.environ` instead of `settings.local.json`; added migration test; tearDown cleans env |

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **No CLAUDE-APPEND refresh needed** — no changes to session discipline or rules.
2. **No config.json changes required** — `AGENT_HOOK_PROFILE` stays in config.json `env` as before (it's the source of truth for the value). The change is where `hermit-start.py` writes it at boot — process env instead of settings.local.json.

**Manual steps for Docker users:**
- Regenerate `docker-compose.hermit.yml` by re-running `/claude-code-hermit:docker-setup` (or manually add `- AGENT_HOOK_PROFILE=strict` to the `environment:` section).
- After the next `hermit-start`, `AGENT_HOOK_PROFILE` will be automatically removed from `.claude/settings.local.json`.

## [0.3.12] - 2026-04-09

### Fixed

- **`always_on` deny patterns blocked docker on the host** — `enforce-deny-patterns.js` loaded both `default` and `always_on` pattern sets unconditionally, causing `Bash(docker *)` to block docker-setup commands on the host. The `always_on` set now only applies when `AGENT_HOOK_PROFILE=strict` (set by hermit-start in Docker/tmux). Host interactive sessions run with `standard` or unset profile, so docker, ssh, and kubectl commands work normally.

- **docker-setup self-blocking** — docker-setup step 6 wrote the full `always_on` deny set (including `Bash(docker *)`) to `.claude/settings.json` `permissions.deny`, then needed docker commands in steps 8–9. Now writes only the `default` set to settings.json; container-specific rules are enforced by the hook at runtime via the strict profile.

- **OPERATOR.md check too broad** — the hardcoded OPERATOR.md block in `enforce-deny-patterns.js` used `includes('OPERATOR.md')`, matching any file named OPERATOR.md anywhere in the project. Removed the hardcoded check entirely; OPERATOR.md protection is now handled via `deny-patterns.json` entries.

- **Test workdir missing OPERATOR.md** — `setup_workdir` in `run-hooks.sh` now creates `OPERATOR.md` in the state directory, matching post-hatch state. The OPERATOR.md block test was silently broken (file didn't exist, so `fs.existsSync` allowed it through).

### Added

- **Settings file protection** — `deny-patterns.json` `always_on` set now includes `Edit`/`Write`/Bash-redirect deny rules for `.claude/settings.json` and `.claude/settings.local.json`. Prevents the agent from modifying its own permissions in always-on mode.

- **OPERATOR.md Bash redirect protection** — `deny-patterns.json` `default` set now includes `Bash(*> *.claude-code-hermit/OPERATOR.md*)` to block shell redirect writes in all modes.

- **OPERATOR.md Edit/Write in `always_on` set** — `deny-patterns.json` `always_on` set now includes `Edit(*.claude-code-hermit/OPERATOR.md)` and `Write(*.claude-code-hermit/OPERATOR.md)`. In always-on mode (strict profile), the agent cannot touch OPERATOR.md at all. In interactive sessions, Edit/Write are allowed so the hermit can draft changes and confirm with the operator before applying.

### Changed

- **OPERATOR.md: draft+confirm in interactive, hard-blocked in always-on** — CLAUDE.md, CLAUDE-APPEND.md, and the OPERATOR.md template now describe a two-mode approach. In interactive sessions, the hermit drafts the minimal change, shows a diff, and applies only after the operator confirms. In always-on mode, the hermit flags stale context via channel instead — the operator edits directly. Previously the agent was unconditionally blocked from editing OPERATOR.md.

- **Hardcoded OPERATOR.md check removed from hook** — `enforce-deny-patterns.js` no longer has a hardcoded `fs.existsSync` check for OPERATOR.md. All OPERATOR.md protection now flows through `deny-patterns.json` entries, making the enforcement visible and configurable.

- **Hatch deny patterns no longer include OPERATOR.md** — removed `Edit/Write(**/.claude-code-hermit/OPERATOR.md)` from both minimal and hardened deny sets in hatch step 9. OPERATOR.md protection is now enforced by the hook via `deny-patterns.json` `always_on` set (active only in strict profile), not by settings.json deny rules.

### Files affected

| File | Change |
|------|--------|
| `scripts/enforce-deny-patterns.js` | `always_on` conditional on strict profile; removed hardcoded OPERATOR.md check; updated JSDoc |
| `state-templates/deny-patterns.json` | Added OPERATOR.md bash redirect to `default`; added OPERATOR.md Edit/Write + settings.json protection to `always_on` |
| `skills/docker-setup/SKILL.md` | Step 6 writes only `default` deny set, not `always_on` |
| `skills/hatch/SKILL.md` | Removed OPERATOR.md from both deny pattern sets |
| `state-templates/CLAUDE-APPEND.md` | OPERATOR.md draft+confirm rule in Agent State table and Rules section |
| `state-templates/OPERATOR.md` | Template comment updated: draft+confirm workflow |
| `CLAUDE.md` | OPERATOR.md descriptions updated (both occurrences) |
| `hooks/hooks.json` | Updated hook description |
| `tests/run-hooks.sh` | `setup_workdir` creates OPERATOR.md; test covers both creation and blocking paths |

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Refresh CLAUDE-APPEND block** — the session discipline block in the target project's CLAUDE.md needs updating (OPERATOR.md rule now describes draft+confirm workflow in interactive mode, updated Agent State table entry).
2. **Update deny-patterns.json** — already updated in the plugin itself; no per-project action needed (the hook reads from the plugin directory).

**Manual steps for Docker users:**
- If you chose "hardened" deny rules during hatch, your `.claude/settings.json` `permissions.deny` may contain `Bash(docker *)`, `Bash(ssh *)`, `Bash(kubectl *)`, `Edit(**/.claude-code-hermit/OPERATOR.md)`, `Write(**/.claude-code-hermit/OPERATOR.md)`. These are now redundant (enforced by the hook). You can remove them from settings.json, but leaving them causes no harm — they just double-enforce.
- If docker-setup was previously blocked, re-run `/claude-code-hermit:docker-setup` after updating.

No config.json changes required.

## [0.3.11] - 2026-04-08

### Added

- **`scripts/stop-pipeline.js`** — unified Stop hook that orchestrates all five stop-time stages (cost-tracker, suggest-compact, session-diff, evaluate-session, routine-queue-flush) in a single Node process. Eliminates five separate hook entries; only `suggest-compact` output reaches stdout (Claude Code parses it for `additionalContext`), everything else goes to stderr. Heartbeat is written unconditionally as the final step, so liveness detection survives any stage failure.

- **`scripts/startup-context.js`** — replaces the 300-char inline bash blob in the SessionStart hook with a priority-ordered, budget-capped context injector. Emits Operator context (2000 chars), active session summary (Task + last 10 progress entries + Blockers + Monitoring, 3000 chars), session cost (500 chars), last report overview (1500 chars), and upgrade check (500 chars), with a hard 8000-char total cap. Lower-priority sections are dropped, not truncated, when the cap is reached.

- **Idle task provenance tracking** — `skills/heartbeat/SKILL.md` now instructs the heartbeat to record `idle_task` (text, line number, picked_at) in `state/runtime.json` before starting an idle session. `agents/session-mgr.md` handles the `[x]` checkoff atomically during the idle transition (step 8), so the checkoff is always paired with the archive rather than happening in the heartbeat skill mid-session.

### Changed

- **Hook consolidation** — `hooks/hooks.json` trimmed from 8 PostToolUse/Stop entries to 3. Removed the per-tool-call heartbeat touch hook (moved into stop-pipeline). Removed five separate Stop hooks (cost-tracker, suggest-compact, session-diff, evaluate-session, routine-queue-flush); replaced with a single `stop-pipeline.js` call. Contract tests gate now requires `HERMIT_DEV_MODE=1` and `CLAUDE_PLUGIN_ROOT` to be set, preventing spurious test runs in target projects.

- **`scripts/session-diff.js`** — added state-aware debounce to `run()`: skips if the sidecar is less than 60 seconds old and `session_state` is `in_progress`; forces a refresh when the state is `idle` or transitioning (session-close reads the sidecar immediately after). Standalone invocation bypasses debounce as before.

- **`scripts/routine-queue-flush.js`** — extracted `_flush()` synchronous core; `run()` exported for pipeline use. Also fixed queue shape handling: now accepts both bare array (`[...]`) and object with `queued` key (`{"queued": [...]}`) — matching the actual producer format.

### Fixed

- **`startup-context.js` emit off-by-one** — `available` calculation now subtracts 1 for the trailing newline, preventing a 1-char overshoot at the hard cap boundary.
- **`startup-context.js` module-level mutable state** — `totalChars` and `emit()` are now local to `main()`, preventing stale counter state if the module is ever required by another script.
- **`cost-tracker.js` redundant heartbeat write** — `touchHeartbeat()` was called inside `run()` (pipeline path) even though `stop-pipeline.js` writes the heartbeat unconditionally after all stages. Moved to standalone path only.
- **`startup-context.js` execSync timeouts** — tightened from 5 s / 10 s to 2 s / 5 s for `read-cost.py` / `check-upgrade.sh`. These are low-priority sections; a 10 s startup block was unacceptable.

- **`scripts/hermit-start.py` Chrome support** — added `chrome` key to `DEFAULT_CONFIG` (`false` by default) and `build_claude_command()` now appends `--chrome` when `chrome: true` is set in `config.json`. Includes a container guard: the flag is silently skipped with a warning when `is_container()` is true, since Chrome requires a running browser with a native messaging host that cannot exist in a headless container. Chrome status is printed at launch alongside remote/permissions. Note: enabling `--chrome` increases context usage because browser tools are always loaded; for interactive sessions the native `/chrome` → "Enabled by default" setting is equivalent and avoids touching `config.json`.

### Files affected

| File | Change |
|------|--------|
| `scripts/hermit-start.py` | `chrome: false` in DEFAULT_CONFIG; `--chrome` flag with container guard in `build_claude_command()`; chrome status in launch output |
| `scripts/stop-pipeline.js` | New — unified Stop hook pipeline |
| `scripts/startup-context.js` | New — priority-ordered startup context injector |
| `hooks/hooks.json` | Removed per-tool heartbeat + 5 separate Stop hooks; added startup-context and stop-pipeline |
| `scripts/cost-tracker.js` | Exported `run()`; `touchHeartbeat()` moved to standalone block |
| `scripts/evaluate-session.js` | Exported `run()`; core extracted to `_evaluate()` |
| `scripts/routine-queue-flush.js` | Exported `run()`; extracted `_flush()`; fixed `{queued:[...]}` shape |
| `scripts/session-diff.js` | Exported `run()`; added state-aware debounce |
| `scripts/suggest-compact.js` | Exported `run()`; stdin reading moved to standalone block |
| `skills/heartbeat/SKILL.md` | Idle task provenance: record `idle_task` in runtime.json before session start |
| `agents/session-mgr.md` | Idle transition step 8: atomic idle-task checkoff from runtime.json |
| `tests/run-hooks.sh` | New tests: stop-pipeline (3), session-diff debounce (3), startup-context (4), routine bare-array compat (1) |

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **CLAUDE-APPEND refresh** — no content changes to CLAUDE-APPEND.md in this release; refresh is still recommended to pick up any drift.
2. **No config.json changes** — no new keys required.
3. **No template changes** — state-templates are unchanged.
4. **Hook changes are in the plugin** — `hooks/hooks.json` ships with the plugin, not in the target project. No manual hook edits needed in target projects.

## [0.3.10] - 2026-04-08

### Fixed

- **Queued routine dedup collision** — when a routine was queued during a busy session (e.g. `*/15` at 08:30) and replayed later (e.g. at 08:45), the dequeue block wrote the _current_ minute into dedup state, suppressing the genuine 08:45 cron hit. Now stores `scheduled_slot` in each queue item and uses it for dedup during replay, so backlog items never collide with current-slot executions.

- **Missing python3 causes silent routine outage** — `routine-watcher.sh` shells out to `python3` for cron matching but treated interpreter-not-found (exit 127) as a normal no-match, causing total routine outage with no error. Now validates `python3` once at startup with `command -v` and exits with a FATAL message if absent. All python3 calls use the resolved path. Exit codes 126/127 from cron-match.py are logged explicitly instead of silently swallowed.

- **`hermit-docker down` force-stops immediately** — the graceful shutdown wait in `hermit-docker` read a static `.status` file (always "idle") instead of `runtime.json` (which `hermit-stop.py` actually writes to). The loop exited on iteration 1 every time, effectively force-stopping the container with no graceful close. Now reads `session_state` and `shutdown_completed_at` from `state/runtime.json` via `jq`, matching the logic in `docker-entrypoint`.

- **`validate-config.js` TIME_RE deleted** — the cron migration removed the `TIME_RE` regex but it was still used for `heartbeat.active_hours` validation, causing a silent ReferenceError (swallowed by try/catch). Restored.

- **`cron-match.py` accepted unused DOM argument** — CLI accepted a 4th `DOM` positional arg that was silently ignored (DOM is always parsed from the timestamp). Removed the parameter, updated docstring, and updated all callers.

- **`routine-watcher.sh` extra jq call per routine** — `run_during_waiting` flag required a second `jq` invocation per routine per tick. Now extracted in the initial jq query as a fourth tab-delimited field.

- **macOS heartbeat detection** — `routine-watcher.sh` used GNU-only `stat -c %Y` which silently returns 0 on macOS (BSD stat). Replaced with portable Python `os.path.getmtime()` call. Same fix applied to `docker-entrypoint.hermit.sh.template`.

- **`session-diff.js` shell syntax** — `execSync()` calls used `2>/dev/null || true` (bash shell syntax). Replaced with `stdio: ['pipe', 'pipe', 'pipe']` and separate try/catch blocks. No behavior change; removes bash dependency from a Node.js script.

- **Windows native fail-fast** — `hermit-start.py` now exits with a clear message on `sys.platform == 'win32'` instead of crashing with `ModuleNotFoundError` on `import fcntl`.

### Added

- **`.gitattributes`** — enforces LF line endings for `.sh` and `.py` files. Prevents CRLF corruption when cloning on Windows with `core.autocrlf=true`.

- **Platform support note in README** — states Linux, macOS, and Windows via WSL2 as supported; always-on mode requires a POSIX shell.

### Added

- **`/claude-code-hermit:cortex-sync`** — new skill that enriches existing hermit content with frontmatter and tags. Scans sessions, proposals, and artifact paths for missing fields, clusters similar files by topic for batch confirmation (not per-file grinder), then rebuilds Connections.md if the Cortex is set up. Key design decisions: dry-run scan phase with no writes; "Proceed?" is abort-or-continue only, each cluster still requires its own confirmation; "skip" skips that cluster, not the whole run; vocabulary accumulates across cluster confirmations within a single run. Conditional rebuild: if `obsidian/` does not exist, reports "run `/obsidian-setup`" instead of failing.

- **Tag discipline rule in CLAUDE-APPEND** — agents are now instructed to add `tags` to every session report, proposal, and artifact they create. Before tagging, scan the last 5 session reports and proposals for the existing vocabulary and reuse — introduce new tags only when nothing fits. Tags lowercase and hyphenated, 1–2 per document. Vocabulary grows organically from the hermit's own history; no operator input required.

- **Cortex section in `docs/skills.md`** — `obsidian-setup`, `cortex-refresh`, `cortex-sync`, and `weekly-review` were absent from the skills reference. Added as a new Cortex (Obsidian) section.

- **`scripts/cron-match.py`** — Python cron matcher used by `routine-watcher.sh`. Exit 0 = match, 1 = no match, 2 = parse error (logged, routine skipped). Supports `*`, exact, list, range, step atoms. Rejects both-DOM-and-DOW-restricted expressions, named values, and macros.

- **Cron validation in `scripts/validate-config.js`** — `parseCronField()` and `validateCronSchedule()` replace the old `TIME_RE` check for routines. Errors on leftover `time` or `days` fields.

- **Cron rules section in `docs/config-reference.md`** — Authoritative reference for schedule syntax, atoms, restrictions, DST behavior, and dedup semantics.

- **Shared test corpus `tests/cron-test-corpus.json`** — 13 valid expressions with 29 match/no-match cases + 17 invalid expressions. Used by both Python and Node test suites.

### Changed

- **`connections-refresh` renamed to `cortex-refresh`** — aligns with the cortex namespace (`obsidian-setup`, `cortex-sync`, `cortex-refresh`). Functionally identical; also fixes a missing `.` argument in the `build-cortex.js` call (project-root was not being passed). All references updated across CLAUDE.md, CLAUDE-APPEND.md, obsidian-setup skill, docs, and CHANGELOG history.

- **Routines: `time`/`days` → `schedule` (5-field cron)** — Routine scheduling now uses a single `schedule` field with standard 5-field cron syntax (`minute hour dom month dow`) instead of the old `time` (HH:MM) + optional `days` array. This enables sub-hourly schedules, DOM-based scheduling, and eliminates the separate days field. Clean break — no dual support.

### Files affected

| File                                   | Change                                                                                                                                                                    |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `skills/cortex-sync/SKILL.md`          | New — content enrichment skill                                                                                                                                            |
| `skills/connections-refresh/SKILL.md`  | Renamed to `skills/cortex-refresh/SKILL.md`; name, description, build args updated                                                                                        |
| `skills/obsidian-setup/SKILL.md`       | Step 6: routine id/skill updated to cortex-refresh; step 8: cortex-sync mention added; cortex-refresh routine uses `schedule`                                             |
| `state-templates/CLAUDE-APPEND.md`     | Tag discipline rule added; quick reference updated (cortex-refresh, cortex-sync)                                                                                          |
| `CLAUDE.md`                            | Plugin structure skill list updated; quick reference updated                                                                                                              |
| `docs/skills.md`                       | New Cortex (Obsidian) section; routine description updated                                                                                                                |
| `docs/obsidian-setup.md`               | cortex-refresh references updated                                                                                                                                         |
| `docs/frontmatter-contract.md`         | cortex-refresh reference updated                                                                                                                                          |
| `scripts/cron-match.py`                | New — cron schedule matcher                                                                                                                                               |
| `scripts/validate-config.js`           | Replaced TIME_RE with cron validation for routines                                                                                                                        |
| `scripts/routine-watcher.sh`           | Cron matching via cron-match.py; dedup key `YYYY-MM-DDTHH:MM\|rid`; queue uses `scheduled_slot`; python3 startup validation; `run_during_waiting` batched into initial jq |
| `tests/cron-test-corpus.json`          | New — shared test fixture                                                                                                                                                 |
| `state-templates/config.json.template` | `time`/`days` → `schedule`                                                                                                                                                |
| `agents/hermit-config-validator.md`    | `time` → `schedule`                                                                                                                                                       |
| `skills/hermit-settings/SKILL.md`      | Routine table and add wizard updated                                                                                                                                      |
| `skills/hatch/SKILL.md`                | Default routine entries use `schedule`                                                                                                                                    |
| `skills/proposal-act/SKILL.md`         | Required fields updated                                                                                                                                                   |
| `docs/config-reference.md`             | Schema, examples, and new cron rules section                                                                                                                              |
| `docs/troubleshooting.md`              | Dedup description updated                                                                                                                                                 |
| `docs/always-on-ops.md`                | Routine example and field descriptions updated                                                                                                                            |
| `state-templates/bin/hermit-docker`    | Graceful shutdown: `.status` → `runtime.json` + `jq`                                                                                                                      |
| `tests/run-hooks.sh`                   | Updated cron-match tests (dropped DOM arg); added queue-dedup slot isolation test                                                                                         |
| `tests/run-contracts.py`               | Updated cron corpus tests (dropped DOM arg)                                                                                                                               |
| `CHANGELOG.md`                         | Historical cortex-refresh references updated                                                                                                                              |

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **CLAUDE-APPEND refresh** — required. Adds the tag discipline rule, updates the quick reference line (`connections-refresh` → `cortex-refresh`, adds `cortex-sync`), and updates routine documentation references.
2. **Routine migration** — for each entry in `config.json` → `routines[]` that still has a `time` field:
   - Convert `time` (HH:MM) to cron minute and hour: `"08:30"` → `"30 8"`
   - Convert `days` array to DOW field: `["mon","wed","fri"]` → `"1,3,5"`, `["sun"]` → `"0"`, missing/null → `"*"`
   - Assemble: `"<minute> <hour> * * <dow>"`
   - Write the new `schedule` field, remove `time` and `days`
   - Day name mapping: `sun=0, mon=1, tue=2, wed=3, thu=4, fri=5, sat=6`
3. **Validate** — run `validateCronSchedule()` on each migrated expression. If any fails, report the error and keep the old fields (do not silently break routines).

### Migration Guide (Existing Hermits)

The `connections-refresh` routine in your `config.json` still points to the old skill name and will fail silently. Update it manually:

```json
{
  "id": "cortex-refresh",
  "schedule": "30 23 * * *",
  "skill": "claude-code-hermit:cortex-refresh",
  "enabled": true
}
```

Find the entry in `.claude-code-hermit/config.json` → `routines` array. Change `id` from `"connections-refresh"` to `"cortex-refresh"` and `skill` from `"claude-code-hermit:connections-refresh"` to `"claude-code-hermit:cortex-refresh"`.

For all routines, update from `time`/`days` to `schedule`:

Before:

```json
{"id": "morning", "time": "08:30", "skill": "...", "enabled": true}
{"id": "weekly-review", "time": "23:00", "days": ["sun"], "skill": "...", "enabled": false}
```

After:

```json
{"id": "morning", "schedule": "30 8 * * *", "skill": "...", "enabled": true}
{"id": "weekly-review", "schedule": "0 23 * * 0", "skill": "...", "enabled": false}
```

## [0.3.9] - 2026-04-08

### Added

- **Cortex-manifest system** — `cortex-manifest.json` lives at `.claude-code-hermit/cortex-manifest.json` and declares which project paths contain hermit-produced artifacts (calendars, reports, analysis, templates). `build-cortex.js` reads it and indexes those files into Connections.md (under **Sessions → Artifacts**, **Proposals → Artifacts**, **Domain Artifacts**, and **Unlinked Files** sections) and Cortex Portal.md (**Recent Artifacts**). Files without frontmatter appear as **Unlinked Files** — a nudge to add `title` and `created`. Completely backward compatible: missing manifest = no artifact scanning.

- **`state-templates/cortex-manifest.json.template`** — starter template with an empty `artifact_paths` array, copied to `.claude-code-hermit/cortex-manifest.json` by `hermit-evolve` (step 5a) for existing hermits and by `obsidian-setup` (step 4b) for new ones.

- **`docs/frontmatter-contract.md`** — the single source of truth for frontmatter fields across all cortex-relevant files. Six sections: (A) universal rules (ISO 8601, lowercase keys, flat only, tags as arrays), (B) session report, (C) proposal, (D) weekly review, (E) cortex-connected custom artifact (required: `title` + `created`; optional: `source`, `session`, `proposal`, `tags`), (F) generated Obsidian page. Defines field lifecycle (who writes what, when), enums for `status`, `source`, `category`, and `outcome`.

- **`scripts/validate-frontmatter.js`** — strict zero-dependency frontmatter validator. Scans all session reports, proposals, weekly reviews, and cortex-manifest artifact paths. Reports errors and warnings per file. Exit 0 = clean; exit 1 = errors. No legacy tolerance — all files must conform to the contract.

- **`/claude-code-hermit:test-run` skill** (`skills/test-run/SKILL.md`) — runs both test suites (`run-contracts.py` + `run-hooks.sh`) and reports a concise pass/fail summary. Listed in CLAUDE.md since v0.3.7 but the skill file was missing; now created.

- **Artifact frontmatter rule in CLAUDE-APPEND** — agents are now instructed: any `.md` file created outside `.claude-code-hermit/` must include YAML frontmatter with at least `title` (string) and `created` (ISO 8601 with timezone). If inside a hermit session, add `session: S-NNN`. Full contract in `docs/frontmatter-contract.md`.

### Changed

- **`build-cortex.js` accepts a third argument** — `[project-root]` (default: `.`) for resolving `artifact_paths` in the manifest. `obsidian-setup` now passes `.` explicitly: `node build-cortex.js .claude-code-hermit obsidian .`

- **`obsidian-setup` overhauled** — step order fixed (manifest created before `build-cortex.js` runs, so artifacts are indexed on first setup); `--force` scope now explicit (static pages overwritten, `cortex-manifest.json` never overwritten); path-mode detection uses `AskUserQuestion` with options; `--reconfigure-manifest` flag added for existing installs that want to update artifact paths without re-running full setup (shows current paths, scans for new candidates, writes updated manifest, rebuilds cortex).

- **`hermit-evolve` step 5a** — ensures `cortex-manifest.json` exists in the target hermit by copying from the plugin template. Skips if already present (operator-managed file, never overwrite).

- **Connections.md and Cortex Portal.md templates** — description updated to reflect sessions ↔ proposals ↔ artifacts.

### Fixed

- **`PROPOSAL.md.template` missing `accepted_date`** — `accepted_date` was read by scripts but never written to new proposals (phantom field). Template now declares `accepted_date: null` in the frontmatter block, aligned with the frontmatter contract.

- **`weekly-review.js` missing `generated: true`** — generated Obsidian pages must include `generated: true` per the frontmatter contract. Weekly review output now includes it.

- **`allArtifacts` deduplication** — artifacts with both `session` and `proposal` frontmatter fields appeared in both `artifactsBySession` and `artifactsByProposal` maps, causing duplicate entries in Cortex Portal's Recent Artifacts. Fixed with a `Set` keyed by absolute path during merge.

- **TOCTOU in `resolveArtifactPath`** — replaced `fs.statSync()` directory pre-check with a check for `*` in the path entry, eliminating the extra syscall and the race window. `globDirRecursive` already silently handles non-existent paths.

### Files affected

| File                                                 | Change                                                                                           |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `docs/frontmatter-contract.md`                       | New — frontmatter contract for all cortex-relevant files                                         |
| `docs/obsidian-setup.md`                             | Added Artifacts section: cortex-manifest.json, artifact frontmatter, graph behavior              |
| `scripts/build-cortex.js`                            | Reads cortex-manifest.json, generates artifact sections in Connections.md + Portal               |
| `scripts/lib/frontmatter.js`                         | Added `globDirRecursive`, `resolveArtifactPath`; TOCTOU fix                                      |
| `scripts/validate-frontmatter.js`                    | New — strict frontmatter validator, exit 0/1                                                     |
| `scripts/weekly-review.js`                           | Added `generated: true` to output frontmatter                                                    |
| `skills/hermit-evolve/SKILL.md`                      | Step 5a: copy cortex-manifest.json template if missing                                           |
| `skills/obsidian-setup/SKILL.md`                     | Reordered steps, --force scope table, AskUserQuestion for path mode, --reconfigure-manifest flag |
| `skills/test-run/SKILL.md`                           | New — skill file that was missing since v0.3.7                                                   |
| `state-templates/CLAUDE-APPEND.md`                   | Added artifact frontmatter rule                                                                  |
| `state-templates/PROPOSAL.md.template`               | Added `accepted_date: null`                                                                      |
| `state-templates/cortex-manifest.json.template`      | New — empty starter manifest                                                                     |
| `state-templates/obsidian/Connections.md.template`   | Updated tagline to include artifacts                                                             |
| `state-templates/obsidian/Cortex Portal.md.template` | Updated tagline and comment to include artifacts                                                 |

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **CLAUDE-APPEND refresh** — required. Adds the artifact frontmatter rule (agents must include `title` + `created` on any `.md` file they create outside `.claude-code-hermit/`).
2. **Template refresh** — `PROPOSAL.md.template` now includes `accepted_date: null`. New proposals will have it automatically; existing proposals are not touched.
3. **`cortex-manifest.json` created** — if not present, hermit-evolve copies the empty starter template. Edit `artifact_paths` to add your project's artifact directories, or run `/claude-code-hermit:obsidian-setup --reconfigure-manifest` for guided discovery.

No `config.json` changes required.

### Migration Guide (Existing Hermits)

Existing session reports and proposals may not conform to the new frontmatter contract. Run the validator to see what needs fixing — warnings are acceptable short-term, errors should be resolved.

**Step 1 — Run the validator**

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/validate-frontmatter.js .claude-code-hermit .
```

**Step 2 — Fix session reports** (`sessions/S-NNN-REPORT.md`)

Common issues in older sessions:

- Missing fields: add `task`, `escalation`, and `operator_turns` to the frontmatter block
- Bare dates (`2026-03-29`) → full ISO 8601 (`2026-03-29T00:00:00+01:00`)
- Non-standard status values (e.g., `daily_summary`) → `completed`
- Sessions without any frontmatter → add the full block from the contract

**Step 3 — Fix proposals** (`proposals/PROP-NNN.md`)

Common issues in older proposals:

- PascalCase keys (`ID`, `Title`, `Status`, `AcceptedOn`) → lowercase (`id`, `title`, `status`, `accepted_date`)
- `AcceptedOn` → `accepted_date`, `ResolvedOn` → `resolved_date`, `ResolvedIn` → `accepted_in_session`
- Missing `title` — must match the H1 heading in the body
- Missing `category` — map domain values: `automation`, `energy`, `optimization` → `improvement`; `upstream-bug` → `bug`
- Bare dates → full ISO 8601

**Step 4 — Add frontmatter to custom artifacts**

Any `.md` file in a path declared in `cortex-manifest.json` needs at minimum:

```yaml
---
title: "Descriptive title"
created: 2026-04-08T14:00:00+01:00
---
```

Optionally add `session`, `proposal`, `source` (`session` | `interactive` | `routine`), and `tags` for graph linking.

**Step 5 — Create `cortex-manifest.json`** (if not done by `hermit-evolve`)

If your project has custom artifact directories:

```json
{
  "version": 1,
  "artifact_paths": ["relatorios", "templates/captions", "calendario-*.md"]
}
```

Or re-run `/claude-code-hermit:obsidian-setup` — it now includes guided artifact path discovery.

**Step 6 — Re-run the validator until exit 0**

Warnings (missing timezone offsets on old timestamps) are acceptable short-term. Errors must be fixed.

## [0.3.8] - 2026-04-08

### Fixed

- **Channel hook matcher didn't match real Discord plugin tool names** — The Discord channel plugin registers tools as `mcp__plugin_discord_discord__reply` or `plugin:discord:discord - reply` depending on the environment. The hooks.json matcher expected `mcp__(discord|telegram)__reply` which never matched. Simplified to `(discord|telegram).*reply` to cover all observed formats.

- **`resolveChannel()` in channel-hook.js extracted wrong segment** — For `mcp__plugin_discord_discord__reply`, the regex `^mcp__([^_]+)__` captured `plugin` instead of `discord`, returning null. Simplified to `/(discord|telegram)/` — since the hooks.json matcher already scopes to channel reply tools, the script just needs to find the channel name anywhere in the tool name.

- **Changelog references used bare `config.json`** — Updated to `.claude-code-hermit/config.json` for clarity.

### Files affected

| File                      | Change                                |
| ------------------------- | ------------------------------------- |
| `hooks/hooks.json`        | Simplified channel hook matcher regex |
| `scripts/channel-hook.js` | Simplified `resolveChannel()` regex   |
| `CHANGELOG.md`            | Fixed config.json path references     |

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **CLAUDE-APPEND refresh** — not required this release.
2. **hooks.json auto-loaded from plugin** — no manual migration. New matcher takes effect on next session start.

No config.json changes required. Hermits that manually set `dm_channel_id` as a workaround can leave it — the hook will keep it current going forward.

## [0.3.7] - 2026-04-08

### Added

- **PreToolUse deny-pattern enforcer** — `scripts/enforce-deny-patterns.js` now enforces `deny-patterns.json` at runtime, blocking dangerous commands before execution. Also consolidates OPERATOR.md write protection and state-template edit warnings into a single Node process (previously two separate bash pipelines per Edit/Write call).

- **PostToolUse heartbeat touch** — every tool call writes the current timestamp to `state/.heartbeat`, keeping heartbeat staleness detection accurate without relying on the agent to do it manually. Uses a lightweight Node one-liner instead of spawning bash+date.

- **PostToolUse channel hook** (`scripts/channel-hook.js`) — automatically persists `dm_channel_id` to `.claude-code-hermit/config.json` after any Discord or Telegram reply, and tracks `last_reply_at` in `state/channel-activity.json`. Solves the recurring issue where `dm_channel_id` was null because the agent didn't follow the channel-responder's step 1d.

- **PostToolUse config validator** (`scripts/validate-config.js`) — validates `.claude-code-hermit/config.json` schema after any edit (required keys, types, routine time formats, channel structure, env values). Exits non-zero to surface errors immediately. Includes a fast-reject path that skips JSON parsing for non-config edits.

- **Stop routine-queue flush** (`scripts/routine-queue-flush.js`) — logs missed queued routines to SHELL.md Progress Log at shutdown so the next session knows what was skipped.

- **`/claude-code-hermit:test-run` skill** — user-invoked skill that runs both contract tests (`run-contracts.py`) and hook tests (`run-hooks.sh`) with a concise pass/fail summary.

- **`hermit-config-validator` agent** (Haiku) — lightweight read-only subagent that validates `.claude-code-hermit/config.json` after mutations (hermit-settings, hermit-evolve, channel-hook). Checks required keys, types, routine time formats, channel structure, and env values. Ships with the plugin so hermits can use it.

- **16 new hook tests** — test coverage expanded from 18 to 34 tests, covering all new hook scripts: enforce-deny-patterns (4 tests), channel-hook (4 tests), validate-config (4 tests), routine-queue-flush (4 tests).

### Changed

- **Consolidated PreToolUse hooks** — three separate hooks (deny-patterns Node script + template-warning bash + OPERATOR.md-block bash) merged into a single `enforce-deny-patterns.js` invocation. Reduces process spawns on every Edit/Write from 3 to 1.

- **Removed redundant OPERATOR.md entries from deny-patterns.json** — OPERATOR.md write protection is now enforced directly by the PreToolUse hook, so the deny-patterns.json entries were redundant.

- **TOCTOU fixes across all new scripts** — replaced all `fs.existsSync()` + `fs.readFileSync()` pairs with direct `try/catch` on `readFileSync`.

- **validate-config.js path matching** — uses `path.basename()` instead of substring `includes()` to avoid false positives on similarly-named files.

### Files affected

| File                                 | Change                                                                      |
| ------------------------------------ | --------------------------------------------------------------------------- |
| `hooks/hooks.json`                   | Added PreToolUse, PostToolUse, Stop hooks; consolidated inline bash hooks   |
| `scripts/enforce-deny-patterns.js`   | New — deny-pattern enforcement + OPERATOR.md block + template warn          |
| `scripts/channel-hook.js`            | New — dm_channel_id persistence + channel activity tracking                 |
| `scripts/validate-config.js`         | New — `.claude-code-hermit/config.json` schema validation after edits       |
| `scripts/routine-queue-flush.js`     | New — logs missed routines to SHELL.md at shutdown                          |
| `skills/test-run/SKILL.md`           | New — user-invoked test runner skill                                        |
| `state-templates/deny-patterns.json` | Removed redundant OPERATOR.md entries                                       |
| `tests/run-hooks.sh`                 | Added 16 new tests for all new hook scripts                                 |
| `agents/hermit-config-validator.md`  | New — lightweight `.claude-code-hermit/config.json` validator agent (Haiku) |
| `CLAUDE.md`                          | Updated skill list, agent table, agents description                         |

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **CLAUDE-APPEND refresh** — not strictly required this release (no changes to CLAUDE-APPEND.md content), but harmless to refresh.
2. **hooks.json is auto-loaded from the plugin** — no manual hook migration needed. The new hooks take effect immediately on next session start.

No config.json changes required. No manual steps needed.

## [0.3.6] - 2026-04-07

### Added

- **Hermit Cortex** — optional Obsidian surface over hermit state. Run `/claude-code-hermit:obsidian-setup` to create `obsidian/` with six pages: Brain (live session, fragile zones), Cortex (mindstate: uncertainty, regressions, operator dependence), Evolution (first vs latest, cost trend, autonomy trajectory), System Health (agent state embed), Connections (relationship map: sessions ↔ proposals), Cortex Portal (graph center). Requires Dataview plugin. Symlink and Folder Bridge path modes supported.

- **`scripts/build-cortex.js`** — generates `obsidian/Connections.md` and `obsidian/Cortex Portal.md` from session and proposal frontmatter. Zero npm dependencies. Runs at setup and nightly via `cortex-refresh` routine.

- **`/claude-code-hermit:cortex-refresh`** — lightweight skill wrapper that regenerates Connections.md and Cortex Portal.md. Added as a nightly routine at 23:30 by `/obsidian-setup`.

- **Weekly review** (`scripts/weekly-review.js` + `/claude-code-hermit:weekly-review`) — generates `.claude-code-hermit/reviews/weekly-YYYY-WNN.md` each Sunday. Covers: session count and cost, proposal lifecycle, recently resolved with honesty-rule impact numbers, operator dependence, and open loops (proposals with 5+ sessions and no action). Updates `obsidian/Latest Review.md` — the stable pointer all cortex pages link to. Honesty rule: impact numbers shown only when the tag appears in fewer than 30% of all sessions; otherwise "observed trend." Routine ships `enabled: false` — enable after running `/obsidian-setup`.

- **`operator_turns` field on session reports** — the cost-tracker hook now counts human-type transcript entries per session and stores a running total in `.status.json`. Session-mgr reads `operator_turns` from `.status.json` at archive time and writes it to the session report frontmatter. A session with `operator_turns = 0` completed without any operator redirection — the real autonomy metric. In always-on mode, the count includes channel messages and heartbeat triggers, but the relative difference across sessions still tells the story.

- **`escalation` field on session reports** — snapshot of the `escalation` value from `config.json` at archive time (`conservative | balanced | autonomous`). Cortex.md shows both: escalation (configured trust level) and operator_turns (actual interaction count). Together they answer whether the operator trusted the hermit and whether that trust was justified.

- **`accepted_in_session` field on proposals** — when a proposal is accepted, `proposal-act` now reads `session_id` from `runtime.json` and writes `accepted_in_session` to the proposal frontmatter. The _where_ companion to the existing `accepted_date` (_when_).

- **Session status enum formalized** — `status` in session reports must be one of `completed | partial | blocked`. Session-mgr now enforces this: unknown values are coerced to `partial` with a visible warning in the report's `## Blockers` section.

- **`obsidian/` and `hermit-state` added to gitignore template** — prevents accidental commits of generated Obsidian files. Added to `state-templates/GITIGNORE-APPEND.txt`.

- **`cortex | active` badge** in README — links to `docs/obsidian-setup.md`.

### Changed

- **`docs/obsidian-setup.md` revised** — full rewrite with Hermit Cortex framing, six-page reference, symlink-primary setup, graph view positioning, maturity expectations ("at session 1 vs session 20"), and Obsidian Bases write-back warning.

- **`state-templates/config.json.template`** — added `weekly-review` routine entry (`enabled: false`).

### Fixed

- **Docker: OAuth token expiry detected at container startup** — When the OAuth token had expired, the container would start silently and only fail once Claude Code tried to make a request (showing a 401 inside the tmux session). The entrypoint now parses `claudeAiOauth.expiresAt` from `.credentials.json` before launching and — if the token is expired — blocks with a clear banner and waits up to 10 minutes for `hermit-docker login` to supply fresh credentials, mirroring the first-boot flow. API key users are unaffected. Falls through silently if the expiry field is absent or the file is unreadable.

- **Docker: OAuth hint on `up` and `restart`** — `hermit-docker up` and `hermit-docker restart` now print a short note reminding the operator to run `hermit-docker login` if the session doesn't start, as a fallback for cases where the expiry field is unavailable or the token was invalidated server-side without updating the local file.

- **`hermit-evolve`: upgrade hermit plugins not yet in `_hermit_versions`** — Previously, if a hermit plugin was installed at project scope but `_hermit_versions` had no entry for it (e.g. installed after the last evolve run), the evolve skill would skip it silently. It now defaults the baseline to `"0.0.0"` and runs through all upgrade instructions, ensuring newly tracked hermits are brought up to date on first evolve.

### Files affected

| File                                                          | Change                                                                                                                                    |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/cost-tracker.js`                                     | Count human transcript entries per turn; store `operator_turns` in `.status.json`                                                         |
| `scripts/build-cortex.js`                                     | New — generates Connections.md + Cortex Portal.md                                                                                         |
| `scripts/weekly-review.js`                                    | New — weekly review report + Latest Review.md pointer                                                                                     |
| `scripts/lib/frontmatter.js`                                  | New — shared YAML frontmatter parser + directory glob helper                                                                              |
| `skills/obsidian-setup/SKILL.md`                              | New — one-time cortex setup skill                                                                                                         |
| `skills/cortex-refresh/SKILL.md`                              | New — nightly Connections + Portal regeneration                                                                                           |
| `skills/weekly-review/SKILL.md`                               | New — weekly review wrapper skill                                                                                                         |
| `state-templates/obsidian/Brain.md.template`                  | New                                                                                                                                       |
| `state-templates/obsidian/Cortex.md.template`                 | New                                                                                                                                       |
| `state-templates/obsidian/Evolution.md.template`              | New                                                                                                                                       |
| `state-templates/obsidian/System Health.md.template`          | New                                                                                                                                       |
| `state-templates/obsidian/Connections.md.template`            | New (header only — body generated by script)                                                                                              |
| `state-templates/obsidian/Cortex Portal.md.template`          | New (header only — body generated by script)                                                                                              |
| `state-templates/SESSION-REPORT.md.template`                  | Added `escalation`, `operator_turns` fields; formalized `status` comment                                                                  |
| `state-templates/PROPOSAL.md.template`                        | Added `accepted_in_session` field                                                                                                         |
| `state-templates/GITIGNORE-APPEND.txt`                        | Added `obsidian/`, `hermit-state`, `.claude-code-hermit/reviews/`                                                                         |
| `state-templates/config.json.template`                        | Added `weekly-review` routine (disabled by default)                                                                                       |
| `agents/session-mgr.md`                                       | Extraction rules for `escalation`, `operator_turns`, `status` enum enforcement; `.status.json` reset on idle transition and session close |
| `skills/proposal-act/SKILL.md`                                | Step 3a: populate `accepted_in_session` on accept                                                                                         |
| `docs/obsidian-setup.md`                                      | Full rewrite — Hermit Cortex framing, six-page reference, symlink-primary                                                                 |
| `docs/architecture.md`                                        | Added `reviews/` to file map                                                                                                              |
| `README.md`                                                   | Added `cortex \| active` badge                                                                                                            |
| `CLAUDE.md`                                                   | Added obsidian-setup, cortex-refresh, weekly-review to quick reference                                                                    |
| `state-templates/CLAUDE-APPEND.md`                            | Added new skills to quick reference; added `reviews/` to agent state table                                                                |
| `state-templates/docker/docker-entrypoint.hermit.sh.template` | Added OAuth expiry check (step 0b)                                                                                                        |
| `state-templates/bin/hermit-docker`                           | Added `_oauth_hint` helper; called from `up` and `restart`                                                                                |
| `skills/hermit-evolve/SKILL.md`                               | Default missing `_hermit_versions` entry to `"0.0.0"`                                                                                     |

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **CLAUDE-APPEND refreshed** — The session discipline block in target projects' CLAUDE.md now lists the three new skills (`obsidian-setup`, `cortex-refresh`, `weekly-review`) and adds `reviews/` to the agent state table. Hermit-evolve refreshes this automatically.

2. **Hermit Cortex setup (optional)** — Run `/claude-code-hermit:obsidian-setup` in any project where you want the Obsidian surface. This is a one-time step per project and is not applied automatically by hermit-evolve.

3. **`operator_turns` and `escalation` on future session reports** — No migration needed. New fields appear automatically on the next session close. Existing reports without these fields will show `null` in Dataview queries; filter with `WHERE operator_turns != null` to exclude them.

4. **Weekly review routine** — Added to `config.json.template` as `enabled: false`. Not auto-applied to existing projects. To enable: run `/claude-code-hermit:hermit-settings` and set `routines[weekly-review].enabled` to `true`, or add the entry manually to your project's `config.json`.

5. **`.gitignore` update for `reviews/`** — Add `.claude-code-hermit/reviews/` to the project's `.gitignore`. Without this, weekly review files will be committed. New hatches get this automatically. Existing projects: add the line manually or re-run hatch's gitignore step.

6. **`.status.json` counter reset** — session-mgr now resets `cost_usd`, `tokens`, and `operator_turns` in `.status.json` at each idle transition and session close. No operator action needed — takes effect on the next transition.

7. **`hermit-docker` updated automatically** — The evolve skill copies all files from `state-templates/bin/` into `.claude-code-hermit/bin/`, so `hermit-docker` gets the OAuth hint on `up`/`restart` without any manual step.

8. **Docker image rebuild required for OAuth expiry detection** — The entrypoint change lives in `docker-entrypoint.hermit.sh`, which is baked into the Docker image. To get the expiry check, re-run `/claude-code-hermit:docker-setup` (say "yes" to regenerate when prompted), then rebuild: `docker compose -f docker-compose.hermit.yml build` and `hermit-docker up`.

## [0.3.5] - 2026-04-07

### Fixed

- **`iter_channel_configs` crash on non-dict channels** — If `channels` in config.json was accidentally set to a string or array instead of a dict, `iter_channel_configs()` would crash with `AttributeError` on `.items()`. Added a type guard that returns early for non-dict values. Discovered by a new negative-path test.

### Added

- **Contract test suite (`tests/run-contracts.py`)** — 20 Python unittest tests covering config template/runtime sync (flattened key paths + type checks), boot merge logic (sparse configs, nested env/heartbeat deep merge), settings.local.json writing (stale token cleanup, state_dir mapping, profile enforcement), hook outputs (cost-tracker fields, evaluate-session structure), and negative paths (malformed config, wrong channel types). Runs as `python3 tests/run-contracts.py`.

- **Smoke test skill (`/claude-code-hermit:smoke-test`)** — Post-hatch validation that checks config.json validity, OPERATOR.md sanity, plugin_checks references, routine shapes (time format, skill syntax, duplicate IDs), and optionally sends a test message through configured channels. Produces a structured PASS/WARN/FAIL report. Replaces the previous approach of embedding validation into hatch step 10.

- **Hook output assertions in `run-hooks.sh`** — Extended existing exit-code-only tests with targeted content checks: session-diff sidecar JSON validation, check-upgrade output verification, deny-patterns.json structure check, bin script executable bit verification, and routine-watcher jq filter test. Total bash tests: 18.

- **`.claude/scheduled_tasks.lock` added to `.gitignore`** — Prevents the Claude Code task scheduler lock file from being committed. Especially important for Docker containers that restart with fresh PIDs.

### Changed

- **Renamed `hermit-upgrade` skill to `hermit-evolve`** — Creative name consistent with `hatch`. Invoked as `/claude-code-hermit:hermit-evolve`. All documentation, cross-references, scripts, and CHANGELOG.md references updated (17 files, ~82 occurrences).

- **Evolve skill: changelog-driven migrations** — Removed ~170 lines of hardcoded version-specific migration blocks (v0.0.9 through v0.3.4) from the evolve skill. Migrations are now driven by CHANGELOG.md `### Upgrade Instructions` sections — the same pattern already used for hermit plugin upgrades (step 7). New step 2b reads the changelog and executes each version's upgrade instructions in oldest-first order. SKILL.md dropped from 348 to 177 lines.

- **Hatch CLAUDE.md overwrite prompt** — When re-running hatch on a project that already has the session discipline block in CLAUDE.md, hatch now asks the operator whether to replace it with the latest version instead of silently skipping. Hermit CLAUDE-APPEND blocks get the same treatment.

- **CI workflow broadened** — Added `state-templates/**` to path triggers and `python3 tests/run-contracts.py` as a new CI step.

### Files affected

| File                                                          | Change                                                                                                |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `skills/hermit-evolve/SKILL.md`                               | Renamed from `skills/hermit-upgrade/`; removed hardcoded migrations, added changelog-driven step 2b   |
| `CHANGELOG.md`                                                | All `hermit-upgrade` refs → `hermit-evolve`                                                           |
| `CLAUDE.md`                                                   | Updated skill references                                                                              |
| `docs/skills.md`                                              | Updated skill table                                                                                   |
| `docs/upgrading.md`                                           | Updated invocation references (9 occurrences)                                                         |
| `docs/how-to-use.md`                                          | Updated references                                                                                    |
| `docs/security.md`                                            | Updated reference                                                                                     |
| `docs/config-reference.md`                                    | Updated reference                                                                                     |
| `docs/troubleshooting.md`                                     | Updated reference                                                                                     |
| `skills/hatch/SKILL.md`                                       | Updated next-steps reference; CLAUDE.md overwrite prompt                                              |
| `skills/smoke-test/SKILL.md`                                  | Updated version mismatch warning                                                                      |
| `scripts/check-upgrade.sh`                                    | Updated error message                                                                                 |
| `scripts/hermit-start.py`                                     | Updated error message; `iter_channel_configs` type guard                                              |
| `state-templates/CLAUDE-APPEND.md`                            | Updated skills reference                                                                              |
| `state-templates/bin/hermit-run`                              | Updated reference                                                                                     |
| `state-templates/docker/docker-entrypoint.hermit.sh.template` | Updated reference                                                                                     |
| `.claude/skills/release/SKILL.md`                             | Updated release workflow template                                                                     |
| `tests/run-contracts.py`                                      | New — 20 Python contract tests                                                                        |
| `tests/run-hooks.sh`                                          | 6 new assertions, `setup_workdir` creates `state/` dir, `setup_git_workdir` stages files + GPG bypass |
| `skills/smoke-test/SKILL.md`                                  | New — post-hatch validation skill                                                                     |
| `.github/workflows/test-hooks.yml`                            | Added contracts step + state-templates trigger                                                        |
| `.gitignore`                                                  | Added `scheduled_tasks.lock`                                                                          |
| `state-templates/GITIGNORE-APPEND.txt`                        | Added `scheduled_tasks.lock`                                                                          |
| `scripts/.gitignore`                                          | New — ignores `__pycache__/`                                                                          |

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Skill renamed** — The old `/claude-code-hermit:hermit-upgrade` command no longer exists. Use `/claude-code-hermit:hermit-evolve` going forward.
2. **CLAUDE-APPEND refresh** — The CLAUDE-APPEND.md template now references `hermit-evolve` instead of `hermit-upgrade`. The evolve skill will update the block in the project's CLAUDE.md.
3. **Boot script update** — `hermit-run` and other bin scripts reference the new skill name. Copy updated scripts from `state-templates/bin/`.
4. **Config.json** — No config.json changes required. The `iter_channel_configs` fix is in the boot script, not config.
5. **GITIGNORE-APPEND** — `.claude/scheduled_tasks.lock` was added. Check if the target project's `.gitignore` already contains this entry and append if missing.

The smoke-test skill is automatically available after the plugin update — no manual setup needed. The test suite is development-only and doesn't affect installed hermits.

## [0.3.4] - 2026-04-07

### Changed

- **Channel config consolidated into a single `channels` object** — Previously, channel-related settings were scattered across four top-level keys: `channels` (array), `allowed_users` (object), `morning_brief` (object), and `env.DISCORD_STATE_DIR` / `env.TELEGRAM_STATE_DIR`. All channel config now lives under a single `channels` object keyed by channel name.

  Old structure:

  ```json
  {
    "channels": ["discord"],
    "allowed_users": { "discord": ["123456789"] },
    "morning_brief": { "enabled": true, "time": "07:00", "channel": "discord" },
    "env": { "DISCORD_STATE_DIR": "/abs/path/.claude.local/channels/discord" }
  }
  ```

  New structure:

  ```json
  {
    "channels": {
      "discord": {
        "enabled": true,
        "allowed_users": ["123456789"],
        "dm_channel_id": null,
        "state_dir": "/abs/path/.claude.local/channels/discord",
        "morning_brief": { "enabled": true, "time": "07:00" }
      }
    }
  }
  ```

  `dm_channel_id` is new — the agent learns the DM channel ID from the first inbound message and stores it here for outbound proactive notifications. Discord DM channel IDs differ from user IDs; using the user ID as a channel ID silently failed.

  `DISCORD_STATE_DIR` / `TELEGRAM_STATE_DIR` env vars are still set with their exact static names (required by the channel plugin) — `hermit-start` now derives them from `channels.<name>.state_dir` at boot instead of reading them from `config.env`. No change to how the channel plugin sees these vars.

### Fixed

- **Outbound Discord DM notifications used user ID instead of channel ID** — Proactive notifications (heartbeat alerts, morning briefs, idle transitions) called the Discord `reply` tool with the user ID from `allowed_users` as the `chat_id`. Discord requires the DM channel ID, not the user ID — these are different snowflakes. The agent now reads `channels.discord.dm_channel_id`, which is populated from the first inbound message via `channel-responder`.

### Files affected

| File                                                                   | Change                                                                                                                                                              |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `state-templates/config.json.template`                                 | `channels: []` → `channels: {}`, removed `morning_brief`, removed `*_STATE_DIR` from `env`                                                                          |
| `scripts/hermit-start.py`                                              | `build_claude_command` iterates enabled channel keys; `write_settings_env` derives `*_STATE_DIR` from `channels.<name>.state_dir`; `forward_vars` built dynamically |
| `skills/hatch/SKILL.md`                                                | Wizard writes new nested channel structure; removed separate `allowed_users`, `morning_brief`, `*_STATE_DIR` env instructions                                       |
| `skills/docker-setup/SKILL.md`                                         | Channel setup writes `state_dir` to `channels.<name>.state_dir`; compose env lines derived from channel config                                                      |
| `skills/channel-responder/SKILL.md`                                    | Authorization reads `channels.<channel>.allowed_users`; new step 1d persists `chat_id` to `channels.<channel>.dm_channel_id`                                        |
| `state-templates/CLAUDE-APPEND.md`                                     | Outbound notification reads `channels.<channel>.dm_channel_id`; clarified user ID ≠ DM channel ID                                                                   |
| `skills/hermit-settings/SKILL.md`                                      | "channels" argument manages new object structure; "brief" reads/writes `channels.<channel>.morning_brief`                                                           |
| `skills/hermit-evolve/SKILL.md`                                        | Added v0.3.4 migration                                                                                                                                              |
| `docs/config-reference.md`                                             | New `channels` section; updated top-level table; updated complete example                                                                                           |
| `docs/troubleshooting.md`, `docs/architecture.md`, `docs/always-on.md` | Updated channel config references                                                                                                                                   |

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The v0.3.4 migration will:

1. Detect the old `channels` array format and convert it to the new object structure
2. Move `allowed_users` and `morning_brief` into each channel's entry
3. Move `*_STATE_DIR` values into `channels.<name>.state_dir` and remove them from `env`
4. Refresh `CLAUDE-APPEND.md` block in CLAUDE.md (outbound notification logic changed)
5. Refresh templates

After migration, send any message to your bot — `channel-responder` will populate `dm_channel_id` from the first inbound message, enabling reliable outbound notifications.

**If you have no channels configured:** No config.json changes required. CLAUDE-APPEND still refreshes.

## [0.3.3] - 2026-04-06

### Fixed

- **Always-on Discord notification gaps** — In Docker/tmux always-on mode, several session-start flows silently blocked waiting for operator input that could only come via Discord, but never sent the question to Discord. Fixed: unclean shutdown recovery, dead process detection, and interrupted transition recovery now all deliver their messages via the configured channel. The startup boot ping is also sent on normal boots.

- **Double channel message on recovery boots** — On unclean-shutdown and dead-process boots, the skill previously sent a recovery question followed by a redundant startup ping. The startup ping is now suppressed when a recovery message was already sent — the recovery message itself serves as the boot signal.

- **`brief --morning` / `--evening` delivery in always-on mode** — The delivery instruction said "deliver to the operator" without specifying the channel. In always-on mode with no terminal watcher, morning and evening briefs were silently output to tmux. Now explicitly routed via the configured channel when `always_on` is `true`.

- **Blocking language in unclean-shutdown recovery** — The instruction said "before waiting for a response" implying synchronous blocking, which doesn't exist in always-on channel mode. Replaced with "Then stop — channel-responder handles the reply." to accurately describe async flow.

- **Redundant inline conditions in session-start** — Unclean shutdown and dead process branches each re-stated the full `runtime_mode == tmux|docker AND channels configured` condition that the new global Always-On Notification Rule at the top of the skill already covers. Removed the duplication.

### Added

- **Always-On Notification Rule in session-start** — A global preamble that declares: in always-on mode, all operator-facing output goes via the configured channel. Future edits to this skill inherit the rule automatically without per-step annotation.

- **Always-On Delivery Rule in brief** — Same pattern applied to `brief/SKILL.md` as a shared preamble before the flags section, replacing identical copy-paste sentences in both `--morning` and `--evening`.

### Files affected

| File                            | Change                                                                                                                                                          |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `skills/session-start/SKILL.md` | Added Always-On Notification Rule; fixed unclean-shutdown, dead-process, and transition-recovery notification paths; fixed double ping; fixed blocking language |
| `skills/brief/SKILL.md`         | Added Always-On Delivery Rule preamble; replaced duplicate per-flag delivery sentences with a reference to the shared rule                                      |

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The upgrade skill handles:

1. **Refresh CLAUDE-APPEND** — Updated skill instructions need to be re-read by Claude Code. The upgrade skill will prompt you to re-run `/claude-code-hermit:hatch` or manually refresh the append content if your project uses it.

No config.json changes required. No template changes. No manual steps beyond the upgrade skill.

## [0.3.2] - 2026-04-06

### Added

- **`state/runtime.json`** — Single source of lifecycle truth. All scripts and hooks read session state from this file instead of `.status` or SHELL.md `Status:`. Atomic writes (tmp + rename) prevent partial state. Includes `session_state`, `session_id`, `created_at`, `runtime_mode`, `tmux_session`, transition markers, and shutdown timestamps.

- **Lifecycle lock** — `state/.lifecycle.lock` prevents concurrent mutations from hermit-start, hermit-stop, and routine-watcher racing each other. Uses `flock` (non-blocking). Skills check advisory lock before lifecycle operations.

- **Transition markers** — Multi-step operations (archive + SHELL.md cleanup) now write `transition`, `transition_target`, and `transition_started_at` to runtime.json. On startup, interrupted transitions are detected and resumed deterministically.

- **Liveness detection** — Stop hook touches `state/.heartbeat` after every assistant turn. routine-watcher.sh checks mtime every 60s. After 3 consecutive stale checks (with no active transition), marks `session_state: "dead_process"` and alerts the operator.

- **Pre-computed session IDs** — `session_id` (next S-NNN) is computed on session start and stored in runtime.json. Cost log entries are tagged from the first turn instead of retroactively.

- **session-diff.js sidecar** — Changed files are now written to `state/session-diff.json` instead of directly to SHELL.md. session-mgr merges the sidecar during lifecycle transitions. Eliminates the read-modify-write race between hooks and Claude.

- **`task` frontmatter on session reports** — `S-NNN-REPORT.md` now includes a `task` field in YAML frontmatter (first non-comment line from `## Task`, max 120 chars). Enables Dataview queries like `TABLE date, task, cost_usd FROM sessions` without reading the report body.

- **`title` and `resolved_date` frontmatter on proposals** — `PROP-NNN.md` now includes `title` (matches H1 heading) and `resolved_date` (set on accept/dismiss, null on defer — defer is not terminal). Enables Dataview proposal tables with readable titles and response-time queries.

- **ISO 8601 timestamps in frontmatter** — All date fields in session report and proposal frontmatter upgraded from `YYYY-MM-DD` to full ISO 8601 with timezone offset (e.g., `2026-04-06T14:30:00+01:00`). Consistent with `runtime.json`, `.status.json`, `state-summary.md`, and all other hermit state files. Timezone sourced from `config.json` if set, otherwise UTC.

### Changed

- **SHELL.md `Status:` is now cosmetic** — Updated by session-mgr for operator readability, but never read by scripts or hooks for lifecycle decisions. Exception: evaluate-session.js reads it for cosmetic nudges only.

- **`.status` file removed** — All consumers (routine-watcher, docker-entrypoint) now read `state/runtime.json` directly via jq.

- **cost-tracker.js reads session_id from runtime.json** — No longer parses SHELL.md `**ID:**` field. Writes `.status.json` atomically (tmp + rename).

- **routine-watcher.sh reads runtime.json** — Replaced `cat .status` with `jq .session_state`. Added Claude liveness detection via `.heartbeat` mtime. Respects lifecycle lock before writing health state.

- **docker-entrypoint SIGTERM handler** — Reads runtime.json instead of `.status` for shutdown detection.

- **hermit-start.py** — Creates runtime.json on startup (preserves existing lifecycle fields for crash recovery). Acquires lifecycle lock. Detects stale state from previous crashes. Reports interrupted transitions.

- **hermit-stop.py** — Writes `shutdown_requested_at` and `shutdown_completed_at` to runtime.json. Releases lifecycle lock before delegating to `/session-close` so the agent can acquire it for archiving. Marks `last_error: "unclean_shutdown"` on timeout.

- **cost-tracker.js caches runtime session ID** — `readRuntimeSessionId()` called once per turn and passed to `writeStatusJson()` instead of reading runtime.json twice.

- **routine-watcher.sh caches heartbeat threshold** — Python duration parser runs only when `heartbeat.every` config value changes, not every 60s loop.

### Fixed

- **Startup no longer overwrites recovery metadata** — `hermit-start.py` was creating a fresh runtime.json on every startup, destroying transition markers, `last_error`, and `session_state` that `/session-start` needs for crash recovery. Now only creates runtime.json when it doesn't exist; if it exists, updates only hermit-start-owned fields (`version`, `runtime_mode`, `tmux_session`) and preserves lifecycle state.

- **hermit-stop no longer deadlocks graceful shutdown** — `hermit-stop.py` held the lifecycle lock while delegating to `/session-close --shutdown` via tmux. The agent's archive/close path would see the lock as contention and refuse to run, causing timeout and `unclean_shutdown`. Now releases the lock before sending the close command and re-acquires it after for final cleanup.

- **routine-watcher uses locked read-modify-write** — `update_runtime_json()` was probing the lock with `flock -n ... true` then releasing it before the Python write started. A concurrent lifecycle operation could update runtime.json between the probe and the rename, causing the watcher to overwrite newer fields. Now holds flock for the entire read-modify-write via fd inheritance in a subshell.

### Files affected

| File                                                          | Change                                                                                                                  |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `scripts/hermit-start.py`                                     | runtime.json creation, lifecycle lock, stale state detection, crash recovery preservation                               |
| `scripts/hermit-stop.py`                                      | Shutdown timestamps, lock release before delegation, re-acquire for cleanup                                             |
| `scripts/routine-watcher.sh`                                  | runtime.json reads, locked writes, liveness detection, cached threshold                                                 |
| `scripts/cost-tracker.js`                                     | runtime.json session_id, atomic .status.json, .heartbeat touch, cached read                                             |
| `scripts/session-diff.js`                                     | Rewritten to write sidecar file instead of SHELL.md                                                                     |
| `agents/session-mgr.md`                                       | Field ownership table, transition markers, session-diff merge, recovery, `task` frontmatter extraction, ISO 8601 `date` |
| `skills/session-start/SKILL.md`                               | runtime.json reads, interrupted transition recovery, stale state handling                                               |
| `skills/session/SKILL.md`                                     | runtime.json note for session-mgr                                                                                       |
| `skills/session-close/SKILL.md`                               | runtime.json note for session-mgr                                                                                       |
| `skills/heartbeat/SKILL.md`                                   | runtime.json reads for session state and waiting timeout                                                                |
| `skills/channel-responder/SKILL.md`                           | runtime.json reads for waiting→in_progress transition                                                                   |
| `skills/hermit-evolve/SKILL.md`                               | v0.3.2 migration block                                                                                                  |
| `state-templates/docker/docker-entrypoint.hermit.sh.template` | runtime.json reads in SIGTERM handler                                                                                   |
| `state-templates/SESSION-REPORT.md.template`                  | Added `task` field, `date` upgraded to ISO 8601 timestamp                                                               |
| `state-templates/PROPOSAL.md.template`                        | Added `title`, `resolved_date` fields, `created` upgraded to ISO 8601 timestamp                                         |
| `skills/proposal-create/SKILL.md`                             | `title`, `resolved_date` frontmatter instructions, ISO 8601 `created`                                                   |
| `skills/proposal-act/SKILL.md`                                | Timestamp convention section, `resolved_date` on accept/dismiss (not defer), ISO 8601 dates                             |
| `docs/OBSIDIAN-SETUP.md`                                      | Updated queries with `task`/`title` fields, added response-time query, clarified Folder Bridge requirement              |

### Upgrade Instructions

1. **Create `state/runtime.json`** — Read current session state:
   - Read SHELL.md `Status:` field (default: `idle`)
   - Read `config.always_on` to determine runtime mode: if `true` and tmux session exists → `tmux`; if inside container → `docker`; else → `interactive`
   - Read tmux session name from config (`tmux_session_name` resolved with project name)
   - Read SHELL.md `Started:` for `created_at` (use current time if unavailable)
   - Pre-compute `session_id`: scan `S-*-REPORT.md` files, take highest NNN + 1. If none exist, use `S-001`.
   - Write to `state/runtime.json`:
     ```json
     {
       "version": 1,
       "session_state": "<from SHELL.md Status>",
       "session_id": "<pre-computed S-NNN>",
       "created_at": "<from SHELL.md Started or now>",
       "updated_at": "<now>",
       "runtime_mode": "<detected>",
       "tmux_session": "<resolved name or null>",
       "transition": null,
       "transition_target": null,
       "transition_started_at": null,
       "shutdown_requested_at": null,
       "shutdown_completed_at": null,
       "last_error": null
     }
     ```
2. **Delete `.status` file** — Remove `.claude-code-hermit/.status` if it exists.
3. **Create `state/.heartbeat`** — Touch the file so liveness detection has an initial timestamp.
4. Note to operator: "v0.3.2 introduces `state/runtime.json` as the single source of lifecycle truth. `.status` file has been removed. SHELL.md `Status:` is now cosmetic — all scripts read runtime.json for lifecycle decisions."

## [0.3.1] - 2026-04-06

### Added

- **Operator notification routing** — New "Operator Notification" section in CLAUDE-APPEND.md. Skills say "notify the operator" — routing is transparent: conversation in interactive mode, channel `reply` tool in always-on mode (requires exactly one `allowed_users` entry for the active channel). Failed sends log to SHELL.md Findings with deduped `channel-send-unavailable` tracking.

- **Plugin checks** — Recommended plugins are now invoked automatically. Two trigger types: `interval` (periodic during idle reflection, e.g. `claude-md-improver` weekly) and `session` (at task completion, e.g. `revise-claude-md`). New `plugin_checks` config array with per-check `trigger` and optional `interval_days`. Runtime state in `state/reflection-state.json` (under `plugin_checks` key). All checks are optional and toggleable via `/hermit-settings plugin-checks`.

- **Skill-creator integration in proposal-act** — Accepted proposals with a `## Skill Improvement` section now route through `/skill-creator` when available: NEXT-TASK.md includes skill-creator invocation steps. Falls back to direct SKILL.md edits if skill-creator is not installed.

- **Plugin check interval proposals** — 3+ consecutive empty runs → propose increasing interval. 3+ actionable findings in a single run → propose decreasing interval. Explicit reset rules for `consecutive_empty`: reset on any non-empty run, on proposal accept, and on proposal dismiss.

### Changed

- **Skill notification language** — Skills no longer reference channels directly. All outbound communication uses "notify the operator" — the routing pattern in CLAUDE-APPEND.md handles delivery.

- **Heartbeat alert response** — Now responds `HEARTBEAT_ALERT` instead of the full alert content. Conservative NEXT-TASK.md pickup notifies operator and sets status to `waiting`.

- **Hatch wizard Phase 4** — Now writes `plugin_checks` entries for accepted recommended plugins alongside plugin installation.

- **Docker-setup plugin checks** — Docker setup wizard now also writes `plugin_checks` entries when plugins are accepted (was only in hatch).

- **reflection-state.json dual ownership** — Session now writes `plugin_checks.<id>.last_run` at task completion (non-overlapping phases with reflect). Architecture ownership table updated.

### Security

- **Entrypoint no longer mutates config.json** — Removed the `bypassPermissions` write from `docker-entrypoint.hermit.sh`. `hermit-start.py` already handles this via `--dangerously-skip-permissions` CLI flag. Previously, one Docker boot silently persisted container-only privilege escalation into the shared project config on the host bind mount.

- **Bridge networking by default** — Docker compose template no longer hardcodes `network_mode: host`. Bridge is the default; host networking requires explicit opt-in via the `docker-setup` wizard. Reduces blast radius — container can no longer reach host-local services (databases, admin panels, metadata endpoints) unless the operator explicitly chooses host mode.

- **No auto-updates on boot** — Removed `claude plugin update` calls from the entrypoint. Automatic updates pulled unreviewed plugin code that ran with `bypassPermissions`. Updates are now operator-initiated via `/claude-code-hermit:hermit-evolve` or image rebuild. First-boot install-if-missing logic is preserved.

- **Full deny pattern set** — `docker-setup` and `hatch` now generate the complete deny set documented in `SECURITY.md`. Docker: 25 patterns (default + always-on). Hatch hardened: 22 (minus docker/kubectl/ssh). Hatch minimal: 17 (default only). Previously only 8 were generated. New patterns cover `.env` file access, credential exposure (`sudo`, `env`, `printenv`, `cat ~/.ssh/*`, `cat ~/.aws/*`), secret leakage (`*API_KEY*`, `*SECRET*`, `*TOKEN*`), and hook bypass (`*--no-verify*`). Canonical source: `state-templates/deny-patterns.json`.

- **Known Limitations section** — New section in `SECURITY.md` documenting unaddressed surfaces: egress filtering, input sanitization, and blocklist nature of deny patterns.

### Files affected

| File                                                          | Change                                                                           |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `state-templates/CLAUDE-APPEND.md`                            | New "Operator Notification" routing section                                      |
| `skills/heartbeat/SKILL.md`                                   | Channel refs → "notify the operator"                                             |
| `skills/brief/SKILL.md`                                       | Delivery instructions for morning/evening                                        |
| `skills/session/SKILL.md`                                     | Step 4b: session-triggered plugin checks with error handling and merge semantics |
| `skills/reflect/SKILL.md`                                     | Plugin Checks section with interval logic, adjustment proposals, guard rails     |
| `skills/proposal-act/SKILL.md`                                | Skill-creator integration, notification language                                 |
| `skills/hatch/SKILL.md`                                       | Phase 4: plugin_checks entries for accepted plugins                              |
| `skills/docker-setup/SKILL.md`                                | Plugin_checks entries for accepted plugins                                       |
| `skills/hermit-settings/SKILL.md`                             | `plugin-checks` subcommand                                                       |
| `skills/hermit-evolve/SKILL.md`                               | v0.3.1 migration block                                                           |
| `state-templates/config.json.template`                        | `plugin_checks: []` key                                                          |
| `docs/CONFIG-REFERENCE.md`                                    | `plugin_checks` schema and runtime state                                         |
| `docs/RECOMMENDED-PLUGINS.md`                                 | Plugin Checks section with trigger table                                         |
| `docs/TROUBLESHOOTING.md`                                     | Channel sends and plugin checks troubleshooting                                  |
| `docs/SKILLS.md`                                              | hermit-settings subcommand list                                                  |
| `docs/ARCHITECTURE.md`                                        | reflection-state.json dual ownership                                             |
| `state-templates/docker/docker-entrypoint.hermit.sh.template` | Removed config.json bypassPermissions mutation and plugin auto-update            |
| `state-templates/docker/docker-compose.hermit.yml.template`   | `network_mode: host` → `{{NETWORK_MODE_LINE}}` placeholder                       |
| `state-templates/deny-patterns.json`                          | New canonical deny pattern source (default + always-on)                          |
| `skills/docker-setup/SKILL.md`                                | Networking wizard question, full 25-pattern deny set                             |
| `skills/hatch/SKILL.md`                                       | Full deny sets: hardened (22), minimal (17)                                      |
| `docs/SECURITY.md`                                            | .env patterns, canonical source ref, Known Limitations, no-auto-update note      |
| `docs/UPGRADING.md`                                           | Security fixes and Docker verification steps                                     |

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The upgrade skill handles:

1. **CLAUDE-APPEND.md refresh** — The template changed (new Operator Notification section). Upgrade refreshes it automatically.
2. **Add `plugin_checks` to config.json** — Adds `"plugin_checks": []` if missing, auto-populates entries for any installed recommended plugins (`claude-code-setup`, `claude-md-management`), and backfills the `trigger` field on any existing entries.
3. **Initialize reflection state** — Adds `"plugin_checks": {}` to `state/reflection-state.json` if missing.

No config.json interactive prompts. No manual steps required. Skill files update automatically with the plugin.

## [0.3.0] - 2026-04-06

### Added

- **Alert deduplication** — Heartbeat alerts now use semantic keys (`stale-session`, `checklist:<item>`, `proposal-pending:<PROP-NNN>`, etc.) for dedup. Alerts suppress after 5 fires and surface only in a daily digest. Resolution clears after 2 consecutive clean ticks (4h at default 2h frequency). Eliminates the alert noise reported across all 3 active hermit instances.

- **Self-eval evidence gating** — Self-evaluation no longer suggests removing checklist items on a single-window basis. Items must accumulate 20 clean ticks across 3 distinct sessions before a proposal is created via the pipeline. Dismissed proposals reset the counter automatically via `self_eval_key` matching (step 2b).

- **Micro-proposal tier system** — Three-lane proposal system: silent (act directly), micro-approval (channel yes/no), and full PROP-NNN. Reflect classifies candidates into tier 1 (reversible/routine), tier 2 (meaningful/non-critical), or tier 3 (safety-critical). Micro-proposals use a single-slot queue in `state/micro-proposals.json` with a strict question format and 2-ignore expiry lifecycle via the morning brief.

- **Waiting state** — Third session status alongside `in_progress` and `idle`. Sessions can now be `waiting` when blocked on operator input. Heartbeat skips stale checks during waiting. Configurable `waiting_timeout` (default: null = no timeout) auto-transitions to idle. Channel-responder recognizes waiting state for response routing. Routine-watcher supports `run_during_waiting` flag per routine.

- **state/ directory** — New architectural layer for runtime observations. One writer per state file:
  - `alert-state.json` (heartbeat) — alert dedup + self-eval evidence
  - `reflection-state.json` (reflect) — last reflection timestamp
  - `routine-queue.json` (routine-watcher) — queued routines pending execution
  - `proposal-metrics.jsonl` (proposal-create + proposal-act) — append-only event log
  - `micro-proposals.json` (reflect + channel-responder) — single-slot micro-approval queue
  - `state-summary.md` (generate-summary.js) — auto-generated health snapshot for Obsidian

- **Three-condition proposal rule** — Proposals require: repeated pattern (observed across sessions), meaningful consequence, and operator-actionable change. Explicit refusal path in proposal-create. Applied in both reflect and proposal-create.

- **Proposal metrics tracking** — `responded: false` and `self_eval_key: null` added to proposal frontmatter. First-response-only counting prevents >100% response rates. Events logged to `proposal-metrics.jsonl` for `created`, `responded`, `micro-queued`, and `micro-resolved`.

- **Heartbeat restart routine** — Daily 4am routine (`heartbeat-restart`) restarts the heartbeat loop to prevent silent expiry in always-on deployments. `/loop` tasks expire after 3 days; this resets the clock. The `start` subcommand is now restart-safe (cancels existing loop before creating new).

- **Evaluate-session nudges** — Hook now detects zombie sessions (48h no progress), stale progress (4h silence), and monitoring section bloat (40+ lines). Nudges are stderr-only and skip when status is `waiting` or `idle`.

- **Reflect trigger at task completion** — Reflect now fires at task boundaries (before idle transition) with a 4h debounce guard via `reflection-state.json`, not just during heartbeat idle. Three-outcome decision tree: no action, memory update, or proposal candidate (with tier classification).

### Changed

- **Heartbeat default frequency** — `heartbeat.every` changed from `"30m"` to `"2h"`. All 3 retrospective reports flagged 30m as too frequent for human-paced workflows. Upgrade prompts existing hermits to update.

- **CLAUDE-APPEND trimmed** — Session discipline block cut from 130 to ~35 lines. Removed explanatory sections that duplicated skill instructions and docs. Kept: startup check, session states, state directory, subagent table, quick reference, rate limits, self-awareness, secrets, proposal rule.

- **Cost tracking moved out of SHELL.md** — `cost-tracker.js` no longer writes the `## Cost` section to SHELL.md (eliminated race condition with concurrent Claude edits). Cost data lives in `.status.json` and is injected into context by the SessionStart hook via `read-cost.js`.

- **Routine-watcher queue-not-skip** — Routines that fire during `in_progress` are now queued to `state/routine-queue.json` instead of silently skipped. Safe dequeue (one at a time, remove only after successful dispatch). Heartbeat detects stale queued routines.

- **Reflect scope tightened** — Removed "if you're not sure, mention it" clause. Three outcomes only: no action, memory update, or proposal candidate. No freeform observations.

### Removed

- **Skip tracking** — `.heartbeat-skips` file and the skip tracking procedure removed. Replaced with a simple "resumed (was inactive)" log line.
- **`self_eval_interval` config key** — Now a constant (20) in the skill instructions.
- **`heartbeat._last_reflection` config key** — Migrated to `state/reflection-state.json`.
- **`## Cost` section in SHELL.md template** — Cost data now in `.status.json`.

### Files affected

| File                                   | Change                                                                                       |
| -------------------------------------- | -------------------------------------------------------------------------------------------- |
| `scripts/generate-summary.js`          | **New.** Read-only state summary generator                                                   |
| `scripts/append-metrics.js`            | **New.** Append-only JSONL helper                                                            |
| `scripts/read-cost.js`                 | **New.** SessionStart hook cost reader                                                       |
| `skills/heartbeat/SKILL.md`            | Alert dedup, self-eval evidence gating, waiting state, restart-safe start, stale queue check |
| `skills/reflect/SKILL.md`              | Three-outcome tree, tier classification, micro-proposal queuing, three-condition rule        |
| `skills/proposal-create/SKILL.md`      | Three-condition validation, metrics append                                                   |
| `skills/proposal-act/SKILL.md`         | First-response guard, metrics append                                                         |
| `skills/channel-responder/SKILL.md`    | Waiting state, micro-approval handling                                                       |
| `skills/brief/SKILL.md`                | Micro-proposal pending slot in morning brief                                                 |
| `skills/session/SKILL.md`              | Reflect trigger with 4h debounce                                                             |
| `skills/session-start/SKILL.md`        | Recognize waiting state                                                                      |
| `skills/hatch/SKILL.md`                | state/ dir, state file init, heartbeat-restart routine                                       |
| `skills/hermit-evolve/SKILL.md`        | 13-step v0.3.0 migration with operator notes                                                 |
| `scripts/cost-tracker.js`              | Remove SHELL.md write                                                                        |
| `scripts/evaluate-session.js`          | Zombie, stale, bloat nudges                                                                  |
| `scripts/routine-watcher.sh`           | Queue-not-skip with safe dequeue                                                             |
| `scripts/hermit-start.py`              | Waiting state, updated defaults                                                              |
| `hooks/hooks.json`                     | SessionStart cost injection via read-cost.js                                                 |
| `state-templates/CLAUDE-APPEND.md`     | 130 → ~35 lines                                                                              |
| `state-templates/SHELL.md.template`    | Waiting state, removed ## Cost                                                               |
| `state-templates/config.json.template` | 2h frequency, waiting_timeout, heartbeat-restart routine                                     |
| `state-templates/PROPOSAL.md.template` | responded + self_eval_key fields                                                             |
| `state-templates/GITIGNORE-APPEND.txt` | state/ directory                                                                             |
| `docs/ARCHITECTURE.md`                 | state/ directory with ownership model                                                        |
| `docs/OBSIDIAN-SETUP.md`               | Agent Health, Fleet Health, micro-proposal queries                                           |
| `docs/ALWAYS-ON-OPS.md`                | Heartbeat-restart docs, routine-watcher update                                               |
| `.claude-plugin/plugin.json`           | Version bump to 0.3.0                                                                        |

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The upgrade skill handles 13 migration steps:

1. **state/ directory + files** — Creates the new `state/` directory and initializes all 5 state files (alert-state.json, reflection-state.json, routine-queue.json, proposal-metrics.jsonl, micro-proposals.json).
2. **Config migration** — Moves `_last_reflection` to state file, removes `self_eval_interval`, updates heartbeat frequency (interactive), adds `waiting_timeout`.
3. **SHELL.md cleanup** — Removes `## Cost` section (cost data preserved in .status.json, reported to operator).
4. **Gitignore + file cleanup** — Adds `state/` to .gitignore, removes `.heartbeat-skips`.
5. **Routine updates** — Adds `run_during_waiting` to brief routines, adds `heartbeat-restart` routine.
6. **Proposal backfill** — Adds `responded: false` and `self_eval_key: null` to existing proposals.
7. **Templates + CLAUDE-APPEND** — Auto-refreshed by existing upgrade steps 5 and 6.

## [0.2.13] - 2026-04-04

### Added

- **Reflect skill now monitors skill health** — The reflect skill gained a new "Skill Health" section that evaluates whether any skill is underperforming — being corrected after use, avoided in favor of manual steps, missing things it should catch, or burning disproportionate tokens. Findings follow the proposal pipeline at three confidence levels:
  - **Weak signal** — mention and watch
  - **Moderate signal** — create a proposal with evidence
  - **Strong signal** — create a proposal with a `## Skill Improvement` section containing the skill name, observed failures, and eval criteria. On acceptance, uses `/skill-creator eval` and `/skill-creator improve` to implement changes. If skill-creator is not installed, applies changes to the skill's SKILL.md directly.

- **Hatch wizard now recommends plugins by default** — The hatch skill gained a new Phase 4 that presents recommended plugins (claude-code-setup, claude-md-management, skill-creator) with `[yes]` defaults. The operator opts out, not in. Plugins are installed with `--scope project` so teammates get them automatically. The docker-setup skill's recommended plugins section was updated to match (defaults changed from `[no]` to `[yes]`).

- **Hatch wizard fully batched with AskUserQuestion** — Channel follow-ups (access control, morning brief) and deny rules now use `AskUserQuestion` batch format instead of freeform asks, matching the pattern used by all other wizard phases. Deny rules offer three options (minimal/hardened/skip) in a single prompt.

### Fixed

- **Docker entrypoint PATH not found** — Python subprocesses calling `subprocess.run(['claude', ...])` failed with `FileNotFoundError` because Docker's `ENV PATH` didn't reliably carry through to the bash entrypoint. Fixed by explicitly prepending `/home/claude/.npm-global/bin` to PATH at the top of the entrypoint.

- **Channel and recommended plugins never installed in Docker** — The entrypoint checked `external_plugins/<plugin>` to determine if a plugin needed installing, but `claude plugin marketplace add` populates that directory for ALL plugins in the catalog. The check was always false after marketplace add, so `claude plugin install` was never called. Fixed by using `claude plugin list` output instead.

- **Channel state symlinks triggered permission prompts** — The entrypoint symlinked `~/.claude/channels/<plugin>/` to the project-local state dir, but Claude Code's path boundary check saw the symlink source as outside the project tree, triggering a write prompt even with `bypassPermissions`. Replaced symlinks with Docker bind-mounts in `docker-compose.hermit.yml` — kernel-level transparent redirect, no permission issues, state persists even on ungraceful shutdown.

- **Hatch next steps missing docker-setup** — The report's "Next steps" section now includes `/claude-code-hermit:docker-setup` alongside `hermit-start` for always-on operation.

- **Hatch channel plugin install used wrong scope** — Changed from "Install globally" to `--scope local` with the full `claude plugin install` command, so channel plugins stay personal and don't push onto open-source collaborators.

### Files affected

| File                                                          | Change                                                                                        |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `skills/reflect/SKILL.md`                                     | Added Skill Health section with three-tier response pattern and skill-creator integration     |
| `state-templates/docker/docker-entrypoint.hermit.sh.template` | PATH fix, `claude plugin list` checks, symlink loop replaced with mkdir                       |
| `state-templates/docker/docker-compose.hermit.yml.template`   | Added `{{CHANNEL_VOLUME_LINES}}` placeholder for bind-mount volumes                           |
| `skills/docker-setup/SKILL.md`                                | Documented `{{CHANNEL_VOLUME_LINES}}`, bind-mount rationale, plugins default to yes           |
| `skills/hatch/SKILL.md`                                       | Recommended plugins phase, AskUserQuestion batches, phase reorder, deny rules, report updates |
| `docs/ALWAYS-ON.md`                                           | Updated symlink reference to bind-mount                                                       |

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The upgrade skill handles:

1. **No config.json changes required** — All changes are instruction-only (skill files, templates, entrypoint). Hermits pick them up automatically on next plugin update.

2. **Docker hermits must regenerate Docker files** — Existing Docker deployments still have the old entrypoint (broken PATH, symlinks, wrong plugin checks) and docker-compose (missing bind-mount volumes). Operators should re-run `/claude-code-hermit:docker-setup` to regenerate `docker-entrypoint.hermit.sh`, `docker-compose.hermit.yml`, and rebuild with `hermit-docker up --build`.

Non-Docker hermits get all changes on next `claude plugin update` with no action needed.

## [0.2.14] - 2026-04-05

### Changed

- **OPERATOR.md template simplified** — The 9-section template (Project, Current Priority, Constraints, Sensitive Areas, Operator Preferences, Tech Stack, External Dependencies, When Idle, Notes) has been replaced with a minimal freeform document. Most sections were either redundant (Tech Stack — derivable from code), dynamic (Current Priority, When Idle — go stale in a read-only file), or duplicated by CLAUDE.md (Sensitive Areas). The hatch wizard now writes concise prose tailored to the project instead of filling in a rigid form. Existing OPERATOR.md files are preserved — this only affects new hatches.

- **Idle tasks moved to dedicated file** — The `## When Idle` section in OPERATOR.md has been replaced by `.claude-code-hermit/IDLE-TASKS.md`, a dedicated operator-editable checklist. Tasks are picked sequentially during idle, each capped by `idle_budget`, and marked `[x]` on completion. The file is created on hatch and upgrade. Dynamic task lists no longer live in the read-only OPERATOR.md.

### Files affected

| File                                     | Change                                                         |
| ---------------------------------------- | -------------------------------------------------------------- |
| `state-templates/OPERATOR.md`            | Replaced 9-section template with minimal freeform document     |
| `state-templates/IDLE-TASKS.md.template` | New idle task list template                                    |
| `skills/hatch/SKILL.md`                  | Freeform OPERATOR.md onboarding, IDLE-TASKS.md copy            |
| `skills/heartbeat/SKILL.md`              | Idle task pickup from IDLE-TASKS.md replaces When Idle section |
| `skills/hermit-evolve/SKILL.md`          | OPERATOR.md rethink + IDLE-TASKS.md creation                   |
| `skills/hermit-settings/SKILL.md`        | Updated discover description                                   |
| `docs/ALWAYS-ON-OPS.md`                  | Added idle tasks to idle agency list                           |
| `docs/SKILLS.md`                         | Added Idle Tasks section                                       |
| `docs/CONFIG-REFERENCE.md`               | Updated idle_behavior and idle_budget descriptions             |
| `docs/TROUBLESHOOTING.md`                | Updated idle agency fallback description                       |
| `docs/UPGRADING.md`                      | Updated idle behavior description                              |
| `docs/HOW-TO-USE.md`                     | Updated OPERATOR.md example to freeform style                  |
| `docs/SECURITY.md`                       | Updated checklist wording                                      |

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The upgrade skill handles:

1. **OPERATOR.md rethink (optional, interactive)** — Ask the operator: "The OPERATOR.md template has been simplified — rigid sections replaced with concise freeform context. Would you like to rethink your OPERATOR.md?" If yes, back up and rewrite using the hatch onboarding flow. If no, skip — existing files work fine.

2. **IDLE-TASKS.md created + migration** — A new `.claude-code-hermit/IDLE-TASKS.md` file is created. If OPERATOR.md contains a `## When Idle` section, move its items into IDLE-TASKS.md as `- [ ]` checklist entries and remove the section from OPERATOR.md.

No config.json changes required. Non-Docker hermits get all changes on next `claude plugin update`.

## [0.2.12] - 2026-04-04

### Fixed

- **Routine watcher now supports any skill** — The routine watcher hardcoded the `claude-code-hermit:` prefix when invoking skills, so project-local skills (e.g. `ha-refresh-context`) and other plugin skills always failed with "Unknown skill". The watcher now sends `/${skill}` exactly as stored in config.json — hermit skills use their full name (`claude-code-hermit:brief --morning`), local skills use their bare name (`ha-refresh-context`).
- **Session-start morning brief check updated** — The interactive morning brief detection used `startsWith "brief --morning"` which would no longer match the full skill name. Changed to `contains "brief --morning"`.

### Files affected

| File                              | Change                                                                     |
| --------------------------------- | -------------------------------------------------------------------------- |
| `scripts/routine-watcher.sh`      | Removed hardcoded `claude-code-hermit:` prefix — sends `/${skill}` as-is   |
| `skills/hermit-evolve/SKILL.md`   | Added v0.2.12 migration to prefix existing short skill names in routines   |
| `skills/hermit-settings/SKILL.md` | Updated routine display example and add wizard to use full skill names     |
| `skills/hatch/SKILL.md`           | Default routines now use full names (`claude-code-hermit:brief --morning`) |
| `skills/session-start/SKILL.md`   | Morning brief check uses `contains` instead of `startsWith`                |
| `skills/reflect/SKILL.md`         | Routine proposal example uses full skill name                              |
| `docs/ALWAYS-ON-OPS.md`           | Updated routine examples and docs                                          |
| `docs/TROUBLESHOOTING.md`         | Updated morning brief reference to full skill name                         |

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The upgrade skill handles:

1. **Routine skill name migration** — Existing routines with short skill names (e.g. `"skill": "brief --morning"`) are automatically prefixed to `"skill": "claude-code-hermit:brief --morning"`. Skills that already contain `:` are left as-is. This is a one-time config.json migration.
2. **Templates updated** — No template changes in this release.

Operators who manually added local project skills to routines should verify their config.json — local skills should NOT have the `claude-code-hermit:` prefix (the migration only touches entries without `:`).

## [0.2.11] - 2026-04-03

### Fixed

- **Official marketplace not added without channels** — The Docker entrypoint only added the `claude-plugins-official` marketplace when channel plugins were configured. If an operator enabled recommended plugins (claude-code-setup, claude-md-management, skill-creator) but had no channels, the marketplace was never added and plugin installs silently failed. The marketplace add is now triggered by either channels or recommended plugins.

### Added

- **Auto-update plugins on container boot** — The Docker entrypoint now runs `claude plugin update` for the hermit plugin and all enabled recommended plugins on every boot. Previously, plugins were only installed on first run and never updated — operators had to `docker exec` into the container to update manually. Now a `hermit-docker restart` picks up new plugin versions automatically.

### Files affected

| File                                                          | Change                                                                                    |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `state-templates/docker/docker-entrypoint.hermit.sh.template` | Moved official marketplace add out of channel block; added step 4 (plugin update on boot) |

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The upgrade skill handles:

1. **Entrypoint template changed** — Docker hermits need their entrypoint regenerated. Run `/claude-code-hermit:docker-setup` to regenerate, or manually copy the new entrypoint template to `.claude-code-hermit/docker/docker-entrypoint.hermit.sh`.

No config.json changes required. Non-Docker hermits are unaffected.

## [0.2.10] - 2026-04-03

### Added

- **Recommended plugins: claude-md-management and skill-creator** — Two new official Anthropic plugins added to the recommended plugins list and Docker setup wizard. Both are from `claude-plugins-official` and complement Hermit's self-improvement loop:
  - **claude-md-management** — Audits and improves CLAUDE.md files (grades quality A–F, proposes targeted fixes). Keeps Hermit's project context sharp.
  - **skill-creator** — Builds, tests, and refines new skills through structured iteration. Lets Hermit act on "this should be a skill" proposals by actually creating them.

  These are recommended installs for any Hermit deployment. During `/docker-setup` (step 7b), operators are prompted to opt in to each plugin individually. Non-Docker users can install manually via `claude plugin install <plugin>@claude-plugins-official`.

### Files affected

| File                           | Change                                                                          |
| ------------------------------ | ------------------------------------------------------------------------------- |
| `docs/RECOMMENDED-PLUGINS.md`  | Added entries for claude-md-management and skill-creator under Official Plugins |
| `skills/docker-setup/SKILL.md` | Added both plugins to step 7b wizard prompt; generalized yes/no handling        |

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The upgrade skill handles:

1. **No automatic migration** — Recommended plugins are opt-in. Existing hermits are unaffected. The new plugins only appear during fresh `/docker-setup` runs.

No config.json changes required. To install manually in an existing deployment:

```
claude plugin install claude-md-management@claude-plugins-official --scope project
claude plugin install skill-creator@claude-plugins-official --scope project
```

Or add via `/claude-code-hermit:hermit-settings docker` → `add claude-md-management` / `add skill-creator`.

## [0.2.9] - 2026-04-03

### Changed

- **Idle reflection ungated from `discover` mode** — Periodic reflection (the 4+ hour idle check that invokes `/claude-code-hermit:reflect`) now fires for both `wait` and `discover` idle behavior, same as NEXT-TASK.md pickup. Previously, hermits in `wait` mode with no NEXT-TASK.md had nothing to do during idle — they'd go completely silent. Reflection is read-only (no task creation, no side effects), so it's safe to run ungated. `When Idle` pickup and priority alignment remain `discover`-only.

- **Reflect now checks operational efficiency** — The main reflection block (which runs at every task boundary, not just idle) now includes four new questions: whether tokens were spent on work a cheaper subagent could handle, whether manual work duplicated an existing skill, whether a subagent could have handled repeating subtasks, and whether context bloat was avoidable. These help hermits catch token waste patterns and propose improvements.

### Files affected

| File                        | Change                                                                                         |
| --------------------------- | ---------------------------------------------------------------------------------------------- |
| `skills/heartbeat/SKILL.md` | Moved Reflection block out of `discover`-only section; renumbered Priority alignment to item 2 |
| `skills/reflect/SKILL.md`   | Added 4 operational efficiency questions to the main reflection block                          |

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The upgrade skill handles:

1. **CLAUDE-APPEND refresh** — Not needed for this release (no changes to session discipline block).
2. **Templates** — Not affected.

No config.json changes required. No manual steps needed. Hermits in `wait` mode will automatically begin reflecting during idle after the plugin is updated.

## [0.2.8] - 2026-04-03

### Changed

- **Wizard defaults reordered** — All option lists in the hatch wizard now show the default choice first. Previously, some defaults (Autonomy, Idle behavior, Permission mode) appeared second or later in the list, making it easy to miss the recommended choice.

- **Idle behavior defaults to `"discover"`** — New hermit installs now default to `"discover"` (run maintenance tasks and periodic reflection when idle) instead of `"wait"`. This better reflects the personal assistant role — hermits should actively help, not just sit idle. Existing installs are unaffected; change via `/claude-code-hermit:hermit-settings idle`.

- **Channels recommend Discord** — The channel setup question now leads with "Discord (recommended)" instead of "None (default)". A personal assistant benefits from a communication channel. Operators can still choose Telegram or skip.

### Files affected

| File                                   | Change                                                                      |
| -------------------------------------- | --------------------------------------------------------------------------- |
| `skills/hatch/SKILL.md`                | Reordered all option lists; changed idle_behavior default in config example |
| `skills/hermit-settings/SKILL.md`      | Updated idle settings display example and option order                      |
| `skills/hermit-evolve/SKILL.md`        | Updated idle_behavior default in upgrade table and prompt                   |
| `state-templates/config.json.template` | Changed `idle_behavior` from `"wait"` to `"discover"`                       |
| `docs/CONFIG-REFERENCE.md`             | Updated `idle_behavior` default                                             |
| `docs/SKILLS.md`                       | Updated idle behavior description                                           |

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The upgrade skill handles:

1. **No automatic migration** — Existing `idle_behavior` values are preserved. The new default only applies to fresh `/claude-code-hermit:hatch` installs.

No config.json changes required. Operators who want the new default can switch manually: `/claude-code-hermit:hermit-settings idle` → choose Discover.

## [0.2.7] - 2026-04-03

### Changed

- **All Claude Code permission modes now selectable** — The hatch wizard and `/hermit-settings permissions` previously only offered `acceptEdits`, `dontAsk`, and `bypassPermissions`. Now all five Claude Code permission modes are available: `default`, `acceptEdits`, `plan`, `dontAsk`, and `bypassPermissions`. The hermit default remains `acceptEdits`. A note about `auto` mode (Teams/Enterprise only) is shown in settings and docs.

- **`plan` mode support in hermit-start** — `hermit-start.py` now correctly passes `--permission-mode plan` to Claude Code when `permission_mode` is set to `"plan"` in config.json. Previously it would emit a warning and fall back to default.

### Files affected

| File                              | Change                                                            |
| --------------------------------- | ----------------------------------------------------------------- |
| `skills/hatch/SKILL.md`           | Added `default` and `plan` options to wizard; updated record line |
| `skills/hermit-settings/SKILL.md` | Added `default`, `plan`, and `auto` note to permissions setting   |
| `scripts/hermit-start.py`         | Added `plan` to valid modes passed as `--permission-mode`         |
| `docs/CONFIG-REFERENCE.md`        | Added `plan` to mode list; added `auto` note                      |

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The upgrade skill handles:

1. **CLAUDE-APPEND refresh** — Not needed for this release (no changes to session discipline block).
2. **Templates** — Not affected.

No config.json changes required. Existing `permission_mode` values continue to work as before. Operators who want to use `default` or `plan` mode can switch via `/claude-code-hermit:hermit-settings permissions`.

## [0.2.6] - 2026-04-02

### Added

- **`hermit-docker` CLI** — New dedicated script for all Docker management. Replaces `hermit-run docker-*` subcommands and eliminates the need to type raw `docker compose -f docker-compose.hermit.yml` commands. Six subcommands:

  | Command                 | Purpose                         |
  | ----------------------- | ------------------------------- |
  | `hermit-docker up`      | Build and start container       |
  | `hermit-docker down`    | Graceful stop (--force to skip) |
  | `hermit-docker attach`  | Connect to tmux session         |
  | `hermit-docker login`   | OAuth login inside container    |
  | `hermit-docker logs`    | Follow container logs           |
  | `hermit-docker restart` | Restart container               |

### Changed

- **`hermit-run` restored to boot script dispatcher** — Docker subcommands (`docker-up`, `docker-down`, `docker-attach`) removed from `hermit-run`. It now only resolves the plugin root and dispatches to Python boot scripts (`hermit-start.py`, `hermit-stop.py`), which was its original purpose.

- **`hermit-status` simplified** — Removed unused `TMUX_SESSION` resolution (no longer needed since the attach hint now points to `hermit-docker attach`). The Python block no longer parses `tmux_session_name` or takes the project dir as an argument.

- **All docs updated to use `hermit-docker`** — Every raw `docker compose -f docker-compose.hermit.yml` command in user-facing docs replaced with the `hermit-docker` equivalent. Operators never need to remember the compose filename.

### Files affected

| File                                                          | Change                                                                       |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `state-templates/bin/hermit-docker`                           | New script — Docker management CLI                                           |
| `state-templates/bin/hermit-run`                              | Removed docker subcommands; boot dispatcher only                             |
| `state-templates/bin/hermit-status`                           | Removed unused TMUX_SESSION; simplified Python block                         |
| `state-templates/docker/docker-entrypoint.hermit.sh.template` | Login hint now uses `hermit-docker login`                                    |
| `skills/docker-setup/SKILL.md`                                | All commands updated to `hermit-docker`; step 9 shows full command reference |
| `skills/hatch/SKILL.md`                                       | Added `hermit-docker` to file tree and bin copy step                         |
| `skills/hermit-hand-back/SKILL.md`                            | Uses `hermit-docker up` and `hermit-docker logs`                             |
| `docs/ALWAYS-ON.md`                                           | Full command table updated; login, logs, restart use `hermit-docker`         |
| `docs/FAQ.md`                                                 | Login and restart commands updated                                           |
| `docs/RECOMMENDED-PLUGINS.md`                                 | Restart command updated                                                      |
| `README.md`                                                   | Attach command updated; version bump                                         |

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The upgrade skill handles:

1. **Boot script update** — Copies all files from `state-templates/bin/` into `.claude-code-hermit/bin/`, which adds the new `hermit-docker` script and updates `hermit-run` and `hermit-status`. Existing hermits will have both scripts after upgrade.
2. **CLAUDE-APPEND block update** — Refreshed with current skill list.
3. **Entrypoint template update** — Updated `docker-entrypoint.hermit.sh.template` with new login hint. Docker hermits should rebuild to pick this up: `.claude-code-hermit/bin/hermit-docker up --build`.

No config.json changes required. The old `hermit-run docker-up` / `hermit-run docker-down` commands will stop working after upgrade — use `hermit-docker up` / `hermit-docker down` instead. Non-Docker hermits are unaffected.

## [0.2.5] - 2026-04-02

### Added

- **Recommended plugins support for Docker setup** — New step 7b in the `/docker-setup` wizard asks whether to install plugins that complement autonomous operation. Nothing is pre-shipped or pre-configured — plugins are only added to config when the operator explicitly opts in. Ships with `claude-code-setup` (Anthropic) as the first recommended plugin — analyzes your codebase and recommends automations (skills, hooks, MCP servers, subagents), feeding Hermit's self-improvement loop.

- **Structured `recommended_plugins` config** — Each entry in `docker.recommended_plugins` specifies `marketplace`, `plugin`, `scope`, and `enabled`. Only plugins from `claude-plugins-official` are auto-installed on container boot. Third-party plugins (`"org/repo"` marketplace format) are tracked in config for reference but must be installed manually — the entrypoint skips them with a warning due to `bypassPermissions` security risk.

- **`/hermit-settings docker` now manages recommended plugins** — Enable, disable, add, or remove recommended plugins alongside Docker packages. Third-party plugin additions show a warning that manual install is required.

- **Recommended Plugins documentation** — New `docs/RECOMMENDED-PLUGINS.md` covers the plugin list, config format, security policy, third-party manual installation, and management commands. Added to README doc table, CONFIG-REFERENCE.md, and SECURITY.md.

- **Plugin security policy in SECURITY.md** — Documents that the entrypoint only auto-installs official plugins, third-party plugins require manual install after review, and Hermit does not vet or take responsibility for any plugin.

### Changed

- **Entrypoint config.json read consolidated** — The recommended plugins list is now extracted in the existing Python init block (which already reads config.json for channels and permission_mode), eliminating a redundant file read and Python invocation on every container start.

### Files affected

| File                                                          | Change                                                                                      |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `skills/docker-setup/SKILL.md`                                | Added step 7b (recommended plugins wizard); default is no                                   |
| `skills/hermit-settings/SKILL.md`                             | Added recommended plugins management to docker section                                      |
| `state-templates/config.json.template`                        | Added empty `docker.recommended_plugins` array                                              |
| `state-templates/docker/docker-entrypoint.hermit.sh.template` | Merged config read into init block; added recommended plugins install block (official only) |
| `docs/RECOMMENDED-PLUGINS.md`                                 | New document                                                                                |
| `docs/CONFIG-REFERENCE.md`                                    | Added `recommended_plugins` entry schema with security policy                               |
| `docs/SECURITY.md`                                            | Added plugin security section and checklist items                                           |
| `README.md`                                                   | Added Recommended Plugins to doc table; version bump                                        |

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The upgrade skill handles:

1. **CLAUDE-APPEND block update** — Refreshed with current skill list.
2. **Boot script update** — Copies updated `docker-entrypoint.hermit.sh.template` with the new recommended plugins install block.

No config.json changes required. The new `docker.recommended_plugins` key is only used by the Docker entrypoint and is populated by `/docker-setup`. Existing Docker deployments continue to work — the entrypoint gracefully handles missing or empty `recommended_plugins`. Non-Docker hermits are unaffected.

## [0.2.4] - 2026-04-01

### Changed

- **Init wizard restructured into 5 phases using `AskUserQuestion` batches** — The setup wizard previously asked all questions one at a time in plain conversation (~12 sequential turns). Refactored into a 5-phase flow that cuts interactions to 4–5: (1) silent parallel auto-detect of language and timezone, (2) free-text identity questions conversationally (name, language, timezone, sign-off), (3) a single `AskUserQuestion` batch for 4 behavior settings (autonomy, remote, budget, idle), (4) a single `AskUserQuestion` for channels with conditional follow-ups, (5) a `AskUserQuestion` batch for permission mode and routines. Multiple-choice questions now render as native Claude Code option pickers rather than typed responses.

- **OPERATOR.md onboarding questions now use `AskUserQuestion` batch** — Step 5a Phase 3 was presenting 3–5 questions as a plain conversational numbered list, causing Claude to dump them as unformatted text. Replaced with a single `AskUserQuestion` call using `header` + `question` fields and no `options` (renders as free-text inputs in the native Claude Code UI). Added `header` column to the question bank table; hermit extension now respects the 4-question-per-call limit.

- **Renamed `hermit-init` skill to `hatch`** — Creative, unambiguous name that can't collide with any native command. Invoked as `/claude-code-hermit:hatch`. All documentation, cross-references, and scripts updated.

- **Renamed `upgrade` skill to `hermit-evolve`** (originally `hermit-upgrade`, renamed to `hermit-evolve` in v0.3.6) — Prefixed to avoid collision with native `/upgrade` command. Invoked as `/claude-code-hermit:hermit-evolve`. All documentation, cross-references, and scripts updated.

- **Renamed `status` skill to `pulse`** — Native `/status` command shows Claude Code connection info, colliding with the hermit session status skill. Renamed to `/claude-code-hermit:pulse`. All documentation, cross-references, and scripts updated.

- **Removed `name:` frontmatter from all skills, then re-added matching directory names** — The `name:` field was putting bare names like `init`, `session`, `status` into model context, potentially influencing command routing. All 18 skills now have `name:` matching their directory name exactly.

- **Removed `_plugin_root` from config.json** — Boot scripts (`hermit-run`) previously cached the plugin's absolute path in `config.json` as `_plugin_root`. This broke when switching between Docker and host environments: the path from one environment would overwrite the other's, since config.json is bind-mounted. Replaced with runtime discovery that scans `~/.claude/plugins/marketplaces/*/` for the `claude-code-hermit` plugin. Docker uses `HERMIT_PLUGIN_ROOT` env var as a fast path. No config.json read/write needed for plugin resolution.

### Files affected

| File                                                          | Change                                                                                                                                                                              |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `skills/hatch/SKILL.md`                                       | Renamed from `skills/hermit-init/`; rewrote step 4 into 5 phases; step 5a Phase 3 now uses `AskUserQuestion` for OPERATOR.md questions; removed `_plugin_root` from config template |
| `skills/hermit-evolve/SKILL.md`                               | Renamed from `skills/upgrade/`; updated cross-reference from "steps 4a–4e" to "Phase 2"; removed `_plugin_root` references                                                          |
| `skills/pulse/SKILL.md`                                       | Renamed from `skills/status/`                                                                                                                                                       |
| `CLAUDE.md`                                                   | Updated skill list and references                                                                                                                                                   |
| `README.md`                                                   | Updated invocation references                                                                                                                                                       |
| `CONTRIBUTING.md`                                             | Updated setup instructions                                                                                                                                                          |
| `docs/*.md`                                                   | Updated all skill invocation references                                                                                                                                             |
| `docs/CONFIG-REFERENCE.md`                                    | Removed `_plugin_root` from schema table                                                                                                                                            |
| `scripts/hermit-start.py`                                     | Updated skill references; removed `_plugin_root` from DEFAULT_CONFIG                                                                                                                |
| `scripts/check-upgrade.sh`                                    | Updated skill references                                                                                                                                                            |
| `state-templates/bin/hermit-run`                              | Rewrote plugin resolution: removed config.json read, now scans `~/.claude/plugins/` at runtime                                                                                      |
| `state-templates/config.json.template`                        | Removed `_plugin_root` field                                                                                                                                                        |
| `state-templates/docker/docker-entrypoint.hermit.sh.template` | Simplified plugin root export comment                                                                                                                                               |
| `state-templates/CLAUDE-APPEND.md`                            | Updated quick reference                                                                                                                                                             |
| `state-templates/OPERATOR.md`                                 | Updated generator comment                                                                                                                                                           |

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The upgrade skill handles:

1. **CLAUDE-APPEND block update** — Refreshed session discipline block with new skill names.
2. **Remove `_plugin_root` from config.json** — This key is no longer used. The upgrade skill should delete `_plugin_root` from the project's config.json if present.
3. **Boot script update** — `hermit-run` was rewritten to resolve the plugin path at runtime. The upgrade skill copies updated boot scripts from `state-templates/bin/` into `.claude-code-hermit/bin/`.

No other config.json changes required. The skill renames only affect invocation commands — existing initialized projects continue to work.

---

## [0.2.3] - 2026-04-01

### Fixed

- **Init wizard now asks questions one at a time** — The setup wizard (step 4) was presenting all questions in a single response block instead of asking them interactively. The SKILL.md listed all wizard questions (4a–4l) in sub-sections without any instruction to pause between them, so Claude would output the full batch at once. Added an explicit "wizard discipline" instruction requiring each question to be asked one at a time via `AskUserQuestion`, waiting for the operator's response before proceeding.

- **Renamed `init` skill to `hermit-init`** — The bare name `init` conflicted with Claude Code's native `/init` command (which analyzes the codebase and generates CLAUDE.md), causing the native command to shadow the hermit skill in the command picker. Renamed to `/claude-code-hermit:hermit-init` to avoid the collision. All documentation, skill cross-references, and scripts updated.

### Files affected

| File                               | Change                                                                   |
| ---------------------------------- | ------------------------------------------------------------------------ |
| `skills/hermit-init/SKILL.md`      | Renamed from `skills/init/SKILL.md`; added wizard discipline instruction |
| `README.md`                        | Updated skill invocation references                                      |
| `CLAUDE.md`                        | Updated skill list and template description                              |
| `CONTRIBUTING.md`                  | Updated setup instructions                                               |
| `docs/HOW-TO-USE.md`               | Updated invocation references                                            |
| `docs/FAQ.md`                      | Updated references                                                       |
| `docs/CONFIG-REFERENCE.md`         | Updated references                                                       |
| `docs/ALWAYS-ON.md`                | Updated references                                                       |
| `docs/SECURITY.md`                 | Updated references                                                       |
| `docs/CREATING-YOUR-OWN-HERMIT.md` | Updated references                                                       |
| `skills/upgrade/SKILL.md`          | Updated invocation and file path references                              |
| `skills/hermit-settings/SKILL.md`  | Updated invocation reference                                             |
| `skills/docker-setup/SKILL.md`     | Updated invocation reference                                             |
| `scripts/hermit-start.py`          | Updated invocation reference                                             |
| `state-templates/OPERATOR.md`      | Updated generated-by comment                                             |

### Upgrade Instructions

Run `/claude-code-hermit:upgrade`. The upgrade skill handles:

1. **CLAUDE-APPEND block update** — Refreshed session discipline block (no content change in this version, but the upgrade skill always checks).

**No config.json changes required.** No template changes. The `hermit-init` rename only affects new project setups — existing initialized projects are unaffected.

---

## [0.2.2] - 2026-03-31

### Fixed

- **Hermit upgrades now execute changelog migrations** — The upgrade skill's step 7 (hermit upgrades) previously only displayed changelog entries from sub-hermits without executing their `### Upgrade Instructions` sections. Hermits upgrading across multiple versions would silently skip migrations. Now: changelog entries are extracted per version (oldest first), and each `### Upgrade Instructions` section is executed — not just shown. The static `UPGRADE.md` fallback is removed; changelogs are the authoritative migration source.

- **Hermit CLAUDE-APPEND sync fully specified** — The upgrade skill's hermit CLAUDE-APPEND block update was a one-liner ("find marker, replace content") with no detail on where to find the marker or source template. Now explicitly delegates to the same procedure as the core CLAUDE-APPEND update (step 6), specifying: source template path (`state-templates/CLAUDE-APPEND.md` at the hermit's plugin root) and marker location (first HTML comment line in that template).

### Files affected

| File                      | Change                                                                                                                |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `skills/upgrade/SKILL.md` | Rewrote step 7 (hermit upgrades): execute changelog migrations in version order, specify CLAUDE-APPEND sync procedure |

### Upgrade Instructions

Run `/claude-code-hermit:upgrade`. The upgrade skill handles:

1. **CLAUDE-APPEND block update** — Refreshed session discipline block (no content change in this version, but the upgrade skill always checks).

**No config.json changes required.** No template changes. This is a fix to the upgrade skill's own instructions — it changes how future hermit upgrades behave, not the current project state.

---

## [0.2.1] - 2026-03-31

### Fixed

- **Mandatory proposal pipeline** — Hermits could bypass the proposal workflow by presenting improvements as informal numbered lists in channel messages and implementing them after verbal approval. Now enforced: every improvement must have a PROP-NNN file before implementation. CLAUDE-APPEND.md includes a hard "Proposal Pipeline (mandatory)" rule loaded into every session.

- **Channel-responder now recognizes proposal approvals** — New "Proposal approval" message classification catches messages like "accept PROP-", "go ahead with PROP-012", or informal references (#1, #2). Routes through `/proposal-act` instead of treating them as new task assignments. Classification is ordered before "New instruction" to prevent misrouting.

- **Heartbeat "no action" rule clarified** — The heartbeat instruction "Do NOT take action on findings" conflicted with creating proposals for discovered improvements. Reworded to "Do NOT implement fixes — only report." Creating proposals is explicitly called out as documentation, not action.

- **Reflect skill uses formal proposal references** — The reflect skill now uses backtick-formatted `/claude-code-hermit:proposal-create` references (was plain text).

### Files affected

| File                                | Change                                                            |
| ----------------------------------- | ----------------------------------------------------------------- |
| `state-templates/CLAUDE-APPEND.md`  | Added "Proposal Pipeline (mandatory)" section                     |
| `skills/channel-responder/SKILL.md` | Added "Proposal approval" classification before "New instruction" |
| `skills/heartbeat/SKILL.md`         | Clarified "no action" rule, proposal creation is documentation    |
| `skills/reflect/SKILL.md`           | Formatted proposal-create reference                               |

### Upgrade Instructions

Run `/claude-code-hermit:upgrade`. The upgrade skill handles:

1. **CLAUDE-APPEND block update** — The session discipline block in your project's CLAUDE.md is refreshed to include the new "Proposal Pipeline (mandatory)" section. This is the primary fix — it prevents hermits from skipping the proposal workflow.

2. **Template refresh** — No template changes in this version.

**No config.json changes required.** This is a behavioral fix via updated instructions only.

---

## [0.2.0] - 2026-03-31

### Changed

- **Plan tracking delegated to native Claude Code Tasks** — The `## Plan` table in SHELL.md has been removed. Plan items are now tracked as native Claude Code Tasks (`TaskCreate`, `TaskUpdate`, `TaskList`). This aligns with hermit's principle: "If overlap exists with Claude Code native features, delegate — don't build." SHELL.md retains everything Tasks doesn't cover: progress log, blockers, findings, changed files, cost, monitoring, session summary, and session metadata.

- **New: `tasks-snapshot.md` for Obsidian** — The cost-tracker hook now writes `.claude-code-hermit/tasks-snapshot.md`, a read-only projection of the native task list with YAML frontmatter (`progress`, `updated`). Enables Dataview queries, dashboard embeds, and fleet progress tracking across multi-hermit observatories. Auto-generated every turn with change detection (skips write when content is unchanged).

- **New: `scripts/lib/tasks.js` shared helper** — Centralizes native Task file reading (`~/.claude/tasks/{list-id}/*.json`) in one module. Both `cost-tracker.js` and `evaluate-session.js` import from here. If Claude Code changes the task file format, only this file needs updating.

- **`CLAUDE_CODE_TASK_LIST_ID` set by init** — The `init` skill now writes `CLAUDE_CODE_TASK_LIST_ID` to `.claude/settings.local.json`, making the task list persistent across sessions. Claude Code exports this env var to all subprocesses (hooks, MCP servers, Bash), so hooks can read task files directly.

- **Session workflow updated** — The main session agent now creates Tasks after plan confirmation (`TaskCreate` per step), updates them during work (`TaskUpdate`), and cleans up before idle/close transitions. Session-mgr no longer manages plan items — it receives the serialized task table via prompt and includes it in archived reports.

- **Idle transition: all tasks deleted (clean slate)** — On idle transition, the main agent serializes the task table, deletes all tasks, then invokes session-mgr. The report preserves the full task table.

- **Full session close: only completed tasks deleted** — Pending/in_progress tasks persist in the native task list for the next session. The "Next Start Point" in fresh SHELL.md notes: "Unfinished tasks remain in the task list."

- **Quick tasks skip TaskCreate** — For single-step work (typo fixes, one-liner changes), the agent skips `TaskCreate`. Tasks are for multi-step work decomposition only. Same policy as before ("skip for quick asks"), now explicitly stated.

### Fixed

- **evaluate-session.js hash cache now includes task state** — The MD5 short-circuit hash previously only covered SHELL.md content. Since plan tracking moved to external task files, the hash now includes the task count. Task changes correctly invalidate the cache.

- **Pipe characters in task subjects no longer break snapshot table** — `writeTaskSnapshot` now escapes `|` in subject and status fields.

### Files affected

| File                                | Change                                                   |
| ----------------------------------- | -------------------------------------------------------- |
| `state-templates/SHELL.md.template` | Removed `## Plan` section                                |
| `agents/session-mgr.md`             | Removed plan table ops, accepts task table from prompt   |
| `skills/session/SKILL.md`           | TaskCreate/TaskUpdate workflow, task cleanup before idle |
| `skills/session-start/SKILL.md`     | Create Tasks instead of plan table                       |
| `skills/session-close/SKILL.md`     | Task cleanup on close, pass table to session-mgr         |
| `skills/status/SKILL.md`            | TaskList for progress counts                             |
| `skills/brief/SKILL.md`             | TaskList for progress counts                             |
| `skills/channel-responder/SKILL.md` | Removed Plan reference                                   |
| `skills/hermit-takeover/SKILL.md`   | Updated example output                                   |
| `state-templates/CLAUDE-APPEND.md`  | Added task discipline, removed plan table refs           |
| `scripts/lib/tasks.js`              | **New** — shared task file reading helper                |
| `scripts/cost-tracker.js`           | Task reading + snapshot write (replaces plan parsing)    |
| `scripts/evaluate-session.js`       | Task-aware plan check + hash fix                         |
| `skills/init/SKILL.md`              | Writes `CLAUDE_CODE_TASK_LIST_ID` to settings.local.json |
| `skills/upgrade/SKILL.md`           | v0.2.0 migration: task list ID + legacy plan strip       |
| `tests/fixtures/shell-session.md`   | Removed plan table from fixture                          |
| `docs/ARCHITECTURE.md`              | Updated plan lifecycle                                   |
| `docs/HOW-TO-USE.md`                | Updated progress display                                 |
| `docs/OBSIDIAN-SETUP.md`            | Snapshot embed, progress queries, fleet progress         |

### Upgrade Instructions

Run `/claude-code-hermit:upgrade`. The upgrade skill handles:

1. **Task list ID setup** — Writes `CLAUDE_CODE_TASK_LIST_ID` to `.claude/settings.local.json` (derived from project basename). This makes native Tasks persistent and lets hooks read task files.

2. **SHELL.md template update** — The new template has no `## Plan` section. Existing templates in `.claude-code-hermit/templates/` are auto-replaced.

3. **CLAUDE-APPEND block update** — Session discipline instructions are refreshed to reference native Tasks.

4. **Legacy plan table cleanup** — If an active SHELL.md has a `## Plan` section, the upgrade warns you to close the session first. If confirmed, it strips the orphaned section.

**No config.json changes required.** The task list ID lives in `settings.local.json`, not config.

**Obsidian users:** Add `![[.claude-code-hermit/tasks-snapshot]]` above your SHELL.md embed in your dashboard. See updated `docs/OBSIDIAN-SETUP.md` for Dataview queries and layout recommendations.

---

## [0.1.3] - 2026-03-30

### Changed

- **Docker: OAuth via `claude login` instead of token injection** — The `CLAUDE_CODE_OAUTH_TOKEN` env var approach has been removed entirely. It caused the container to run in organization/API mode instead of personal Max/Pro mode, breaking `--remote-control` and subscription features. OAuth users now run `claude login` directly inside the container on first boot. Credentials are saved to the named volume and persist across restarts. API key auth via `ANTHROPIC_API_KEY` in `.env` continues to work as before.

### Upgrade Instructions

**Option A — Re-run docker-setup (recommended):**

1. Back up your `.env` file
2. Run `/claude-code-hermit:docker-setup` — it will offer to regenerate all Docker files
3. Rebuild and restart the container: `docker compose -f docker-compose.hermit.yml up -d --build`
4. The container will wait for you to log in. From another terminal:
   ```
   docker compose -f docker-compose.hermit.yml exec hermit claude login
   ```
5. Remove `CLAUDE_CODE_OAUTH_TOKEN` and `CLAUDE_REFRESH_TOKEN` from your `.env` file (no longer used)

**Option B — Manual patch:**

1. In `docker-entrypoint.hermit.sh`, replace the "Auth mode" section (the `if` block that unsets `ANTHROPIC_API_KEY`) with:
   ```bash
   # Wait for auth credentials
   CRED_FILE="${CLAUDE_CONFIG_DIR}/.credentials.json"
   if [ -z "${ANTHROPIC_API_KEY:-}" ] && [ ! -f "$CRED_FILE" ]; then
     echo "[docker-entrypoint] No auth credentials found."
     echo "[docker-entrypoint] Run: docker compose -f docker-compose.hermit.yml exec hermit claude login"
     echo "[docker-entrypoint] Waiting for credentials (timeout: 10 minutes)..."
     WAIT_SECS=0
     while [ ! -f "$CRED_FILE" ]; do
       sleep 5
       WAIT_SECS=$((WAIT_SECS + 5))
       if [ "$WAIT_SECS" -ge 600 ]; then
         echo "[docker-entrypoint] Timed out. Run claude login, then restart."
         exit 1
       fi
     done
     echo "[docker-entrypoint] Credentials detected! Continuing startup..."
   fi
   ```
2. In `docker-compose.hermit.yml`, remove the `CLAUDE_CODE_OAUTH_TOKEN` and `CLAUDE_REFRESH_TOKEN` environment lines
3. Remove `CLAUDE_CODE_OAUTH_TOKEN` and `CLAUDE_REFRESH_TOKEN` from your `.env` file
4. Rebuild: `docker compose -f docker-compose.hermit.yml up -d --build`
5. Login: `docker compose -f docker-compose.hermit.yml exec hermit claude login`

**Important:** Both options require a container rebuild (`--build`) since the entrypoint script is baked into the Docker image. A simple restart will not pick up the changes.

---

## [0.1.2] - 2026-03-30

### Fixed

- **Docker: OAuth token no longer overridden by API key** — When both `CLAUDE_CODE_OAUTH_TOKEN` and `ANTHROPIC_API_KEY` are present in the container environment (e.g. via `env_file: .env`), Claude Code silently picks API mode — no Max/Pro shown, `--remote-control` fails. Fixed in three layers: the entrypoint now `unset`s `ANTHROPIC_API_KEY` early when the OAuth token is set; `hermit-start.py` skips forwarding `ANTHROPIC_API_KEY` into the tmux session when the OAuth token is present; and the `docker-setup` skill now detects the conflict in `.env` during setup and offers to clean it up.

### Upgrade Instructions

If you have an existing Docker deployment using OAuth auth, apply the following change:

- Add the following block near the top of your `docker-entrypoint.hermit.sh`, before the onboarding section:

```bash
# Auth mode: OAuth token wins over API key if both are present
if [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ] && [ -n "${ANTHROPIC_API_KEY:-}" ]; then
  echo "[docker-entrypoint] OAuth token present — unsetting ANTHROPIC_API_KEY to prevent API mode override."
  unset ANTHROPIC_API_KEY
fi
```

Then rebuild the container: `hermit-run docker-up --build`

---

## [0.1.1] - 2026-03-30

### Fixed

- **Cost tracker now captures real token data** — The Stop hook payload never included token fields; `cost-tracker.js` was silently writing zero-cost entries (or on newer installs, not writing at all). It now reads the last assistant turn's `usage` from `transcript_path` in the hook payload, which is where Claude Code actually exposes token counts.
- **Cache token pricing** — Added separate pricing rates for `cache_creation_input_tokens` (write) and `cache_read_input_tokens` (read) for all models. Previously cache tokens were ignored entirely, understating cost for heavily-cached sessions.
- **Efficient transcript tail-read** — Instead of loading the full transcript file, reads only the last 128KB using a positioned `fs.readSync` call. Avoids unnecessary memory use on long sessions.

### No manual upgrade steps required.

---

## [0.1.0] - 2026-03-30

### Added

- **`hermit-run docker-up`** — Start the Docker container and print the tmux attach command. Passes extra args to `docker compose up` (e.g., `hermit-run docker-up --build` to force rebuild).
- **`hermit-run docker-down`** — Graceful shutdown: sends `/session-close --shutdown` via tmux, waits up to 60s for the session to close, then stops the container. Use `--force` to skip the graceful close. Timeout is logged if graceful close doesn't complete.
- **`hermit-status` attach hint** — When Docker container is running, status output now includes the tmux attach command.
- **Docker entrypoint SIGTERM trap** — Container now handles `docker compose down` gracefully. SIGTERM triggers a session close attempt (30s timeout) before the container exits, so sessions are archived even without `hermit-run docker-down`.

### Changed

- **`hermit-run` is the single dispatcher** — Docker subcommands (`docker-up`, `docker-down`) are handled as subcommands in `hermit-run`, using the same config resolution as `hermit-start`/`hermit-stop`. No separate wrapper scripts needed.
- **Upgrade skill bin copy** — Step 5b now copies all files from `state-templates/bin/` instead of naming specific scripts. New bin scripts are automatically picked up on upgrade.
- **Docker-down polls host filesystem** — Status polling reads `.claude-code-hermit/.status` directly from the host (bind-mounted) instead of spawning `docker compose exec` on every poll iteration.
- **Compose service name from `docker compose config --services`** — Replaces fragile YAML line-scanning with the authoritative Docker Compose command.

### Fixed

- **Docker: add missing `jq` dependency** — `routine-watcher.sh` requires `jq` to parse `config.json` for timezone and routines. Without it, the routine watcher silently fails and no scheduled routines fire inside the container.

### Upgrade Instructions

If you have an existing `Dockerfile.hermit` generated by `/claude-code-hermit:docker-setup`, add `jq` to the `apt-get install` line:

```diff
 RUN apt-get update && apt-get install -y --no-install-recommends \
-      tmux python3 python3-venv python3-pip git curl unzip ca-certificates && \
+      tmux python3 python3-venv python3-pip git curl unzip jq ca-certificates && \
```

If you have an existing `docker-entrypoint.hermit.sh`, regenerate it with `/claude-code-hermit:docker-setup` or manually add the SIGTERM trap from the updated template.

Then rebuild: `docker compose -f docker-compose.hermit.yml build`

---

## [0.0.10] - 2026-03-30

### Added

- **YAML frontmatter on session reports** — S-NNN-REPORT.md files now include structured YAML frontmatter (`id`, `status`, `date`, `duration`, `cost_usd`, `tags`, `proposals_created`). Enables querying by any tool that reads YAML: Obsidian Dataview, datasette, jq, Grafana. The old `## Summary` bullet list is replaced by `## Overview` (task description only) — no metadata duplication.
- **YAML frontmatter on proposals** — PROP-NNN.md files now include frontmatter (`id`, `status`, `source`, `session`, `created`, `related_sessions`, `category`). The 5 bullet metadata lines are removed. New `category` field (improvement/routine/capability/constraint) is LLM-classified at creation time for filtering.
- **Cost summary** — `cost-tracker.js` generates `.claude-code-hermit/cost-summary.md` with frontmatter aggregates (`total_cost_usd`, `total_sessions`, `avg_session_cost_usd`) and human-readable Today/This Week/All Time sections with a 7-day trend table. Regenerates once per day.
- **Brief cost integration** — `--morning` brief includes "Yesterday: $X.XX across N sessions" from cost-summary.md. `--evening` and daily summary briefs reference cost-summary.md for aggregated data.
- **Obsidian Quick Start** — OBSIDIAN-SETUP.md restructured: leads with a 4-step paste-and-go setup. New sections: Cost Dashboard, Proposal Pipeline, Canvas Planning (manual), Multi-Hermit Setup (symlinks).
- **Cost summary guard** — uses `statSync` on cost-summary.md file mtime to skip regeneration if already generated today. No config.json dependency on the hot path.

### Changed

- **Session report template** — `## Summary` (6 bullet lines) replaced by YAML frontmatter + `## Overview` (one-line task description). All structured metadata lives in frontmatter only.
- **Proposal template** — Bullet metadata (`- **Status:**`, etc.) replaced by YAML frontmatter. Body starts at `## Context`.
- **session-mgr agent** — On Session Close and On Task Complete now generate YAML frontmatter when archiving. Includes explicit extraction instructions and example output.
- **proposal-create** — Writes YAML frontmatter instead of bullet metadata. Classifies proposal category.
- **proposal-act** — Updates frontmatter `status` field and adds action date (`accepted_date`, `deferred_date`, `dismissed_date`). Falls back to bullet metadata for pre-Observatory proposals.
- **proposal-list** — Reads YAML frontmatter first, falls back to bullet format. Table now includes `Category` column.
- **reflect** — Parses frontmatter when scanning proposals, falls back to bullets.
- **brief** — Reads cost-summary.md for cost data. Proposal scanning uses frontmatter with bullet fallback.

### Upgrade Instructions

Run `/claude-code-hermit:upgrade` to refresh templates and migrate existing files.

**Migration: Session reports to YAML frontmatter**

For each `.claude-code-hermit/sessions/S-*-REPORT.md`:

1. Skip files already starting with `---` (already migrated)
2. Parse the `## Summary` bullet metadata (format: `- **Field:** value`):
   - `id`: from filename (e.g., `S-001-REPORT.md` -> `S-001`)
   - `status`: from `- **Status:**` line (default `completed` if missing)
   - `date`: from `- **Date:**` line
   - `duration`: from `- **Duration:**` line
   - `cost_usd`: from `- **Cost:**` line — strip the `$` prefix, parse the number before `(`. E.g., `$1.2345 (138K tokens)` -> `1.2345`. Use `0.00` if missing.
   - `tags`: from `- **Tags:**` line — split on `,`, trim whitespace, format as YAML array. E.g., `refactor, frontend` -> `[refactor, frontend]`. Use `[]` if empty.
   - `proposals_created`: scan `## Proposals Created` section for `PROP-NNN` patterns, format as YAML array. Use `[]` if none.
3. Prepend the generated YAML frontmatter block (between `---` delimiters)
4. Replace the `## Summary` section (heading + bullet lines) with `## Overview` containing only the `- **Task:**` value as prose
5. Validate: re-read the file, verify frontmatter starts with `---` and ends with `---`, verify `id` and `status` fields are present. If parsing fails, warn: "Could not migrate S-NNN-REPORT.md — manual review needed." and leave the file unchanged.

Report: "Migrated N session reports with YAML frontmatter."

**Migration: Proposals to YAML frontmatter**

For each `.claude-code-hermit/proposals/PROP-*.md`:

1. Skip files already starting with `---` (already migrated)
2. Parse the bullet metadata lines (format: `- **Field:** value`):
   - `id`: from filename (e.g., `PROP-001.md` -> `PROP-001`)
   - `status`: from `- **Status:**` line
   - `source`: from `- **Source:**` line (default `manual` if missing)
   - `session`: from `- **Session:**` line
   - `created`: from `- **Created:**` line
   - `related_sessions`: from `- **Related Sessions:**` line — split into YAML array. Use `[]` if empty.
   - `category`: classify based on body content — `routine` if mentions schedule/cron/recurring, `capability` if mentions agent/skill/heartbeat, `constraint` if mentions OPERATOR.md, else `improvement`
3. Prepend the generated YAML frontmatter block
4. Remove the 5 bullet metadata lines from the body (everything between the H1 heading and `## Context`)
5. Validate: same as session reports. If parsing fails, warn and leave unchanged.

Report: "Migrated N proposals with YAML frontmatter."

---

## [0.0.9] - 2026-03-29

### Added

- **Routines system** — Shell-level routine watcher (`scripts/routine-watcher.sh`) fires skills at exact scheduled times. Runs as a tmux window, reads `config.json` routines every 60 seconds. No LLM tokens spent on clock-checking. Manage with `/hermit-settings routines`.
- **Stale session detection** — Heartbeat alerts when an active session shows no progress for longer than `stale_threshold` (default: `"2h"`). Catches silent crashes and rate limit stalls.
- **Skip receipts** — When heartbeat resumes after skipped ticks (outside active hours, empty checklist), logs one summary line instead of silence. Eliminates ambiguous monitoring gaps.
- **Checklist weight guidance** — HEARTBEAT.md template includes `<!-- Keep under 10 items -->` comment. Self-evaluation warns if checklist exceeds 10 items and suggests moving periodic checks to routines.
- **`idle_behavior` config** — Top-level setting: `"wait"` (default, check tasks/channels only) or `"discover"` (also run OPERATOR.md maintenance tasks and periodic reflection). Replaces `heartbeat.idle_agency` boolean.
- **When Idle tasks** — OPERATOR.md supports a `## When Idle` section listing low-priority maintenance tasks. Heartbeat picks items sequentially during idle (when `idle_behavior` is `"discover"`), capped by `idle_budget`.
- **`.status` file** — `.claude-code-hermit/.status` contains a single word (`idle`, `in_progress`, `shutdown`) for shell consumers. Maintained by session-start, session-close, heartbeat, and hermit-stop.
- **Routine proposals** — `reflect` can suggest new routines when it detects repeating operator request patterns. `proposal-act` handles `Type: routine` proposals by adding config entries directly.
- **Brief `--morning`/`--evening` flags** — Routine-optimized variants: morning emphasizes forward-looking content (priorities, proposals), evening emphasizes backward-looking (completed work, cost, findings). Framing adapts to `always_on` setting.
- **New config keys** — `idle_behavior` (default `"wait"`), `idle_budget` (default `"$0.50"`), `heartbeat.stale_threshold` (default `"2h"`), `routines` (default `[]`).

### Changed

- **Morning/evening routines** — Moved from LLM heartbeat evaluation to shell-level routine watcher. Timing is now deterministic (exact HH:MM) instead of probabilistic. Existing config is migrated automatically on upgrade.
- **Idle agency** — `heartbeat.idle_agency` boolean replaced by `idle_behavior` string for clearer semantics. `true` migrates to `"discover"`, `false` to `"wait"`.
- **Heartbeat edit subcommand** — Now shows item count and offers to migrate overgrown items to routines.
- **Self-evaluation** — Added checklist weight check (warns if > 10 items).

### Deprecated

- `heartbeat.morning_routine` — migrated to `routines[]` on upgrade
- `heartbeat.evening_routine` — migrated to `routines[]` on upgrade
- `heartbeat.idle_agency` — migrated to `idle_behavior` on upgrade
- `heartbeat._last_morning`, `heartbeat._last_evening` — replaced by routine watcher dedup
- `morning_brief` — migrated to `routines[]` on upgrade (if configured)

**What you need to do:**

1. Run `/claude-code-hermit:upgrade` to migrate config and refresh templates
2. Review migrated routines: `/claude-code-hermit:hermit-settings routines`
3. Optionally add `## When Idle` to OPERATOR.md and set `idle_behavior` to `discover`

---

## [0.0.8] - 2026-03-29

### Added

- **Deny pattern generation in `/init`** — new step 9 asks whether you're planning always-on operation and generates appropriate deny rules in `.claude/settings.json`, including OPERATOR.md write protection with `**/` prefix. Always-on set adds `git push --force`, `git reset --hard`, `chmod 777`.
- **Deny patterns in `/docker-setup`** — Docker means always-on, so the full hardened deny set is included by default (no wizard).
- **Channel access control** — new `allowed_users` config (per-channel user ID allowlist). Absent field = accept all (backwards compatible). Empty array = accept none (explicit lockdown). Non-allowlisted users are silently ignored for all message types.
- **`AGENT_HOOK_PROFILE` protection** — boot script validates profile values and enforces a hardcoded `standard` floor in always-on mode. Agent cannot downgrade from `strict` to `minimal` by writing to config.json. `hermit-settings env` blocks modification of this key.
- **Evaluate-session hash optimization** — Stop hook now caches an MD5 hash of SHELL.md content. Skips evaluation when nothing changed since last run. SessionStart hook clears the hash for a clean slate each session.
- **Capability-gap awareness in reflect** — when idle, the hermit now thinks broader: missing heartbeat checks, OPERATOR.md gaps, sub-agents for recurring work, skills for repeated workflows. Only fires when SHELL.md status is `idle`.
- **Dismissed/deferred proposal awareness** — reflect reviews past dismissed and deferred proposals to avoid re-suggesting recently rejected ideas. Revisits if significantly more evidence has accumulated.
- **Self-contained capability proposals** — proposal-create now includes implementation templates for sub-agents, skills, heartbeat checks, and OPERATOR.md refinements. Each template is self-contained so the implementer can act without referencing external docs.
- **Security impact notes in proposals** — proposals that affect security boundaries (permissions, network access, credential handling) must clearly note the impact so the operator can make an informed decision.

### Changed

- **Docker config isolation** — container now uses a Docker named volume (`claude-config`) instead of bind-mounting `~/.claude`. Prevents container state from leaking into host interactive sessions. Volume persists across restarts.
- **Docker npm permissions** — npm globals installed as `claude` user via `NPM_CONFIG_PREFIX`, enabling Claude Code self-update without sudo.
- **Docker plugin installation** — entrypoint registers marketplaces and installs plugins on first boot using filesystem checks (not `claude plugin list`, which false-positives on project-scoped plugins).
- **Docker plugin root resolution** — `HERMIT_PLUGIN_ROOT` env var bridges the host-path `_plugin_root` in config.json to the container's actual plugin path. `hermit-run` checks the env var first.
- **Docker auto-memory seeding** — copies host `~/.claude/projects/<path-key>/memory/MEMORY.md` into the container on first boot so the hermit starts with full context.
- **Docker channel pairing** — entrypoint symlinks channel state dirs, pair command includes inline scope hint and fallback mv for plugins that hardcode `~/.claude/channels/`.
- **Docker git identity** — read-only bind-mount of `~/.gitconfig` (conditional on existence).
- **Docker `NODE_OPTIONS`** — sets `--max-old-space-size=4096` per official devcontainer recommendations.

**What you need to do:**

1. Run `/claude-code-hermit:upgrade` to refresh templates
2. **Deny patterns (recommended):** Add safety deny rules to `.claude/settings.json` — run `/claude-code-hermit:hermit-init` step 9 or add manually:
   ```json
   "permissions": {
     "deny": [
       "Bash(rm -rf *)",
       "Bash(git push --force*)",
       "Bash(git reset --hard*)",
       "Bash(chmod 777*)",
       "Bash(curl * | bash*)",
       "Bash(wget * | bash*)",
       "Edit(**/.claude-code-hermit/OPERATOR.md)",
       "Write(**/.claude-code-hermit/OPERATOR.md)"
     ]
   }
   ```
3. **Channel access control (optional):** Add `"allowed_users": {"discord": ["your-user-id"]}` to config.json to restrict who can send commands via channels
4. If using Docker: rebuild (`docker compose -f docker-compose.hermit.yml build`) to pick up the deny patterns

---

## [0.0.7] - 2026-03-28

### Changed

**Environment variable system redesigned**

Env vars are now managed in `config.json` `env` and written to `.claude/settings.local.json` at boot by `hermit-start`. This is the canonical Claude Code approach — settings.json `env` values are exported to all subprocesses (hooks, MCP servers, Bash tool calls).

**What changed:**

- `config.json` gains an `env` key with defaults: `AGENT_HOOK_PROFILE`, `COMPACT_THRESHOLD`, `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`, `MAX_THINKING_TOKENS`
- `hermit-start` writes `config.json` `env` into `.claude/settings.local.json` on every boot
- Only auth vars (`CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`) remain as shell env — everything else goes through settings.local.json
- Docker compose `environment:` section reduced to auth vars only
- Channel state dirs (`DISCORD_STATE_DIR`, `TELEGRAM_STATE_DIR`) move from compose env to `config.json` `env`

**What you need to do:**

1. Run `/claude-code-hermit:upgrade` — it adds the `env` key to your config.json with defaults
2. If you have channels configured, the upgrade also adds `DISCORD_STATE_DIR` / `TELEGRAM_STATE_DIR` to `env`
3. If you use Docker: rebuild (`docker compose -f docker-compose.hermit.yml build`) and regenerate compose with `/claude-code-hermit:docker-setup` to get the slimmed-down `environment:` section — or just remove the 5 non-auth env vars from your existing compose file manually

### Added

- **`docker.packages` in config.json** — project-specific apt packages for Docker containers. During `/docker-setup`, Claude analyzes the project (package.json, requirements.txt, Makefile, database configs, OPERATOR.md) and suggests system packages with reasoning. The operator approves/edits, and packages are included as a separate Dockerfile layer. Hermit plugins can also append packages in their init skill.
- **`/hermit-settings docker`** — view and edit Docker packages in config.json
- **`/hermit-settings env`** — view and edit env vars in config.json
- **Deep merge in `load_config()`** — partial config.json overrides of `env`, `heartbeat`, and `docker` no longer drop sibling defaults

### Fixed

- `load_config()` shallow merge bug — if config.json had `"env": {"AGENT_HOOK_PROFILE": "strict"}`, the other 3 default env vars were silently lost. Now deep-merges nested dicts.
- `load_config()` crash when `active_hours: null` in config.json — deep merge tried to unpack `None` as dict. Now guards with `or {}`.
- **Channel state dirs kept as OS env vars** — `DISCORD_STATE_DIR` / `TELEGRAM_STATE_DIR` are forwarded via tmux temp file and Docker compose `environment:`, not just `settings.local.json`. MCP servers (which channel plugins run as) inherit shell env but don't read `settings.local.json`.
- **Stale channel tokens cleaned from settings.local.json** — `hermit-start` now removes `*_BOT_TOKEN` vars from `.claude/settings.local.json` on every boot. If a bot token exists in both settings.local.json and `.claude.local/channels/<plugin>/.env`, the settings.local.json value overrides the file (via `process.env`) and goes stale silently when the token is rotated. The token should only live in the channel's `.env` file. Docker setup also cleans stale tokens when configuring channels.
- **Docker channel plugin workaround documented** — channel plugins v0.0.4 hardcode `~/.claude/channels/` in both MCP servers and skill files (`/discord:access`, `/discord:configure`). Docker setup now documents the `*_STATE_DIR` override and skill patching needed until Anthropic fixes this upstream.

---

## [0.0.6] - 2026-03-28

### Breaking

**State directory moved out of `.claude/`**

The hermit state directory has moved from `.claude/.claude-code-hermit/` to `.claude-code-hermit/` at the project root.

**Why:** Claude Code's `bypassPermissions` mode still prompts for writes to `.claude/` (except `.claude/commands`, `.claude/agents`, `.claude/skills`). The old path caused permission prompts on every SHELL.md update, heartbeat tick, and proposal write — defeating autonomous operation.

**What you need to do:**

1. Move your state directory:

   ```
   mv .claude/.claude-code-hermit .claude-code-hermit
   ```

2. Update `.gitignore` — find the `# claude-code-hermit` block and update the paths:

   ```
   # Before
   .claude/.claude-code-hermit/config.json
   .claude/.claude-code-hermit/sessions/
   .claude/.claude-code-hermit/proposals/
   .claude/.claude-code-hermit/templates/

   # After
   .claude/cost-log.jsonl
   .claude-code-hermit/config.json
   .claude-code-hermit/sessions/
   .claude-code-hermit/proposals/
   .claude-code-hermit/templates/
   ```

3. Update `.claude/settings.json` permissions — in `permissions.allow`, replace:
   - `"Edit(.claude/.claude-code-hermit/**)"` → `"Edit(.claude-code-hermit/**)"`
   - `"Write(.claude/.claude-code-hermit/**)"` → `"Write(.claude-code-hermit/**)"`

4. **If you have a custom hermit** with skills, agents, or scripts that reference `.claude/.claude-code-hermit/` — update those references to `.claude-code-hermit/` before running `/claude-code-hermit:upgrade`

Then run `/claude-code-hermit:upgrade` — it will refresh templates and clean up any remaining stale permissions.

---

## [0.0.5] - 2026-03-28

### Added

- **Docker as default always-on path** — new `docs/ALWAYS-ON.md` guide frames Docker as the recommended way to run autonomous. Container isolation enables safe `bypassPermissions`.
- **`/docker-setup` skill** — generates project-adapted Dockerfile, docker-entrypoint.sh, docker-compose.yml, and .env. Checks prerequisites, refuses if Docker files already exist.
- **`/hermit-takeover` skill** — stops Docker container, marks session as `operator_takeover`, loads full hermit context, presents summary. For driving interactively with full continuity.
- **`/hermit-hand-back` skill** — summarizes operator activity via `git log` since takeover, optionally queues instructions in NEXT-TASK.md, restarts container.
- **`hermit-status` script** — pure bash, zero tokens. Reads `.status.json` sidecar and prints a one-liner: agent, project, status, task, progress, cost, blockers, Docker state.
- **`.status.json` sidecar** — cost-tracker hook now writes structured session data for the `hermit-status` script.
- **Conversational auto-triggers** — `session-close`, `proposal-list`, and `proposal-act` now activate from natural language ("I'm done", "any proposals", "accept PROP-003"). Slash commands remain as precision fallback.
- **`pattern-detect` → `reflect`** — renamed to match what it actually does: a reflection prompt, not algorithmic pattern detection.

### Changed

- **`docs/ALWAYS-ON-OPS.md`** — Docker section removed (now in ALWAYS-ON.md). Retained as operational reference: lifecycle, security, channels, cost management. Renumbered sections.
- **`README.md`** — Quick Start step 4 is now "Go always-on (recommended)" with `/docker-setup`. Bare tmux demoted to fallback note. Documentation table updated.
- **`docs/HOW-TO-USE.md`** — "Going Always-On" section rewritten: Docker recommended, bare tmux as fallback.
- **`docs/SKILLS.md`** — added Docker & Takeover category with 3 new skills (18 total).
- **`init` skill** — now copies `hermit-status` to `bin/` alongside existing scripts.

---

## [0.0.4] - 2026-03-27

### Breaking

**Hermit plugin authors:** the following contracts changed.

| Contract            | v0.0.3                        | v0.0.4                                                                |
| ------------------- | ----------------------------- | --------------------------------------------------------------------- |
| Learning trigger    | session-close invokes reflect | Reflection fires independently (heartbeat, natural pause, end of day) |
| Reflect input       | Last 5 archived reports       | Memory + SHELL.md + cost-log                                          |
| Session close       | Mandatory for learning        | Optional — still useful for audit trail                               |
| Idle behavior       | Dormant                       | Active (gated by escalation)                                          |
| Report prerequisite | 3+ archived reports           | None                                                                  |

### Added

- **Memory-driven learning** — reflect (formerly pattern-detect) rewritten as a reflection prompt. Uses auto-memory as primary input instead of scanning archived reports. No report prerequisite — learns from day one.
- **Idle agency** — heartbeat checks for autonomous work during idle: NEXT-TASK.md pickup, reflection (every 4+ hours), priority alignment check, maintenance. Gated by escalation level (conservative=alert, balanced=auto-start, autonomous=full auto).
- **Daily rhythm** — morning routine (first heartbeat tick of active hours: brief, proposal review, priority check) and evening routine (last tick: daily journal archived as S-NNN, reflection, tomorrow prep). Both fire once per day.
- **Self-awareness** — behavioral instruction in CLAUDE-APPEND giving the agent permission to stop when stuck. Three triggers: repeated failures, approach reversals, disproportionate cost. Escalation-gated response.
- **Daily summary reports** — evening routine creates S-NNN reports directly (bypasses session-mgr) for mixed days. `## Task` reads "Daily summary — [date]", Plan section omitted.
- **New config keys** — `heartbeat.morning_routine`, `heartbeat.evening_routine`, `heartbeat.idle_agency` (all default `true`), plus internal tracking keys `_last_morning`, `_last_evening`, `_last_reflection`.
- **New hermit-settings subcommands** — `routines` (morning/evening toggle), `idle-agency` (autonomous idle toggle).
- **New init wizard questions** — daily routines and idle agency (both default yes).

### Changed

- **reflect** (formerly pattern-detect) — full rewrite from 125-line report-scanning algorithm to ~20-line reflection prompt. Drops 4 deterministic categories, 3-report minimum, and report reading. Keeps proposal pipeline, dedup, feedback loop, stale flags.
- **heartbeat** — gains idle agency and daily routines. Old "NEXT-TASK.md auto-pickup" section subsumed by idle agency.
- **SHELL.md template** — Plan table is now optional (commented out). Progress Log is the primary record.
- **HEARTBEAT.md template** — grouped structure (Task Checks, Idle Checks, Standing Checks).
- **CLAUDE-APPEND** — gains Self-Awareness, Idle Behavior, Daily Rhythm, and Learning Model sections.
- **session-close** — reflect wording updated (reflects on experience, not reports).
- **session** — reflect reference updated, quick-task skip note added.
- **session-start** — runs morning routine inline for interactive mode.
- **brief** — gains daily summary format variant.

### Design Principle

Hermit is the scheduler and the policy layer. Claude is the intelligence. Hermit says _when_ and _whether_. Claude figures out _how_. Never specify what Claude Code already handles natively.

---

## [0.0.3] - 2026-03-26

### Breaking

`skip_permissions` (boolean) in `config.json` has been replaced by `permission_mode` (string). Update any existing `config.json` manually:

```json
// Before
"skip_permissions": false

// After
"permission_mode": "acceptEdits"
```

Valid values: `"default"`, `"acceptEdits"`, `"dontAsk"`, `"bypassPermissions"`. See [Permission Modes](https://code.claude.com/docs/en/permission-modes).

### Added

- **Unified session lifecycle** — idle transitions happen at every task boundary, regardless of how the session was started. Agent archives the report, says "What's next?", and waits. No prompt, no binary choice.
- **Best-effort heartbeat in interactive idle** — heartbeat starts on idle transition if enabled in config. Runs while terminal is open; always-on mode retains guaranteed heartbeat via tmux.

### Changed

- **`permission_mode` config key** — replaces `skip_permissions: bool` with a string enum matching Claude Code's permission mode flags. Default is `"acceptEdits"` (auto-approves file edits, still prompts for shell commands). Use `"bypassPermissions"` for fully isolated containers/VMs.
- **session skill** — step 6 performs idle transition directly (no longer defers to `/session-close`). Identical path for interactive and always-on.
- **session-close skill** — full shutdown only. No close mode decision tree, no confirmation prompt, no `--idle` path.
- **session-start, status, brief skills** — idle state no longer described as "always-on only"
- **heartbeat skill** — persistence section updated; interactive best-effort note added
- **CLAUDE-APPEND** — unified lifecycle section replaces separate interactive/always-on blocks
- **SHELL.md template** — "always-on mode" qualifiers removed from comments
- **SKILLS.md, ALWAYS-ON-OPS.md** — descriptions updated to reflect unified lifecycle
- **`heartbeat.enabled`** defaults to `true` (was `false`) — heartbeat is locally valuable during idle regardless of channels. **Highly advised for existing projects:** if your `config.json` has `"heartbeat": { "enabled": false, ... }`, set it to `true`. Without this, the agent will not start the heartbeat on idle transitions and you'll lose background monitoring between tasks.
- **`always_on`** template default fixed to `false` (was incorrectly `true`; it's a runtime flag set by hermit-start.py)
- **init wizard** — heartbeat step (4h) removed entirely; heartbeat starts automatically on first idle transition
- **hermit-settings** — heartbeat subcommand no longer gated on channels

### Removed

- Close mode decision tree in `session-close` (idle/shutdown branching, confirmation prompt)
- `--idle` flag on `/session-close` (idle transitions are automatic)
- "always-on only" qualifier on idle transitions throughout

---

## [0.0.2] - 2026-03-25

### Breaking

**Hermit authors must update.** Core terminology and filenames have changed. Hermit plugins (e.g., `claude-code-dev-hermit`) must update their references to match.

**Filename renames:**

| Old                         | New                                         |
| --------------------------- | ------------------------------------------- |
| `sessions/ACTIVE.md`        | `sessions/SHELL.md`                         |
| `ACTIVE.md.template`        | `SHELL.md.template`                         |
| `NEXT-MISSION.md`           | `NEXT-TASK.md`                              |
| `CREATING-DOMAIN-PACK.md`   | `CREATING-YOUR-OWN-HERMIT.md`               |
| `CREATING-PROJECT-AGENT.md` | _(merged into CREATING-YOUR-OWN-HERMIT.md)_ |

**Section renames in SHELL.md / session reports:**

| Old                          | New               |
| ---------------------------- | ----------------- |
| `## Mission`                 | `## Task`         |
| `## Steps`                   | `## Plan`         |
| `\| Step \|` (column header) | `\| Plan Item \|` |
| `## Discoveries`             | `## Findings`     |
| `Missions Completed`         | `Tasks Completed` |

**Terminology renames (docs, skills, agents):**

| Old                        | New      |
| -------------------------- | -------- |
| Domain pack                | Hermit   |
| Hermit agent               | Hermit   |
| Mission (session goal)     | Task     |
| Steps (ordered work items) | Plan     |
| Discoveries                | Findings |

**What hermit authors need to do:**

1. Update all file path references: `sessions/ACTIVE.md` → `sessions/SHELL.md`
2. Update section references: `## Mission` → `## Task`, `## Steps` → `## Plan`, `## Discoveries` → `## Findings`
3. Update `NEXT-MISSION.md` → `NEXT-TASK.md` in any skill that reads/writes it
4. Update `CLAUDE-APPEND.md` to use new section names
5. Replace "domain pack" or "hermit agent" with "hermit" in docs and skill descriptions
6. Run `/claude-code-hermit:upgrade` in target projects to refresh templates

### Added

- **Session lifecycle docs** — Close Mode Decision Tree, Always-On Task Loop, When Self-Learning Fires (ALWAYS-ON-OPS.md sections 1b-1d)
- **Cross-references** — ARCHITECTURE.md and HOW-TO-USE.md link to the new lifecycle sections

### Changed

- **README rewrite** — new intro, Quick Start with channels step, "What It Does" / "What Makes It Different" / "Hermits" sections
- **Consolidated docs** — CREATING-PROJECT-AGENT.md and CREATING-DOMAIN-PACK.md merged into CREATING-YOUR-OWN-HERMIT.md ("Create Your Own Hermit")
- **Trimmed generic content** — CREATING-YOUR-OWN-HERMIT.md now references official Claude Code plugin docs instead of duplicating frontmatter/hook/skill field tables
- **Terminology cleanup** — "hermit agent" replaced with "hermit" across all files (~57 occurrences in 17 files). A hermit is a domain-specific plugin (e.g., dev hermit, infra hermit), not an "agent"

---

## [0.0.1] - 2026-03-25

### Added

- Initial release
- **Session discipline** — task-driven sessions with tracked plans, cost logging, and archived reports
- **15 skills**: session, session-start, session-close, status, brief, monitor, heartbeat, hermit-settings, proposal-create, proposal-list, proposal-act, reflect, channel-responder, init, upgrade
- **session-mgr agent** for session lifecycle management
- **Boot scripts** (`hermit-start.py`, `hermit-stop.py`) for tmux-based headless operation
- **Hook infrastructure** — cost tracking, compact suggestions, session evaluation, session-diff
- **Learning loop** — cross-session pattern detection with auto-generated proposals
- **Proposal system** — numbered proposals with accept/defer/dismiss workflow
- **Heartbeat** — background checklist with self-evaluation and channel alerts
- **Monitoring** — session-aware condition watching
- **Channel support** — Telegram, Discord, iMessage integration
- **Remote control** — browser/phone access via claude.ai/code (enabled by default)
- **Agent identity settings** — name, language, timezone, escalation, sign-off
- **Upgrade skill** with version tracking in config.json
- **OPERATOR.md onboarding** — agent-driven project context generation
- **Documentation** — HOW-TO-USE, ARCHITECTURE, SKILLS, ALWAYS-ON-OPS, UPGRADING, TROUBLESHOOTING, CREATING-YOUR-OWN-HERMIT, OBSIDIAN-SETUP
