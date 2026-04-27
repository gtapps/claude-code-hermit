# Changelog

## [Unreleased]

### Added

- **`/dev-branch` skill** — create a feature branch from a clean tree before delegating to the implementer. Eight-gate validation: prerequisites, clean tree, fetch, base resolution from `protected_branches[0]` (skipping glob entries like `release/*`) with silent fallback to `origin/HEAD` / `main` / `master`, worktree collision (`git worktree list --porcelain`), branch-name collision (local + remote, offline-tolerant), checkout from `origin/<base>`, SHELL.md Progress Log append.
- **`/dev-up` skill** — boot a session-scoped dev server in a Monitor-managed subprocess. Seven gates: `commands.dev_start` configured, idempotency (skip if dev-server monitor already running and healthy — within-session only, registry clears at session-start), optional `dev_auth_check` probe, ports free or matched against `dev_expected_listeners` (lsof primary, ss fallback for slim containers), tools available, register `id: "dev-server"` Monitor entry, optional HTTP health-poll until 2xx (timeout `dev_health_timeout_secs`, default 30s — bump for JVM/Rust cold starts). Operator-invoked; no auto-trigger.
- **`/dev-down` skill** — stop the dev-server Monitor entry. Three gates: registry has dev-server, run `commands.dev_stop` if configured (docker-compose / supervisord / foreman) else SIGTERM-drain-SIGKILL via the watch skill, re-probe ports with allowlist awareness.
- **`/dev-log-watch` skill** — generator that emits a Monitor entry tailing the project's dev log for error patterns. Detects `$(date ...)` substrings and emits the canonical midnight while-loop wrapper from `docs/DEV-LOG-WATCH.md` for rotating logs (Winston/Pino/structlog), or plain `tail -F` for fixed paths (Rails). Persists to `config.monitors[]` (auto-registers each session) or registers ad-hoc.
- **`/dev-status` skill** — three-line read-only status: current branch (clean/dirty + ahead/behind upstream), dev-server Monitor state (registry presence, `kill -0` pid liveness, optional 3s health probe via `scripts/lib/health-poll.js`), worktree refs (active count + sample, prunable count + sample with `git worktree prune` recovery hint). Fail-soft per section. Names recovery commands but never runs them. No setup required — works the moment any of the dev workflow is in use. Skill-structure tests extended to support gates=0 skills.
- **`scripts/lib/` shared Node helpers (Node stdlib only)** — `resolve-command.js` (env-strip, segment split, npx/bunx/pnpm-dlx/yarn-dlx/bun-x wrapper detection, `command -v` resolve; replaces inline prose in dev-doctor check #5 and powers new check #15), `port-check.js` (lsof `-F pcL +c0` field-marker parsing with `ss -ltnpH` fallback; allowlist regex match against process name), `health-poll.js` (Node `http`/`https` based; configurable timeout and interval, returns `{ok, status, elapsedMs}`), `log-watch-builder.js` (rotating-vs-fixed pattern detection, single-quote escaping, GNU/BSD `date` fallback embedded), `shell-utils.js` (shared POSIX single-quote escaper used by resolve-command and log-watch-builder). Each helper has a co-located `*.test.js` runner plus `skill-structure.test.js` for the three new SKILL.md files; 103 assertions total, all green. Helpers are dual-use: `require()` from skills via `node scripts/lib/...` CLI invocation, or import as Node modules in tests.
- **`docs/DEV-LOG-WATCH.md`** — recipe for tailing rotating dev logs into a `/watch` monitor. Documents the two non-obvious gotchas (block-buffered pipes silencing output, midnight date rollover) with a copy-paste bash one-liner and per-stack path-pattern table. Linked from README Documentation. Cross-references `/dev-log-watch` as the generator skill that emits the recipe.
- **`docs/SKILLS.md`: backfilled `dev-adapt`, `dev-doctor`, `dev-branch` sections + new `dev-up` / `dev-down` / `dev-log-watch` / `dev-status` entries** — was 3 of 5 skills before; now documents all ten skills.

### Changed

- **`dev-doctor` check #4 promoted to FAIL** — `claude-code-dev-hermit.protected_branches` missing or empty now hard-fails (was WARN). Required by `/dev-branch` base resolution and used by `/dev-cleanup`. Existing operators with no configured `protected_branches` should run `/claude-code-dev-hermit:dev-adapt`.
- **`dev-doctor` check #14 added — env-leakage scan** — warns when auto-loaded env files (`.env`, `.env.local`, `.env.development*`) contain credential-like keys (`*PASSWORD*`, `*SECRET*`, `*TOKEN*`, `*CREDENTIAL*`, `*PRIVATE_KEY*`, `*API_KEY*`). Excludes framework-public prefixes (`NEXT_PUBLIC_`, `VITE_`, `REACT_APP_`, `EXPO_PUBLIC_`, `PUBLIC_`, `VUE_APP_`), config-intent suffixes (`_NAME`, `_PREFIX`, `_LENGTH`, `_ENABLED`, `_URL`, `_HOST`, `_PATH`), and placeholder values. Recommends moving credentials to a non-auto-loaded file (e.g., `.env.local.dev-only`). Runs in both manual and scheduled modes.
- **`dev-doctor` checks #15–17 added; check #5 migrated to shared resolver** — #15 `commands.dev_start` reachable (FAIL on unresolvable binary; PASS-with-skip if null). #16 `dev_log_path_pattern` parent dir exists (WARN if missing — log file may not have rotated in yet). #17 `dev_required_ports` valid range and `dev_expected_listeners` ports ⊆ `dev_required_ports`. Check #5's inline parsing prose replaced with a one-line invocation of `scripts/lib/resolve-command.js` — same behaviour, single source of truth.
- **`dev-adapt` extended for dev-server profiling** — new "Dev environment" proposal block detects `commands.dev_start` (package.json scripts.dev / scripts.local:dev / language defaults), `dev_required_ports` (start-command parsing, framework conventions), `dev_health_url` (low-confidence proposal), `dev_health_timeout_secs` (60–120s for JVM/Rust/large monorepos), `dev_auth_check` (Infisical / direnv / op detection), `dev_log_path_pattern` (logs/ probe with date-suffix vs fixed-name discrimination), `dev_error_pattern` (stack-aware default — Winston/Pino/Lograge/Logback). Skipped entirely when no service-on-port signals are present (mobile, desktop, library projects). Operator confirms via a fourth AskUserQuestion (Yes/Edit/Skip).
- **`CLAUDE-APPEND.md`: Local Dev Environment subsection added** — documents `/dev-up`/`/dev-down`/`/dev-log-watch` as operator-invoked, session-scoped lifetime (Monitor stops at `/session-close`), no auto-trigger by design (operators add a memory rule for auto-fire, not a config flag), and points stdout/journald/Docker stacks at `docs/DEV-LOG-WATCH.md` `## Use instead` instead of forcing them through `/dev-log-watch`.
- **`scripts/lib/` flat-Node-stdlib structure introduced** — first shared-helpers directory in the plugin. Existing `scripts/git-push-guard.js` stays at the top level (single-purpose hook); cross-cutting helpers go under `lib/`. Same constraint set as core (no `package.json`, no `node_modules`).
- **CHANGELOG hygiene: duplicate `[Unreleased]` block removed** — orphan block that had been hanging around since pre-0.1.7 (all 13 entries already shipped in 0.1.7 / 0.1.8, cross-checked against the upstream subtree merge `72fd9a1`). The release skill only ever rewrites the canonical top-of-file `[Unreleased]`, leaving the duplicate untouched across multiple releases. Cleared for posterity.
- **`CLAUDE-APPEND.md`: dev-branch step inserted** — the Implement step now directs the main session to run `/dev-branch` first when on a protected branch. Reach caveat: existing projects pick up this change on next `/hermit-evolve` after the 0.1.10 release.
- **README skills table + hatch Available-skills report** — list `/dev-branch` so it is discoverable post-install.
- **docs: bump Claude Code prerequisite to v2.1.110+** — dep resolver and `claude plugin tag` both require v2.1.110+; operators on older versions can't install this plugin cleanly. Updated `docs/HOW-TO-USE.md` and `CONTRIBUTING.md`.
- **plugin.json: tighten `dependencies` range to `^1.0.18`** — caret range (`^1.0.18` = `>=1.0.18 <2.0.0`) is the conventional semver signal for "tested against this major version, expect patch-compat"; was `>=1.0.18` (open-ended upwards). `required_core_version` and `requires` remain `>=` for runtime minimum-version checks.
- **remove per-plugin release skill** — `.claude/skills/release/SKILL.md` deleted; the root `/release claude-code-dev-hermit` skill covers the full validation suite (tests, auditor, branch guard, stale refs). Per-plugin skill was a lower-fidelity duplicate with zero audience (standalone repo is a zombie redirect per CLAUDE.md).

### Files affected

| File | Change |
|------|--------|
| `skills/dev-branch/SKILL.md` | Added: feature-branch creation gate skill |
| `skills/dev-up/SKILL.md` | Added: boot the session-scoped dev server (7 gates) |
| `skills/dev-down/SKILL.md` | Added: stop the dev server (3 gates) |
| `skills/dev-log-watch/SKILL.md` | Added: generate a Monitor entry tailing dev logs (4 gates) |
| `skills/dev-status/SKILL.md` | Added: read-only branch / dev-server / worktree status (no gates, fail-soft) |
| `scripts/lib/resolve-command.js` + `.test.js` | Added: shared command-resolver (also powers dev-doctor #5/#15) |
| `scripts/lib/port-check.js` + `.test.js` | Added: lsof/ss listener probe with allowlist match |
| `scripts/lib/health-poll.js` + `.test.js` | Added: HTTP health probe with retry until timeout |
| `scripts/lib/log-watch-builder.js` + `.test.js` | Added: emits the canonical bash one-liner per `dev_log_path_pattern` shape |
| `scripts/lib/shell-utils.js` | Added: shared `shellQuote` (POSIX single-quote escape); eliminates duplication between resolve-command and log-watch-builder |
| `scripts/lib/skill-structure.test.js` | Added: structural lint for dev-up / dev-down / dev-log-watch / dev-status SKILL.md files (frontmatter, gate count or gate-less for status skills, internal links) |
| `skills/dev-adapt/SKILL.md` | Extended Step 1 reads (package.json scripts.dev, log dirs, auth files), new "Dev environment" proposal block in Step 2, new fourth AskUserQuestion in Step 3, schema additions in Step 4, dev-environment body section in Step 5, dev block in Step 6 report |
| `skills/dev-doctor/SKILL.md` | Check #5 prose replaced with helper invocation; checks #15–17 added |
| `docs/DEV-LOG-WATCH.md` | Added: recipe for tailing rotating dev logs; cross-link to `/dev-log-watch` generator |
| `docs/SKILLS.md` | Backfilled dev-adapt, dev-branch, dev-doctor; added dev-up, dev-down, dev-log-watch; count updated to nine |
| `skills/dev-doctor/SKILL.md` | Check #4 WARN → FAIL; check #14 added (env-leakage scan) |
| `skills/hatch/SKILL.md` | dev-branch + dev-up/dev-down/dev-log-watch added to Available-skills report |
| `state-templates/CLAUDE-APPEND.md` | dev-branch step inserted into Implement (unconditional); Local Dev Environment subsection added |
| `README.md` | dev-branch + dev-up + dev-down + dev-log-watch rows added to skills table; DEV-LOG-WATCH link |
| `CLAUDE.md` (plugin-local) | Plugin Structure refreshed — full skill list, `scripts/lib/` mention, `docs/` mention |
| `docs/HOW-TO-USE.md` | Prerequisite: v2.1.80+ → v2.1.110+ |
| `CONTRIBUTING.md` | Prerequisite: v2.1.80+ → v2.1.110+ |
| `.claude-plugin/plugin.json` | `dependencies[0].version`: `>=1.0.18` → `^1.0.18` |
| `.claude/skills/release/SKILL.md` | Deleted |
| `CHANGELOG.md` | Duplicate `[Unreleased]` block removed (debris from pre-0.1.7 cycle) |

### Upgrade Instructions

1. **`dev-doctor` check #4 is now FAIL on missing `protected_branches`.** If you have not run `/claude-code-dev-hermit:dev-adapt` since installing the plugin, do so now to populate `claude-code-dev-hermit.protected_branches` in `.claude-code-hermit/config.json`. Without this, `/dev-branch` cannot resolve a base and existing operators will see a new FAIL on their next `dev-doctor` run.
2. **`/dev-branch` workflow step lands via CLAUDE-APPEND.md.** Existing projects pick up the new step on next `/hermit-evolve` run after this release.
3. **`/dev-up`, `/dev-down`, and `/dev-log-watch` are opt-in via `/dev-adapt`.** Re-run `/claude-code-dev-hermit:dev-adapt` to detect and confirm the new `dev_*` config fields (`commands.dev_start`, `commands.dev_stop`, `dev_required_ports`, `dev_expected_listeners`, `dev_health_url`, `dev_health_timeout_secs`, `dev_auth_check`, `dev_log_path_pattern`, `dev_error_pattern`, `dev_noise_pattern`). Skip the dev-environment question for projects without a service-on-port dev workflow (mobile, desktop, libraries). Local Dev Environment subsection lands via CLAUDE-APPEND.md on next `/hermit-evolve`.
4. **dev-doctor check count: 14 → 17.** New checks #15 (dev_start binary reachable), #16 (dev_log_path_pattern parent exists), #17 (dev_required_ports valid range, expected_listeners ports ⊆ required_ports). Each PASS-with-skip when the underlying field is null — they only kick in once `/dev-adapt` populates the dev-environment block.

`config.json` schema additions: `claude-code-dev-hermit.commands.dev_start`, `commands.dev_stop`, `dev_required_ports`, `dev_expected_listeners`, `dev_health_url`, `dev_health_timeout_secs`, `dev_auth_check`, `dev_log_path_pattern`, `dev_error_pattern`, `dev_noise_pattern`. All optional individually; `commands.dev_start` is the minimum for `/dev-up`. Existing configs without any `dev_*` keys are unaffected — the new skills refuse cleanly with an actionable message.

- **CLAUDE.md tightened for contributor audience** — dropped the "This Repo is a Plugin" install block (duplicated in README) and the "Built-in Claude Code Skills Used" section (its actionable delegation guidance folded into Constraints); rewrote Core Contracts as 6 dense load-bearing items (profile values, `/session-close` is operator-only, ambient-rules meta-rule, learning loop, proposal-gate pointer, authoritative session-state path).
- **plugin.json: native `dependencies` field added** — `dependencies: [{ name: "claude-code-hermit", version: ">=1.0.18" }]` enables Claude Code's native dependency resolver to auto-install core; the hermit-internal `requires` field remains for runtime version gating.
- **release skill: double-dash tag format** — tag step now uses `claude plugin tag --push` (produces `claude-code-dev-hermit--vX.Y.Z`), which validates manifest/marketplace version agreement before tagging; `git tag vNEW` removed.
- **release skill: branch-agnostic push** — branch push uses plain `git push` so releases from non-main branches work correctly.

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
