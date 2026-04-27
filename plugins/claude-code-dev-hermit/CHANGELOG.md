# Changelog

## [0.2.0] - 2026-04-27

### Added

- **`/dev-branch` skill** — feature-branch creation gate. 8 checks: prerequisites, clean tree, fetch, base resolve, worktree/name collision, checkout from `origin/<base>`.
- **`/dev-up` skill** — boot a session-scoped dev server in a Monitor entry; gated on ports, optional auth probe, optional HTTP health-poll until 2xx.
- **`/dev-down` skill** — stop the dev-server Monitor entry; runs `commands.dev_stop` if configured, else SIGTERM-drain-SIGKILL via `/watch`.
- **`/dev-log-watch` skill** — generator emitting a Monitor entry that tails the dev log; rotating-vs-fixed pattern detection per stack.
- **`/dev-status` skill** — three-line read-only status: branch, dev-server, worktree refs. Fail-soft per section, no setup required.
- **`scripts/lib/` shared Node helpers** — `resolve-command`, `port-check`, `health-poll`, `log-watch-builder`, `shell-utils`, each with a co-located `.test.js`.
- **`docs/DEV-LOG-WATCH.md`** — recipe for tailing rotating dev logs into a `/watch` monitor. Cross-linked from `/dev-log-watch`.

### Changed

- **`dev-doctor` check #4 promoted WARN → FAIL** — missing/empty `protected_branches` now hard-fails; required by `/dev-branch` base resolution.
- **`dev-doctor` check #14 added** — env-leakage scan flags credential-like keys in auto-loaded `.env*` files; framework-public prefixes excluded.
- **`dev-doctor` checks #15–17 added** — `commands.dev_start` reachable; `dev_log_path_pattern` parent exists; `dev_required_ports` range and `dev_expected_listeners ⊆ dev_required_ports`.
- **`dev-doctor` check #5 migrated to `scripts/lib/resolve-command.js`** — same behaviour as before; single source of truth shared with check #15.
- **`dev-adapt` extended for dev-server profiling** — new "Dev environment" proposal block detects `commands.dev_start`, ports, health URL, auth, log pattern. Skipped on mobile/desktop/library projects.
- **`CLAUDE-APPEND.md`: `/dev-branch` step inserted into Implement** — main session runs `/dev-branch` first when on a protected branch.
- **`CLAUDE-APPEND.md`: Local Dev Environment subsection added** — frames `/dev-up`/`/dev-down`/`/dev-log-watch` as operator-invoked, session-scoped (Monitor stops at `/session-close`).
- **`docs/SKILLS.md` now documents all nine skills** — backfilled `dev-adapt`/`dev-branch`/`dev-doctor`; added `dev-up`/`dev-down`/`dev-log-watch`/`dev-status`.
- **README skills table + hatch Available-skills report list the five new skills** — discoverable post-install. README "How It Works" Implement step names `/dev-branch` explicitly; lifecycle-skills preamble added.
- **plugin.json: native `dependencies` field added; range tightened to `^1.0.18`** — enables Claude Code's native resolver to auto-install core; `required_core_version` and `requires` stay `>=` for runtime gating.
- **manifest: move hermit-internal fields to `hermit-meta.json` sidecar.** `required_core_version` and `requires` removed from `plugin.json` so `claude plugin tag --push` passes the native validator cleanly.
- **Prerequisite bumped to Claude Code v2.1.110+** — required by `claude plugin tag` and the dep resolver. Updated `docs/HOW-TO-USE.md`, `CONTRIBUTING.md`.
- **Per-plugin release skill removed** — root `/release claude-code-dev-hermit` covers the full validation suite; per-plugin skill was a lower-fidelity duplicate.
- **core requirement bumped to `>=1.0.21` / `^1.0.21`** — was `>=1.0.18` / `^1.0.18`. Aligns the dev plugin with the upcoming core release. `required_core_version` + `requires` (in `hermit-meta.json`) and `dependencies[0].version` (in `plugin.json`) all bumped together. Updated `README.md` (badge + Prerequisites), `CLAUDE.md` (Depends On), `CONTRIBUTING.md` (also clears stale `v1.0.16+` reference).

### Files affected

