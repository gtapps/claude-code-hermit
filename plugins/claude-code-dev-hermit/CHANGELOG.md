# Changelog

## [Unreleased]

### Changed

- **hooks and tests run on bun** — hooks.json command strings and the test runner invoke `bun` instead of `node` (bun migration, core #18; the bun >=1.3 requirement comes with the core plugin).

## [0.3.14] - 2026-06-05

### Changed

- **hatch + dev-quality: drop `code-review` companion plugin** — `code-review@claude-plugins-official` is built into Claude Code since v2.1.150; removed it from hatch's companion picker and the `/dev-quality` install guard (#279).

### Files affected

| File | Change |
|------|--------|
| `skills/hatch/SKILL.md` | Removed `code-review` from companion plugin picker |
| `skills/dev-quality/SKILL.md` | Updated references from `/code-review:code-review` to native `/code-review` |
| `state-templates/CLAUDE-APPEND.md` | Updated `/code-review:code-review` reference to native `/code-review` |
| `state-templates/CLAUDE-APPEND-SAFETY.md` | Updated `/code-review:code-review` reference to native `/code-review` |
| `CLAUDE.md` | Updated constraint prose and skill description |
| `README.md` | Updated dev-quality skill description |
| `docs/HOW-TO-USE.md` | Updated code-review invocation reference |
| `docs/WORKFLOW.md` | Updated code-review invocation reference |
| `docs/RECOMMENDED-PLUGINS.md` | Replaced code-review section with built-in note |

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Update the plugin.** Run `claude plugin update claude-code-dev-hermit --scope local` (or the scope you used at install).

No `config.json` changes required.

**Note:** If you have `code-review@claude-plugins-official` installed, it still works — the native `/code-review` is also available and no longer requires the companion plugin.

## [0.3.13] - 2026-06-04

### Fixed

- **dev-quality Gate 0: protected-branch hint** — on a clean tree on a protected branch, point to §Branch Discipline instead of the generic nested-repo hint (#267).
- **dev-pr Gate 1: HTTPS fallback when SSH unavailable** — when `git push` fails with `cannot run ssh`, retry over HTTPS via the forge's git-credential helper instead of a generic FAIL. Covers GitHub (`gh`, #234) and GitLab (`glab`, #246); other forges get a tailored message naming the manual recovery path. Makes `/dev-pr` work in Docker hermit containers without an `ssh` binary.
- **core requirement bumped to `>=1.1.9`** — aligns `required_core_version`, `requires`, and `dependencies` with the latest core release.

### Files affected

| File | Change |
|------|--------|
| `skills/dev-quality/SKILL.md` | Gate 0: protected-branch hint fix |
| `skills/dev-pr/SKILL.md` | Gate 1: HTTPS fallback for missing ssh binary |
| `.claude-plugin/hermit-meta.json` | `required_core_version` and `requires` bumped to `>=1.1.9` |
| `.claude-plugin/plugin.json` | `dependencies` bumped to `^1.1.9` |

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Update the plugin.** Run `claude plugin update claude-code-dev-hermit --scope local` (or the scope you used at install).

No `config.json` changes required.

## [0.3.12] - 2026-06-01

### Added

- **domain-brainstorm skill** — on-demand codebase friction brainstorm. Reads git churn, last test signal (`state/last-test.json`), manifest↔lockfile drift, and README coverage to emit at most 2 `[prefix]`-tagged improvement PROPs per invocation. Operator-invoked only; per-skill kill criteria (cut if triage-survival < 25% or PROP-acceptance < 30% after ≥8 runs).

### Changed

- **install/update commands use `--scope local`** — README and HOW-TO-USE corrected from `--scope project` (now invalid in recent Claude Code releases).
- **single-pass exception for domain-brainstorm proposals** — `CLAUDE-APPEND.md` and `CLAUDE-APPEND-SAFETY.md` note that condition (1) of the three-condition gate is waived for ideas surfaced by `/claude-code-dev-hermit:domain-brainstorm`.

### Files affected

| File | Change |
|------|--------|
| `skills/domain-brainstorm/SKILL.md` | New operator-invoked brainstorm skill |
| `CLAUDE.md` | Documented domain-brainstorm in Plugin Structure |
| `state-templates/CLAUDE-APPEND.md` | Single-pass exception for domain-brainstorm proposals |
| `state-templates/CLAUDE-APPEND-SAFETY.md` | Same single-pass exception |
| `README.md` | `--scope project` → `--scope local` |
| `docs/HOW-TO-USE.md` | `--scope project` → `--scope local`; domain-brainstorm tip added |
| `tests/skill-structure.test.js` | Added domain-brainstorm to skill matrix |

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Refresh the CLAUDE-APPEND block.** Re-run `/claude-code-dev-hermit:hatch` in each target project (or `/claude-code-hermit:hermit-evolve` which sibling-syncs all hermit plugin blocks). The updated template adds the single-pass exception to `§Dev Proposal Categories`.

No `config.json` changes required.

## [0.3.11] - 2026-05-31

### Added

- **worktree-boundary-guard hook** — when a session runs in a linked git worktree, blocks `Edit`/`Write` whose target escapes into the main checkout. Self-limiting (inert outside worktrees, so no profile gate); carve-out for shared `.claude-code-hermit/` state; disable with `WORKTREE_GUARD=off`.

### Changed

- **core requirement bumped to `>=1.1.7`** — aligns `required_core_version`, `requires`, and `dependencies` with the latest core release.

### Files affected

| File | Change |
|------|--------|
| `scripts/worktree-boundary-guard.js` | New PreToolUse hook for Edit/Write |
| `scripts/worktree-boundary-guard.test.js` | Tests for worktree-boundary-guard |
| `hooks/hooks.json` | Added PreToolUse entry for Edit\|Write matcher |
| `CLAUDE.md` | Documented worktree-boundary-guard |
| `state-templates/CLAUDE-APPEND.md` | Added worktree boundary rules to §Git Safety |
| `state-templates/CLAUDE-APPEND-SAFETY.md` | Added worktree boundary rules to §Git Safety |
| `docs/GIT-SAFETY.md` | Describes guard behavior and WORKTREE_GUARD=off escape hatch |
| `.claude-plugin/hermit-meta.json` | `required_core_version` bumped to `>=1.1.7` |
| `.claude-plugin/plugin.json` | `dependencies[0].version` bumped to `^1.1.7` |

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Refresh the CLAUDE-APPEND block.** Re-run `/claude-code-dev-hermit:hatch` in each target project (or `/claude-code-hermit:hermit-evolve` which sibling-syncs all hermit plugin blocks). The updated template includes the worktree boundary rules in §Git Safety.

No `config.json` changes required.

## [0.3.10] - 2026-05-23

### Changed

- **dev-quality: Gate 1 swaps to `/claude-code-hermit:simplify`** — requires core v1.1.2+. Reframes from bug-finding to cleanup; skill applies its own edits and reports a totals line. Gate 0 extended to accept untracked-only trees via `git status --porcelain`. Docs and state-templates realigned.

### Upgrade Instructions

1. **Refresh the CLAUDE-APPEND block.** Re-run `/claude-code-dev-hermit:hatch` in each target project (or `/claude-code-hermit:hermit-evolve` which sibling-syncs all hermit plugin blocks). The injected `§Implementation Flow`, `§Tests Before PR`, `§Technical Constraints`, and `§Dev Quick Reference` sections previously named `/code-review` as the wrapped skill; the canonical template now names `/claude-code-hermit:simplify`.

2. **Bump core hermit alongside this release.** Existing dev-hermit installs do not auto-update their core dependency on `/plugin update`. Operators on dev-hermit 0.3.10+ must also run `/plugin update claude-code-hermit` to land core 1.1.2+ which ships `/claude-code-hermit:simplify`. Without the core bump, `/dev-quality` Gate 1 will fail at the simplify invocation.

## [0.3.9] - 2026-05-21

### Fixed

- **hatch: duplicate dev block after core 1.1.1 target migration** — when core migrated to `CLAUDE.local.md`, the dev-hermit block remained in `CLAUDE.md` and a second was appended, producing duplicates. Upgrade Instructions run a one-shot migration to remove the stray block.

### Changed

- **hatch: target-aware CLAUDE-APPEND routing (GH #111 follow-up)** — reads `hatch-options.json` to write to `CLAUDE.local.md` or `CLAUDE.md`. Falls back to `claude plugin list --json` scope detection when core hatch hasn't run yet. Stamps 5-field schema on first run.
- **hatch: polish from code-review pass** — captures `prior_hatch_mode` before Step 5 overwrites it; Upgrade Step 3 is now fully unattended. Test coverage extended with 15 structural-lint assertions.

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill executes the following steps automatically (via Step 7's sibling upgrade flow, which runs every plugin's `### Upgrade Instructions` before its CLAUDE-APPEND sync). The migration is unattended — no operator prompts. `hermit-evolve` Step 7 re-syncs the canonical block to `hatch_target` afterwards.

1. **Resolve `hatch_target`.** Use the same fallback chain `hermit-evolve` Step 2a uses, substituting the dev marker: read `.claude-code-hermit/state/hatch-options.json` and use the `"target"` field; else check `CLAUDE.local.md` for `<!-- claude-code-dev-hermit: Development Workflow -->` → `hatch_target = "local"`; else check `CLAUDE.md` for the same marker → `hatch_target = "committed"`; else stop — the dev block is in neither file, nothing to migrate.

2. **Identify the non-target file.** `non_target = (hatch_target == "local") ? "CLAUDE.md" : "CLAUDE.local.md"`.

3. **If the marker is present in `non_target`, silently strip the marked block.** Per `/hatch`'s single-source-of-truth contract, the CLAUDE-APPEND template is authoritative and operator overrides belong outside the marked block, so no hand-edit preservation is needed. Step 7's sync re-appends the canonical block to `hatch_target` afterwards.

4. **If the marker is only in `hatch_target`:** no-op. Steady state — Step 7's normal sync handles routine version-bump replacement.

No `config.json` changes required.

## [0.3.8] - 2026-05-21

### Changed

- **dev-quality: adapted to CC 2.1.146 `/simplify` → `/code-review` rename** — all runtime invocations, state templates, and docs updated. `min_claude_code_version: ">=2.1.146"` added to `hermit-meta.json`. Requires Claude Code 2.1.146+.
- **dev-quality: post-rename polish** — fixes missed `simplify` ref in `WORKFLOW.md`; re-pads output block labels to 13-col width; disambiguates marketplace vs built-in `/code-review` in docs where both appear.
- **hatch: target-aware CLAUDE-APPEND routing (GH #111)** — reads `hatch-options.json` to write to `CLAUDE.local.md` or `CLAUDE.md`; prompts for Visibility on first run and stamps the file.

### Files affected

| File | Change |
|------|--------|
| `skills/dev-quality/SKILL.md` | `/simplify` → `/code-review` rename; 13-col label re-padding |
| `skills/hatch/SKILL.md` | Step 3 reads `hatch-options.json` to route CLAUDE-APPEND to correct target file |
| `state-templates/CLAUDE-APPEND.md` | `/simplify` references replaced with `/code-review` throughout |
| `state-templates/CLAUDE-APPEND-SAFETY.md` | Same `/code-review` rename pass |
| `docs/HOW-TO-USE.md` | "built-in `/code-review`" disambiguation where marketplace plugin referenced nearby |
| `docs/WORKFLOW.md` | Stale `simplify` ref fixed; same disambiguation rewording |
| `docs/RECOMMENDED-PLUGINS.md` | `/code-review:code-review` plugin reference updated |
| `.claude-plugin/hermit-meta.json` | `min_claude_code_version: ">=2.1.146"` added |
| `CLAUDE.md` | Hatch target-routing section added; `/code-review` references updated |
| `CONTRIBUTING.md` | Minor reference updates |
| `README.md` | `/code-review` reference updates |

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Update Claude Code** to version 2.1.146 or newer — `/code-review` is a built-in available from that version.
2. **Refresh the CLAUDE-APPEND block** — re-run `/claude-code-dev-hermit:hatch` in each target project to pick up the updated `/code-review` references and the target-aware routing fix.

No `config.json` changes required.

## [0.3.7] - 2026-05-16

### Changed

- **CLAUDE-APPEND, GIT-SAFETY: name `/dev-pr` as sanctioned push path** — ends the "Never git push" rule with a pointer to `/claude-code-dev-hermit:dev-pr`; softens "The operator pushes" to "Stop and ask." Closes PROP-027.
- **core requirement bumped to `>=1.0.40`** — aligns `required_core_version`, `requires`, and `dependencies` with the latest core release.

### Files affected

| File | Change |
|------|--------|
| `state-templates/CLAUDE-APPEND.md` | §Git Safety push rule now names `/dev-pr` as sanctioned alternative |
| `state-templates/CLAUDE-APPEND-SAFETY.md` | Same §Git Safety update |
| `docs/GIT-SAFETY.md` | Push rule prose aligned with templates |
| `docs/WORKFLOW.md` | Push rule sentence updated to match |
| `skills/dev-pr/SKILL.md` | Description updated: named as operator-sanctioned push primitive |
| `tests/hatch-mode.test.js` | Replaced "no /dev-pr in safety" assertion with positive named assertions for both templates |
| `.claude-plugin/hermit-meta.json` | Core requirement bumped to `>=1.0.40` |
| `.claude-plugin/plugin.json` | Core dependency bumped to `^1.0.40`; version bumped to 0.3.7 |

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Refresh the CLAUDE-APPEND block** — re-run `/claude-code-dev-hermit:hatch` in each target project to pick up the updated §Git Safety rule in the injected CLAUDE.md block.

No `config.json` changes required.

## [0.3.6] - 2026-05-13

### Changed

- **README, marketplace: git-safety-first reframe** — `git-push-guard` + CLAUDE-APPEND template are now the headline product; workflow skills (`/dev-pr`, `/dev-quality`, `/dev-test`) moved to "Optional workflow scaffolding." `/hatch` default flipped to `safety` for greenfield projects.
- **hooks: converted `git-push-guard` and `record-test-result` to exec form.** Aligns with core's exec-form sweep. Fixes path-with-spaces fragility on installs whose plugin dir contains a space.
- **core requirement bumped to `>=1.0.38`** — aligns `required_core_version`, `requires`, and `dependencies` with the latest core release.

### Fixed

- **git-push-guard: protected-name path-segment false-positive fixed** — `git push origin feature/main` was blocked because `/` was not treated as a word boundary. Guard now extracts the destination ref per refspec and uses exact-match regexes for non-glob patterns. Resolves PROP-015 item 1.
- **README, CLAUDE.md: `--force-with-lease` docs aligned with actual policy** — both previously claimed it was blocked unconditionally; code has allowed it on non-protected branches with an explicit refspec since v0.3.0. Resolves PROP-015 item 2.

### Files affected

| File | Change |
|------|--------|
| `README.md` | Git-safety-first reframe; optional workflow scaffolding block |
| `CLAUDE.md` | `--force-with-lease` policy aligned with actual code behavior |
| `docs/GIT-SAFETY.md` | `--force-with-lease` prose aligned with actual code behavior |
| `hooks/hooks.json` | `git-push-guard` and `record-test-result` converted to exec form |
| `scripts/git-push-guard.js` | Protected-branch path-segment false-positive guard; refspec extraction |
| `scripts/git-push-guard.test.js` | Tests for path-segment and refspec false-positive cases |
| `skills/hatch/SKILL.md` | Safety-first default when no existing commit/PR/release skills detected |
| `.claude-plugin/hermit-meta.json` | Core requirement bumped to `>=1.0.38` |
| `.claude-plugin/plugin.json` | Core dependency bumped to `^1.0.38`; version bumped to 0.3.6 |

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Update Claude Code** to version 2.1.139 or newer before pulling this release — the exec hook form requires it.
2. **Refresh hooks** — the updated `hooks.json` exec-form entries are installed on plugin update.

No `config.json` changes required.

## [0.3.5] - 2026-05-07

### Removed

- **git-commit-quality-gate: PreToolUse hook removed** — strict profile unconditionally blocked all commits; standard profile duplicated CLAUDE-APPEND guidance. PR-time enforcement via `/dev-pr` Gate 0 SHA check is unchanged. Resolves [#39](https://github.com/gtapps/claude-code-hermit/issues/39).

### Files affected

| File | Change |
|------|--------|
| `scripts/git-commit-quality-gate.js` | Deleted |
| `scripts/git-commit-quality-gate.test.js` | Deleted |
| `hooks/hooks.json` | `git-commit-quality-gate.js` PreToolUse entry removed |
| `CLAUDE.md` | Hook bullet and Hook Profiles paragraph updated |

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Refresh hook registration** — the removed hook is deregistered automatically on plugin update.

No `config.json` changes required.

## [0.3.4] - 2026-05-07

### Added

- **git-commit-quality-gate: new PreToolUse hook** — standard profile injects an `additionalContext` reminder; strict profile hard-blocks the commit (exit 2). Tokenizer parses `git -C <path> commit` and avoids false positives. Resolves [#30](https://github.com/gtapps/claude-code-hermit/issues/30).
- **dev-quality, dev-test, dev-pr: `--cwd <path>` argument** — scopes git ops, test runner, `/simplify`, and PR creation to a nested working tree (submodule, path workspace). Hermit state still lives under the parent's `.claude-code-hermit/`. Resolves [#32](https://github.com/gtapps/claude-code-hermit/issues/32).
- **record-test-result: `--cwd <path>` flag on `run` and `write` subcommands** — validates path is a git tree, spawns test command from `<path>`, captures child HEAD SHA. PostToolUse hook entry-point unchanged.

### Changed

- **Minimum core version bumped to `>=1.0.32`** — aligns `required_core_version`, `requires`, and `dependencies` with the upcoming core release.
- **`/dev-quality` Gate 0 clean-tree FAIL** — adds a `hint:` line pointing operators at `--cwd <path>` for nested-repo workflows. Hint suppressed when `--cwd` was already passed.

### Files affected

| File | Change |
|------|--------|
| `scripts/git-commit-quality-gate.js` | New profile-gated PreToolUse hook script |
| `scripts/git-commit-quality-gate.test.js` | Unit tests (tokenizer, both profile branches, false-positive cases) |
| `hooks/hooks.json` | Second `PreToolUse` Bash entry registered |
| `scripts/record-test-result.js` | `--cwd <path>` parsing on `run` and `write` |
| `scripts/record-test-result.test.js` | New `--cwd` cases (child-SHA capture, validation failures) |
| `skills/dev-quality/SKILL.md` | Argument section, target-aware gates, hint in Gate 0 FAIL |
| `skills/dev-test/SKILL.md` | Argument section + passthrough |
| `skills/dev-pr/SKILL.md` | Argument section + child-remote warning, target-aware gates |
| `state-templates/CLAUDE-APPEND.md` | Nested-repo reminders in §Implementation Flow, §Tests Before PR, §Dev Quick Reference |

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill picks up the new hook and skill prose automatically via plugin update — no `config.json` changes and no `/hatch` re-run required.

## [0.3.3] - 2026-05-03

### Added

- **record-test-result: `likely_cause` field in `last-test.json`** — classifies signal exits: `137` → `"oom"`, `124` → `"timeout"`, `130` → `"user-interrupt"`. Surfaced in `/dev-pr` Gate 0 and `/dev-quality` Gate 2 failure messages.
- **dev-quality: commits-ahead NOTICE on clean-tree Gate 0 fail** — emits the correct ordering (`/dev-quality → commit → /dev-pr`) and points to `/dev-test` for post-commit verification.
- **hatch: base-branch auto-detection** — detects common base branches from remote during capability scan. Writes `pr_base_branch` automatically when one candidate is found; prompts when multiple are detected.

### Changed

- **dev-pr: Gate 4 session-close nudge** — appends a `session-close` pointer after a successful PR create to reduce stale-session heartbeat alerts.
- **`/hatch` safety-mode skip list** — `pr_base_branch` added to the list of keys not written in safety mode (these feed `/dev-pr` which is not prescribed in that mode).
- **hatch: Docker network requirements section** — adds an "intentionally empty" Docker domains/LAN block explaining why the plugin cannot pre-declare DNS allowlist entries.
- **core requirement bumped to `>=1.0.26` / `^1.0.26`** — was `>=1.0.22` / `^1.0.22`. `required_core_version` + `requires` (in `hermit-meta.json`) and `dependencies[0].version` (in `plugin.json`) all bumped together. Updated `CLAUDE.md`, `CONTRIBUTING.md`, `docs/HOW-TO-USE.md`.

### Files affected

| File | Change |
|------|--------|
| `scripts/record-test-result.js` | Adds `likely_cause` classification for OOM, timeout, user-interrupt exits |
| `scripts/record-test-result.test.js` | Tests for `likely_cause` field and absence on generic exits |
| `skills/dev-quality/SKILL.md` | Gate 0: commits-ahead NOTICE when working tree is clean |
| `skills/dev-pr/SKILL.md` | Gate 4: session-close nudge appended after successful PR create |
| `skills/hatch/SKILL.md` | Base-branch detection, `pr_base_branch` safety-mode skip, Docker network section |
| `.claude-plugin/hermit-meta.json` | `required_core_version` and `requires` bumped to `>=1.0.26` |
| `.claude-plugin/plugin.json` | Version bump to 0.3.3; `dependencies` core entry bumped to `^1.0.26` |
| `.claude-plugin/marketplace.json` | Version synced to 0.3.3 |
| `CLAUDE.md` | Core dependency reference updated to v1.0.26+ |
| `CONTRIBUTING.md` | Core version reference updated |
| `docs/HOW-TO-USE.md` | Core version reference updated |

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Refresh skill files** — picks up updated `/dev-pr`, `/dev-quality`, and `/hatch` behavior.

No `config.json` changes required.

## [0.3.2] - 2026-04-29

### Added

- **`claude-code-dev-hermit.hatch_mode` config key** — `"safety"` | `"standard"`. Persists the operator's hatch mode across re-runs for CLAUDE-APPEND template selection.
- **`state-templates/CLAUDE-APPEND-SAFETY.md`** — new safety-mode template: §Git Safety, §Branch Discipline, §Technical Constraints, §Dev Knowledge, §Dev Proposal Categories, trimmed §Dev Quick Reference. Excludes §Implementation Flow, §Tests Before PR, and workflow skill references.

### Changed

- **CLAUDE-APPEND.md: "project conventions take precedence" preamble** — added to §Branch Discipline, §Implementation Flow, §Tests Before PR to avoid overriding existing commit/PR/release skills.
- **hatch: capability scan** — scans `.claude/skills/` for existing commit/PR/release skills; defaults mode prompt to `safety` if found, `standard` otherwise.
- **hatch: mode-conditional prompts** — safety mode skips workflow-key prompts (`commands.test`, `lint`, `format`, `pr_create`, `pr_template_path`); standard mode unchanged.
- **hatch: template selection** — injects `CLAUDE-APPEND-SAFETY.md` in safety mode, `CLAUDE-APPEND.md` in standard mode.

### Fixed

- **git-push-guard tests: `master`-branch cases falsely passing** — `runRaw` resolved the guard's CWD to the monorepo root, which has a config listing only `main`, overriding the `["main","master"]` default. Fixed by spawning tests in a fresh tmpdir with no hermit config.

### Files affected

| File | Change |
|------|--------|
| `scripts/git-push-guard.test.js` | Test isolation fix: tmpdir CWD in `runRaw`; `try/finally` in `runWithConfig`; `force: true` cleanup |
| `state-templates/CLAUDE-APPEND.md` | Precedence preambles added to §Branch Discipline, §Implementation Flow, §Tests Before PR |
| `state-templates/CLAUDE-APPEND-SAFETY.md` | New safety-mode template |
| `skills/hatch/SKILL.md` | Capability scan, mode question, conditional prompts, mode-aware template selection, `hatch_mode` persistence |
| `.claude-plugin/plugin.json` | Version bump to 0.3.2 |
| `.claude-plugin/marketplace.json` | Version synced to 0.3.2 |

### Upgrade Instructions

1. Ask the operator (`AskUserQuestion`): "Does this project already have its own `/commit`, `/create-pr`, or `/release` skills? Choose `safety` to keep dev-hermit's workflow sections out of CLAUDE.md, or `standard` for the full workflow (recommended for greenfield projects)." Options: `safety` / `standard`.
2. Write the chosen value to `.claude-code-hermit/config.json` under `claude-code-dev-hermit.hatch_mode`.
3. Tell the operator: "After this evolve completes, re-run `/claude-code-dev-hermit:hatch` to refresh your CLAUDE.md with the chosen mode. (hermit-evolve's CLAUDE-APPEND sync writes the standard template at the end of this run — that's expected; one `/hatch` re-run resolves it.)"

## [0.3.1] - 2026-04-29

### Added

- **`/dev-test` skill** — runs the configured test suite and records the result to `last-test.json`. Useful for mid-task verification and warming the `/dev-pr` cache.
- **`/dev-quality` skill** — re-introduced in leaner form: runs `/simplify` on the working-tree diff and re-runs `commands.test`. Surfaces failures; suggests `code-review:code-review` to the operator when installed (never invokes it autonomously).

### Changed

- **dev-pr: Gate 0 auto-runs tests on cache miss** — runs `record-test-result.js run` instead of blocking; fresh `status:"pass"` at current HEAD is a cache hit. Fixes #12.
- **record-test-result: `run` and `write` subcommands** — `run` executes `commands.test` and records exit code + duration; `write` is for direct callers and CI. Silently skips on missing exit code; skips interrupted runs.
- **dev-quality: test step records to `last-test.json`** — calls `record-test-result.js run` so the result is cached (SHA is pre-commit; `/dev-pr` re-runs after commit).
- **CLAUDE-APPEND.md: `/dev-quality` wired into §Implementation Flow and §Tests Before PR** — operators must re-run `/hatch` to refresh.

### Files affected

| File | Change |
|------|--------|
| `skills/dev-test/SKILL.md` | New skill — run tests and record result to `last-test.json` |
| `skills/dev-quality/SKILL.md` | New skill — `/simplify` + test re-run quality gate |
| `scripts/record-test-result.js` | Adds `run` and `write` subcommands; drops `status:"unknown"`; skips interrupted runs |
| `skills/dev-pr/SKILL.md` | Gate 0 auto-runs tests on cache miss instead of blocking |
| `state-templates/CLAUDE-APPEND.md` | §Implementation Flow step 4 + §Tests Before PR rewritten; §Dev Quick Reference updated |

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Re-run `/claude-code-dev-hermit:hatch`** in each project using this plugin to refresh the injected `CLAUDE.md` with the updated §Implementation Flow and §Tests Before PR sections.

No `config.json` changes required.

## [0.3.0] - 2026-04-28

**v0.3.0 — language-agnostic safety layer.** Dropped ~6,000 lines (~70%) to reframe dev-hermit as a thin safety layer. Now ships 2 skills (`hatch`, `dev-pr`), 1 hook (`git-push-guard`), and a CLAUDE-APPEND template. Implementer agent removed — operators use the native `Agent` tool or `feature-dev` agents governed by the injected rules.

### Changed

- **CLAUDE-APPEND.md: rewritten as rules-of-the-road** — new §Git Safety, §Branch Discipline, §Implementation Flow, §Tests Before PR sections. Dropped Dev Agent table, 7-step workflow, Local Dev Environment, Watchdog, Always-on Worktree Topology.
- **hatch: rewritten (271 → ~155 lines)** — subsumes `/dev-adapt` wizard prompts; idempotent; defaults to strict push-guard profile with explicit opt-out; detects GitLab vs GitHub for `commands.pr_create`.
- **dev-pr: rewritten (241 → ~140 lines)** — inline LLM body assembly replaces 240-line template-merge engine; dropped `--force` flag, alert-check gate, and `check-protected-branch.js` shell-out (replaced with inline bash glob).
- **git-push-guard: simplified (286 → ~85 lines)** — tokenizer replaced with regex chains; inlined `loadProtectedBranches`; walks up from cwd to find `.claude-code-hermit/`. `--force-with-lease` to non-protected branches with explicit refspec now allowed.
- **Docs: full rewrite for v0.3.0 identity** — `CLAUDE.md`, `README.md`, `HOW-TO-USE.md`, `WORKFLOW.md` rewritten; `GIT-SAFETY.md`, `RECOMMENDED-PLUGINS.md` trimmed.

### Removed

- **Implementer agent** (`agents/` directory) — safety rules now live in CLAUDE-APPEND; operators switch to native `Agent` or `feature-dev`. `hermit-evolve` surfaces this on next run.
- **Skills**: `dev-branch`, `dev-quality`, `dev-cleanup`, `dev-doctor`, `dev-adapt` (folded into `hatch`), `dev-up`, `dev-down`, `dev-log-watch`, `dev-status` — all removed; rules moved to CLAUDE-APPEND or left to operators.
- **Scripts**: watchdog pipeline (`watchdog-health.js`, `watchdog-errors.js`, `check-protected-branch.js`, ~1,370 lines) — Monitor's stderr-on-exit covers the use case.
- **`scripts/lib/`**: entire directory (~1,300 lines) — helpers inlined into `git-push-guard.js` and `/dev-pr` prose; thin wrappers removed.
- **Tests**: 10 test files whose subjects were deleted; 55 tests survive (9 structural lints + 46 push-guard cases).
- **Docs**: `docs/DEV-LOG-WATCH.md` removed; §Dev Agent table, §Watchdog, §Always-on Worktree Topology in CLAUDE.md replaced by safety rules on `hermit-evolve`.

### Files affected

| File | Change |
|------|--------|
| `agents/` (entire dir) | Removed — implementer agent gone |
| `skills/dev-branch/`, `skills/dev-quality/`, `skills/dev-cleanup/`, `skills/dev-doctor/`, `skills/dev-adapt/` | Removed — workflow ceremony skills |
| `skills/dev-up/`, `skills/dev-down/`, `skills/dev-log-watch/`, `skills/dev-status/` | Removed — dev-server orchestration skills |
| `skills/hatch/SKILL.md` | Rewritten (271 → ~155 lines): subsumes dev-adapt prompts, idempotent, strict-by-default |
| `skills/dev-pr/SKILL.md` | Rewritten (241 → ~140 lines): inline body assembly, new tests-ran gate, no --force flag |
| `scripts/git-push-guard.js` | Simplified (286 → ~85 lines): regex chains, lease carve-out, walk-up cwd resolution |
| `scripts/record-test-result.js` (+ test) | New PostToolUse hook: records test exit + duration + sha to state/last-test.json |
| `scripts/watchdog-health.js`, `scripts/watchdog-errors.js`, `scripts/check-protected-branch.js` (+ tests) | Removed |
| `scripts/lib/` (entire dir: alerts-store, dev-server-command, health-poll, log-watch-builder, port-check, pr-body-builder, protected-branches, resolve-command, shell-utils + tests) | Removed (~1,300 lines) |
| `state-templates/CLAUDE-APPEND.md` | Rewritten as the rules-of-the-road for any agent doing dev work |
| `hooks/hooks.json` | Registers new PostToolUse record-test-result hook |
| `tests/agents-structure.test.js`, 9 lib helper test files | Removed (subjects deleted) |
| `tests/skill-structure.test.js`, `tests/run-all.sh` | Updated — slimmed to surviving skills, dropped agents-test invocation |
| `CLAUDE.md`, `README.md`, `CONTRIBUTING.md` | Rewritten for v0.3.0 identity |
| `docs/HOW-TO-USE.md`, `docs/WORKFLOW.md`, `docs/GIT-SAFETY.md`, `docs/RECOMMENDED-PLUGINS.md` | Rewritten or substantively trimmed |
| `docs/DEV-LOG-WATCH.md` | Removed |

### Migration (operators upgrading from v0.2.x)

- **`subagent_type: implementer`** calls fall back to general-purpose — switch to native `Agent` or `feature-dev:code-architect` / `code-explorer`.
- **Inert config keys** (harmless but removable): `dev_health_url`, `dev_log_path_pattern`, `dev_error_pattern`, `dev_watchdog.*`, `commands.dev_start/stop`, `dev_port_agent`, `dev_required_ports`, `dev_auth_check`, `dev_expected_listeners`, `pr_title_format`, `pr_body_sections`. Workflow keys (`commands.test`, `lint`, `format`, `pr_create`, `protected_branches`, etc.) are preserved.
- **Removed skill invocations** (`/dev-up`, `/dev-down`, `/dev-log-watch`, `/dev-status`, `/dev-quality`, `/dev-cleanup`, `/dev-doctor`, `/dev-adapt`, `/dev-branch`) will fail with "skill not found" — use `tmux` / `Bash run_in_background` for dev servers; agent runs test-then-simplify directly via CLAUDE-APPEND.
- **`required_core_version`** unchanged at `>=1.0.22`.

### Upgrade Instructions

Executed by `/claude-code-hermit:hermit-evolve` Step 2b in oldest-first order. v0.3.0 is a breaking redesign — surface every change loudly to the operator before letting the upgrade complete.

1. **Announce the redesign.** Tell the operator: "claude-code-dev-hermit v0.3.0 is a breaking redesign — the plugin dropped ~70% of its surface to become a language-agnostic safety layer. The CLAUDE.md dev block, the implementer agent, and many skills are gone. Read the v0.3.0 CHANGELOG entry below before continuing." Show the `### Removed`, `### Changed`, and `### Migration` sections from this CHANGELOG entry.
2. **Re-run `/claude-code-dev-hermit:hatch`.** The plugin's CLAUDE-APPEND template is a full rewrite, so the marker block in the project's CLAUDE.md will be silently replaced by `hermit-evolve` Step 5 — but `/hatch` is what writes the new operator-facing config keys (`commands.test`, `commands.lint`, etc.) and installs the `git-push-guard` hook at strict profile. Ask the operator: "Re-run `/claude-code-dev-hermit:hatch` now? (Recommended — captures the new config keys and confirms strict hook profile.)" `Yes — run now` / `No — I'll do it later`. If yes, invoke `/claude-code-dev-hermit:hatch`.
3. **Surface the implementer-agent removal.** If `.claude/settings.json` (project or user scope), `OPERATOR.md`, any file under `.claude-code-hermit/sessions/`, or any project doc references `subagent_type: implementer` or `claude-code-dev-hermit:implementer`, list the files to the operator with the message: "These files reference the removed implementer agent. Switch to the native `Agent` tool or `feature-dev:code-architect` / `code-explorer` for planning. The native `Agent` tool reads CLAUDE.md (including the new dev-hermit safety rules) and follows them; you don't need a custom subagent for the safety layer." Use `grep -rln "implementer" <paths>` to detect.
4. **Inert config keys (advisory).** Read the operator's `.claude-code-hermit/config.json` and check for any of these keys under `claude-code-dev-hermit.`: `dev_health_url`, `dev_log_path_pattern`, `dev_error_pattern`, `dev_watchdog`, `commands.dev_start`, `commands.dev_stop`, `dev_port_agent`, `dev_required_ports`, `dev_auth_check`, `dev_expected_listeners`, `pr_title_format`, `pr_body_sections`. If any exist, tell the operator: "These keys are inert in v0.3.0 (harmless but unused). Remove at your convenience: <list>." Do NOT remove them automatically — operators may want to keep them as documentation.
5. **Force-with-lease policy change.** Tell the operator: "v0.3.0 changes the `git-push-guard` policy: bare `--force` and `-f` are still blocked, but `--force-with-lease` to a non-protected branch with an explicit refspec is now ALLOWED (the safe rebase-recovery case). `--force-with-lease` to protected branches and ambiguous-target leases remain blocked. See docs/GIT-SAFETY.md."
6. **Test-result recording is now automatic.** Tell the operator: "v0.3.0 ships a new `PostToolUse` hook (`record-test-result.js`) that captures the configured test command's exit code and HEAD sha into `.claude-code-hermit/state/last-test.json` whenever you run it. `/dev-pr` now refuses if no recent passing test result exists for the current HEAD. If `commands.test` was not configured by `/hatch` in step 2, configure it now or `/dev-pr` will refuse with 'no test result recorded'."

## [0.2.3] - 2026-04-28

### Added

- **`scripts/lib/protected-branches.js`** — shared protected-branch helpers (load, normalize, glob-match, isProtected) extracted from `git-push-guard.js`.
- **`scripts/check-protected-branch.js`** — CLI wrapper; exit 0 = not protected, exit 1 = protected. Used by implementer, `/dev-branch`, `/dev-cleanup`, and `/dev-pr` gates.
- **`tests/agents-structure.test.js`** — structural lint for `agents/*.md`: frontmatter, `isolation: worktree` absence, Step 0a/0b refusal language.
- **`tests/test-utils.js`** — shared `parseFrontmatter` helper used by both structural test files.

### Changed

- **implementer: caller contract** — removed `isolation: worktree`; caller must run `/dev-branch` first and pass its `Worktree:` token verbatim. Step 0a/0b gates refuse on missing token or protected branch.
- **dev-branch: worktree + token emission** — Gate 6 creates the worktree and emits `Worktree:`/`Branch:` tokens; Gate 0 short-circuits when already on a feature branch. Gate 4b adds slug-path guard.
- **dev-cleanup: worktree removal** — checks `git worktree list` for a managed worktree before branch deletion; removes it non-force first.
- **dev-pr: Gate 0** — replaced inline glob-match with `check-protected-branch.js` shell-out.
- **CLAUDE-APPEND.md: `/dev-branch` mandatory before implementer** — `Worktree:` token must be copied verbatim; worktree cleanup delegated to `/dev-cleanup`.
- **git-push-guard: imports from `lib/protected-branches.js`** — destructures `{ branches }` from the new return shape.

### Fixed

- **implementer, dev-branch: frontmatter description quoting** — unquoted `Worktree:`/`Branch:` colons caused YAML parser to silently drop all frontmatter fields; both descriptions are now quoted strings.
- **pr-body-builder CLI smoke test: missing `cwd`** — `execSync` resolved the script path against the caller's CWD; now sets `cwd` to plugin root so the test passes from repo root.

### Files affected

| File | Change |
|------|--------|
| `scripts/lib/protected-branches.js` + `.test.js` | New: shared protected-branch helpers |
| `scripts/check-protected-branch.js` + `.test.js` | New: CLI wrapper for branch protection checks |
| `tests/agents-structure.test.js` | New: structural lint for `agents/*.md` |
| `tests/test-utils.js` | New: shared `parseFrontmatter` helper |
| `tests/run-all.sh` | Wires `agents-structure.test.js` into the runner |
| `tests/skill-structure.test.js` | Imports `parseFrontmatter` from `test-utils`; adds `dev-branch`, `dev-cleanup` to skill list |
| `agents/implementer.md` | `isolation: worktree` removed; Step 0a/0b refusals added; description quoted |
| `skills/dev-branch/SKILL.md` | Worktree creation + token emission in active-dev mode; Gate 4b slug-path guard; description quoted |
| `skills/dev-cleanup/SKILL.md` | Removes managed worktree before branch deletion |
| `skills/dev-pr/SKILL.md` | Gate 0 shells out to `check-protected-branch.js` |
| `scripts/git-push-guard.js` | Uses `lib/protected-branches.js` exports |
| `scripts/watchdog-health.js`, `scripts/watchdog-errors.js` | Inline doc-comment notes on binding scope |
| `scripts/lib/pr-body-builder.test.js` | CLI smoke test sets `cwd` explicitly |
| `state-templates/CLAUDE-APPEND.md` | `/dev-branch` mandatory before implementer; `Worktree:` token contract |
| `CLAUDE.md` | Skill list refreshed; agent surface area + caller contract documented |

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Copy** `scripts/lib/protected-branches.js` and `scripts/check-protected-branch.js` into the hermit's scripts directory.
2. **Refresh** `agents/implementer.md` from the updated plugin (replaces the prior `isolation: worktree` agent).
3. **Refresh** `skills/dev-branch/SKILL.md`, `skills/dev-cleanup/SKILL.md`, and `skills/dev-pr/SKILL.md` from the updated plugin.
4. **Refresh** `scripts/git-push-guard.js` so it imports the new shared helpers.
5. **Append** the updated implementer-caller-contract section from `state-templates/CLAUDE-APPEND.md` to the hermit's `CLAUDE.md`.

No `config.json` changes required.

**Note:** Callers that previously invoked the implementer directly must now run `/dev-branch` first and copy its `Worktree:` line verbatim into the implementer's prompt. The implementer refuses without that token.

## [0.2.2] - 2026-04-28

### Added

- **dev-pr: new skill** — opens a PR from the current feature branch with assembled title + body. Gates: protected-branch, clean tree, commits-ahead, fresh quality report, no unresolved alerts. Writes PR URL to `state/bindings.json`.
- **watchdog: health + error monitors** — `watchdog-health.js` polls `dev_health_url`; `watchdog-errors.js` tails the dev-server log and emits alerts on error spikes. Registered by `/dev-up` Gate 5b in always-on mode.
- **`scripts/lib/alerts-store.js`** — atomic `state/alerts.json` helpers with MAX_ALERTS=50 pruning and deduplication. Shared by both watchdog processes and `/dev-status`.
- **`scripts/lib/pr-body-builder.js`** — pure function assembling PR title + body from commits, quality report, binding, screenshots, and project template.

### Changed

- **dev-up: worktree `cwd` support** — when `$HERMIT_AGENT_WORKTREE` is set, Monitor pipeline runs from the worktree so the server runs on the agent's branch. `cd` failure emits a `[dev-up] Fatal:` sentinel.
- **dev-up: watchdog registration (Gate 5b)** — registers `dev-watchdog-health` and `dev-watchdog-errors` after server start in always-on mode; both shut down on `/dev-down`.
- **dev-up: `dev_port_agent` config key** — when `$HERMIT_AGENT_WORKTREE` is set, resolves the port from `dev_port_agent` instead of `dev_required_ports[0]`, so the agent's server doesn't collide with the operator's.
- **dev-adapt: PR template + GitLab detection** — reads `.github/PULL_REQUEST_TEMPLATE.md` / `docs/pull_request_template.md` during discovery; detects `.gitlab-ci.yml` and sets `commands.pr_create` default for GitLab remotes.
- **dev-quality / dev-status / dev-branch / dev-down / dev-cleanup / dev-doctor** — surface watchdog alerts in status output; `/dev-down` shuts down watchdog entries.
- **state-templates/CLAUDE-APPEND.md** — `/dev-pr` usage rules and watchdog alert acknowledgement flow added.
- **CLAUDE-APPEND.md: routine schedule pointer** — replaced hardcoded cron times with a pointer to `config.json → routines[]` so the context stays in sync with config.
- **required_core_version: bumped to `>=1.0.22`** — worktree cwd support depends on `$HERMIT_AGENT_WORKTREE` set by hermit-start.py v1.0.22.

### Files affected

| File | Change |
|------|--------|
| `skills/dev-pr/SKILL.md` | New skill |
| `scripts/lib/pr-body-builder.js` + `.test.js` | New: PR body builder (66 tests) |
| `scripts/lib/alerts-store.js` + `.test.js` | New: atomic alerts store (16 tests) |
| `scripts/watchdog-health.js` + `.test.js` | New: health watchdog (19 tests) |
| `scripts/watchdog-errors.js` + `.test.js` | New: error-spike watchdog (27 tests) |
| `skills/dev-up/SKILL.md` | Worktree cwd, watchdog registration, `dev_port_agent` resolution |
| `skills/dev-adapt/SKILL.md` | PR template detection; GitLab `commands.pr_create` default |
| `skills/dev-quality/SKILL.md` | Watchdog alert surfacing |
| `skills/dev-status/SKILL.md` | Watchdog alert surfacing |
| `skills/dev-branch/SKILL.md` | Watchdog alert surfacing |
| `skills/dev-down/SKILL.md` | Watchdog Monitor entry shutdown |
| `skills/dev-cleanup/SKILL.md` | Watchdog state cleanup |
| `skills/dev-doctor/SKILL.md` | Watchdog config checks |
| `state-templates/CLAUDE-APPEND.md` | `/dev-pr` rules + watchdog ack flow; routine schedule pointer |
| `.claude-plugin/hermit-meta.json` | `required_core_version`: `>=1.0.21` → `>=1.0.22` |
| `README.md` | Rewrite for hermit fleet marketing launch |

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Refresh** all `skills/dev-*.md` files from the updated plugin.
2. **Copy** `scripts/lib/alerts-store.js`, `scripts/watchdog-health.js`, `scripts/watchdog-errors.js`, and `scripts/lib/pr-body-builder.js` into the hermit's scripts directory.
3. **Append** the `/dev-pr` usage rules and watchdog alert acknowledgement section to the hermit's `CLAUDE.md` (from `state-templates/CLAUDE-APPEND.md`).

No `config.json` changes required.

**Note:** Two new optional config keys: `dev_port_agent` (integer, port for the agent-worktree dev server) and `dev_watchdog` (object with `enabled`, `log_error_alert_threshold`, `poll_interval_ms`). Watchdog is enabled by default when `dev_health_url` is set.

### Internal

- **Structure cleanup** — promoted watchdog scripts to `scripts/` (entrypoints), added `tests/run-all.sh` central runner, moved `skill-structure.test.js` to `tests/`, removed empty `.claude/` artifact and `.vscode/` personal-pref file. Added `scripts/lib/ must be pure` rule to CONTRIBUTING.md.
- **Doc corrections** — bumped prereq refs from `v1.0.21+` → `v1.0.22+` in README and CONTRIBUTING; removed `docs/SKILLS.md` (redundant with per-skill `SKILL.md` files); refreshed skill list in CLAUDE.md (added `dev-pr`); updated CONTRIBUTING project structure and test runner command.

## [0.2.1] - 2026-04-27

### Fixed

- **dev-up: dev server no longer killed by Monitor on chatty output** — Gate 5 wraps dev start in a `tee | grep --line-buffered` pipeline; Monitor receives only error-matched lines. Full stdout is preserved in `state/dev-server.log`; override pattern via `dev_error_pattern`.

### Added

- **`scripts/lib/dev-server-command.js`** — builds the Monitor pipeline for `/dev-up` Gate 5; handles shell-escaping via `shellQuote` and ships the anchored default error regex. 18 tests cover validation, escaping, and runtime behavior.

### Changed

- **`dev-adapt` and `dev-up` examples neutralized for OSS** — dropped `local:dev` from the `package.json#scripts` priority list; swapped worked-example output to `npm run dev` / `direnv status`. Detection logic unchanged.

### Files affected

| File | Change |
|------|--------|
| `skills/dev-up/SKILL.md` | Gate 5 rewritten to use tee\|grep pipeline via helper; error pattern resolution documented |
| `scripts/lib/dev-server-command.js` | New: pipeline builder with shell-safe composition and default error regex |
| `scripts/lib/dev-server-command.test.js` | New: 18 tests covering validation, escaping, and runtime behaviour |
| `skills/dev-adapt/SKILL.md` | OSS example neutralization |

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Refresh** `skills/dev-up/SKILL.md` from the plugin.

No `config.json` changes required.

**Note:** `/dev-up` now writes full dev-server stdout to `.claude-code-hermit/state/dev-server.log` each session (truncated at each boot). Only error-matched lines appear as Monitor notifications. To tune the error pattern, set `claude-code-dev-hermit.dev_error_pattern` in `.claude-code-hermit/config.json`.

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
- **core requirement bumped to `>=1.0.21` / `^1.0.21`** — was `>=1.0.18`; bumped in `hermit-meta.json`, `plugin.json`, README, CLAUDE.md, and CONTRIBUTING.md together.

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

- **Monorepo housekeeping** — plugin source moved into `plugins/claude-code-dev-hermit/`; `required_core_version` reconciled to semver-range form; inner `marketplace.json` removed; README links updated.

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

- **implementer: stronger Concerns contract** — non-obvious load-bearing choices must include a `Rejected alternatives:` sub-bullet; caller-provided architectures (e.g. from `feature-dev`) treated as hard constraints.
- **dev workflow: verify before overriding implementer choices** — CLAUDE-APPEND step 3 instructs the main session to run implementer tests before overriding a non-obvious choice; trace before replacing if no tests exist.
- **dev workflow: `/dev-quality` vs `/simplify` clarification** — step 4 now specifies `/dev-quality` as the end-of-task gate; direct `/simplify` reserved for mid-task cleanup and post-`/batch` follow-up.
- **dev workflow: optional planning gate via feature-dev** — new optional step suggests `/feature-dev:feature-dev` when the task touches unfamiliar code paths (trigger: unfamiliarity, not urgency).
- **dev-quality: code-review step removed** — `/simplify` already covers reuse/quality/efficiency review; pass is now tests → `/simplify` → tests. `code-review` plugin remains an optional companion.
- **hatch: no scheduled_checks entry for code-review** — no longer in any default code path; `docker.recommended_plugins` still records it when selected.

---

## [0.1.5] - 2026-04-22

### Changed

- **Minimum core version bumped to v1.0.16** — requires `claude-code-hermit` v1.0.16+ to guarantee the `scheduled-checks` routine is present.

---

## [0.1.4] - 2026-04-22

### Changed

- **BREAKING: minimum core version bumped to v1.0.15** — reflects the `scheduled_checks` rename and other protocol changes in core.
- **hatch: `plugin_checks` → `scheduled_checks`** — five references updated; `RECOMMENDED-PLUGINS.md` and `CLAUDE.md` updated likewise.
- **hatch: dev-cleanup routine gate removed** — `< 1.0.12` version guard redundant now that floor is v1.0.15; cleanup routine question shown unconditionally.
- **hatch report: surfaces `hermit-settings boot-skill`** — added to "Other core skills" block.
- **CLAUDE-APPEND: reflect suppression codes** — reflect note now lists structured suppression codes (`no-evidence`, `weak-recurrence`, etc.).
- **CLAUDE-APPEND: knowledge-schema.md pointer** — Dev Knowledge section points at `knowledge-schema.md` if present.
- **release skill: `claude plugin validate` step** — validation now runs between file updates and commit.
- **marketplace.json: full metadata** — added `author`, `license`, `homepage`, `repository`, `keywords` fields.

---

## [0.1.3] - 2026-04-21

### Changed

- **Skill renamed: `dev-hatch` → `hatch`** — `dev-` prefix redundant given the plugin namespace. Invoke as `/claude-code-dev-hermit:hatch`.

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

- **Fully qualified agent/skill names enforced** — bare names replaced with canonical forms (`claude-code-dev-hermit:implementer`, `/claude-code-dev-hermit:dev-quality`, `code-review:code-review`) in all skill and template files.

### Files affected

| File | Change |
|------|--------|
| `state-templates/CLAUDE-APPEND.md` | `implementer` → `claude-code-dev-hermit:implementer` (table + workflow step + checklist) |
| `skills/dev-hatch/SKILL.md` | `implementer` → `claude-code-dev-hermit:implementer` (report output) |
| `skills/dev-quality/SKILL.md` | `code-review` → `code-review:code-review`; `implementer` → `claude-code-dev-hermit:implementer` |

---

## [0.1.0] - 2026-04-15

Initial public release.