| File | Change |
|------|--------|
| `skills/dev-branch/SKILL.md` | Added: feature-branch creation gate (8 checks) |
| `skills/dev-up/SKILL.md` | Added: boot the session-scoped dev server (7 gates) |
| `skills/dev-down/SKILL.md` | Added: stop the dev server (3 gates) |
| `skills/dev-log-watch/SKILL.md` | Added: generate a Monitor entry tailing dev logs (4 gates) |
| `skills/dev-status/SKILL.md` | Added: read-only branch/dev-server/worktree status (fail-soft) |
| `scripts/lib/resolve-command.js` + `.test.js` | Added: shared command-resolver; powers dev-doctor #5/#15 |
| `scripts/lib/port-check.js` + `.test.js` | Added: lsof/ss listener probe with allowlist match |
| `scripts/lib/health-poll.js` + `.test.js` | Added: HTTP health probe with retry until timeout |
| `scripts/lib/log-watch-builder.js` + `.test.js` | Added: emits canonical bash one-liner per `dev_log_path_pattern` shape |
| `scripts/lib/shell-utils.js` | Added: shared POSIX single-quote escaper |
| `scripts/lib/skill-structure.test.js` | Added: structural lint for new SKILL.md files |
| `skills/dev-adapt/SKILL.md` | Extended: Dev environment proposal block + fourth AskUserQuestion |
| `skills/dev-doctor/SKILL.md` | Check #4 WARN→FAIL; checks #14, #15, #16, #17 added; #5 migrated to helper |
| `docs/DEV-LOG-WATCH.md` | Added: recipe for tailing rotating dev logs |
| `docs/SKILLS.md` | Backfilled dev-adapt/dev-branch/dev-doctor; added dev-up/dev-down/dev-log-watch/dev-status |
| `skills/hatch/SKILL.md` | Available-skills report lists dev-branch + dev-up/dev-down/dev-log-watch |
| `state-templates/CLAUDE-APPEND.md` | dev-branch step inserted into Implement; Local Dev Environment subsection added |
| `README.md` | New skills rows in table; DEV-LOG-WATCH link; Implement step + lifecycle preamble |
| `CLAUDE.md` (plugin-local) | Refreshed Plugin Structure to match new layout |
| `docs/HOW-TO-USE.md` | Prerequisite: v2.1.80+ → v2.1.110+ |
| `CONTRIBUTING.md` | Prerequisite: v2.1.80+ → v2.1.110+ |
| `.claude-plugin/plugin.json` | `dependencies` array added; range tightened to `^1.0.18` |
| `.claude/skills/release/SKILL.md` | Deleted: superseded by root `/release` skill |
| `.claude-plugin/hermit-meta.json` | `required_core_version` + `requires`: `>=1.0.18` → `>=1.0.21` |
| `.claude-plugin/plugin.json` | `dependencies[0].version`: `^1.0.18` → `^1.0.21` |
| `README.md` | Badge + Prerequisites line: `v1.0.18+` → `v1.0.21+` |
| `CLAUDE.md` | Depends On: `v1.0.18+` → `v1.0.21+` |
| `CONTRIBUTING.md` | Prereq: `v1.0.16+` → `v1.0.21+` (stale) |

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Run `/claude-code-dev-hermit:dev-adapt`** to populate `protected_branches` (now FAIL if missing) and the new `dev_*` config block.
2. **Refresh `state-templates/CLAUDE-APPEND.md`** so projects pick up the `/dev-branch` Implement step and the Local Dev Environment subsection.

**Note:** `/dev-up`, `/dev-down`, `/dev-log-watch`, and `/dev-status` ship enabled but the new `dev_*` keys are individually optional — configs without them are unaffected, and the lifecycle skills refuse cleanly when their fields are unset. `dev-doctor` check count: 13 → 17.

`config.json` schema additions (all under `claude-code-dev-hermit.*`, all optional): `commands.dev_start`, `commands.dev_stop`, `dev_required_ports`, `dev_expected_listeners`, `dev_health_url`, `dev_health_timeout_secs`, `dev_auth_check`, `dev_log_path_pattern`, `dev_error_pattern`, `dev_noise_pattern`. `commands.dev_start` is the minimum for `/dev-up`.

## [0.1.9] - 2026-04-27

### Changed

- **Monorepo housekeeping.** Plugin source moved into `plugins/claude-code-dev-hermit/` of the `gtapps/claude-code-hermit` monorepo. `required_core_version` reconciled to semver-range form (`>=1.0.18`); a parallel `requires.claude-code-hermit` field was added to mirror it. Inner `.claude-plugin/marketplace.json` removed (the repo-root marketplace catalog is now authoritative). README and Documentation links now point at the monorepo.

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. No operator action required — internal manifest cleanup only.

No `config.json` changes required.

## [0.1.8] - 2026-04-24

### Changed
- **Minimum core version bumped to v1.0.18** — adapts to the `/doctor` → `/hermit-doctor` rename in claude-code-hermit v1.0.18; `dev-doctor` manual mode composition and the hatch prereq gate are updated accordingly.

### Added
- **`docs/WORKFLOW.md`** — end-to-end task lifecycle reference (what fires, in what order, what state it writes); linked from README Documentation.

---

## [0.1.7] - 2026-04-24

### Added
- `create-pr` skill — push, draft title/body, open PR via `gh`
- `dev-doctor` skill — manual + scheduled modes, composes core validators
- `dev-adapt` skill — project profiling, config persistence, compiled artifact
- Implementer stop conditions + config-driven test command
- Config-driven `git-push-guard` with tokenizer parser + propagate protected branches

### Fixed
- Hardened implementer worktree isolation — branch-handoff, safety rails, `.worktreeinclude`
- Implementer handoff, dev-quality bugs, commit-format detection

### Changed
- Rewrote `/dev-quality` — deterministic commands, surgical undo, judgment risk assessment
- Namespaced dev-hermit config keys under `claude-code-dev-hermit`

---

## [0.1.6] - 2026-04-22

### Changed

- **implementer: stronger Concerns contract** — The Concerns return section now requires flagging any non-obvious, load-bearing choice with a `Rejected alternatives:` sub-bullet naming what was considered and why it was rejected. This prevents the main session from "tidying" the implementer's code into a regression (motivated by a real incident where a misleading PHPDoc caused the caller to replace correct-but-unusual framework wiring with a more idiomatic approach that failed). The implementer also now treats caller-provided architectures (e.g. from `/feature-dev:feature-dev`) as hard constraints, surfacing deviations in Concerns rather than silently picking a different approach.
- **dev workflow: verify before overriding implementer choices** — `CLAUDE-APPEND.md` step 3 now instructs the main session to run the implementer's tests before overriding any non-obvious choice; if they pass, the choice should be treated as potentially load-bearing and traced before replacement. If no tests exist, trace before overriding.
- **dev workflow: `/dev-quality` vs `/simplify` clarification** — Step 4 now explains that `/dev-quality` is the end-of-task gate (it wraps `/simplify` plus test invocation); direct `/simplify` calls should be reserved for mid-task cleanup and post-`/batch` follow-up only. Consistent across `CLAUDE-APPEND.md`, `HOW-TO-USE.md`, and `README.md`.
- **dev workflow: optional planning gate via feature-dev** — A new optional step between Plan and Implement suggests running `/feature-dev:feature-dev` when the task touches unfamiliar code paths or framework internals (features, refactors, or bugfixes alike — trigger is unfamiliarity, not urgency). The chosen architecture should be recorded in the Task or Progress Log before invoking the implementer. Updated across `CLAUDE-APPEND.md`, `HOW-TO-USE.md`, `README.md`, and `RECOMMENDED-PLUGINS.md`.
- **dev-quality: code-review step removed** — `/simplify` already runs parallel reuse/quality/efficiency review agents on the changed files, so the follow-up `code-review:code-review` call was redundant overhead for the typical solo workflow. The pass is now tests → `/simplify` → tests. The `code-review` plugin remains an optional companion in `hatch` for PR review, security-sensitive code, and large refactors — invoke `/code-review` explicitly when the stakes warrant it.
- **hatch: no scheduled_checks entry for code-review** — since it is no longer part of any default code path, there is no reason to health-check it on a cadence. `docker.recommended_plugins` still records it when selected.

---

## [0.1.5] - 2026-04-22

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
