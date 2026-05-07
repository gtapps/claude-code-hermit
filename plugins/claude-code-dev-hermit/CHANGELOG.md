# Changelog

## [Unreleased]

### Removed

- **`scripts/git-commit-quality-gate.js`** PreToolUse hook removed (and its registration in `hooks/hooks.json`). The strict-profile branch unconditionally blocked every `git commit` with no state check; the standard-profile nudge duplicated guidance already present in `CLAUDE-APPEND.md`. PR-time enforcement via `/dev-pr` Gate 0's `state/last-test.json` SHA check is unchanged. Resolves [#39](https://github.com/gtapps/claude-code-hermit/issues/39).

## [0.3.4] - 2026-05-07

### Added

- **`scripts/git-commit-quality-gate.js`** — new `PreToolUse` Bash hook that fires on `git commit`. In `standard` profile, injects an `additionalContext` reminder to run `/dev-quality` first. In `strict` profile, hard-blocks the commit (exit 2). Tokenizer-based argv parsing handles `git -C <path> commit`, env-var prefixes, and chained commands; avoids false positives on `git log --grep="commit"` and `git config commit.template`. Resolves [#30](https://github.com/gtapps/claude-code-hermit/issues/30).
- **`--cwd <path>` argument on `/dev-quality`, `/dev-test`, `/dev-pr`** — scopes the entire flow at a nested git working tree (submodule, path workspace, vendored dep) while letting the operator stay in the parent CWD. Git ops use `git -C "<path>"`, the test command spawns from `<path>`, `last-test.json` records the child's HEAD SHA (so `/dev-pr`'s SHA-only cache check correctly discriminates parent-scope from child-scope records), `/simplify` is scoped to files under `<path>`, and `gh`/`glab` runs from `<path>` so the PR opens against the child's remote. Hermit state still lives under the parent's `.claude-code-hermit/`. Resolves [#32](https://github.com/gtapps/claude-code-hermit/issues/32).
- **`record-test-result.js` `--cwd <path>` flag** on `run` and `write` subcommands. Validates the path exists and is a git working tree, spawns the test command from `<path>`, captures `<path>`'s HEAD SHA. The PostToolUse hook entry-point is unchanged — it still captures `process.cwd()`'s SHA and cannot reliably parse `cd <path> && testcmd` chains; the `--cwd`-driven flow (via `run --cwd`) is the supported nested-repo entry point.

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

- **`likely_cause` field in `state/last-test.json`** — when `record-test-result.js` records a non-zero exit, it now classifies well-known signal exits: `137` → `"oom"`, `124` → `"timeout"`, `130` → `"user-interrupt"`. Surfaced in `/dev-pr` Gate 0 and `/dev-quality` Gate 2 failure messages so operators see `tests failed (exit 137, likely OOM)` instead of an opaque exit code.
- **`/dev-quality` commits-ahead NOTICE** — when Gate 0 fails on a clean working tree, `/dev-quality` checks whether HEAD has commits ahead of the base. If so, it emits a NOTICE explaining the correct ordering (`/dev-quality → commit → /dev-pr`) and points to `/dev-test` for post-commit verification. Resolves the common foot-gun of committing first and then finding `/dev-quality` has nothing to act on.
- **`/hatch` base-branch detection** — during the capability scan in step 2, hatch now detects common base branches from the remote (`main`, `master`, `develop`, `development`, `dev`, `trunk`). If exactly one candidate differs from what `/dev-pr`'s fallback chain would resolve, it is written as `pr_base_branch` automatically. If two or more candidates are detected, a `Base branch` question is added to the Round 2 `AskUserQuestion` batch. In both cases, the key is only written when the value differs from the fallback — ordinary trunk repos see no change in behavior.

### Changed

- **`/dev-pr` Gate 4 session-close nudge** — after a successful `gh pr create`, `/dev-pr` now appends `next: PR opened — consider /claude-code-hermit:session-close to wrap the session` to the report. Reduces false-positive stale-session heartbeat alerts caused by sessions left open after PR creation.
- **`/hatch` safety-mode skip list** — `pr_base_branch` added to the list of keys not written in safety mode (these feed `/dev-pr` which is not prescribed in that mode).
- **`/hatch` Docker network requirements section** — adds an explicit "intentionally empty" Docker domains/LAN block with an explanation for why the plugin cannot pre-declare DNS allowlist entries (language-agnostic; dev workflows vary per project).
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

- **`claude-code-dev-hermit.hatch_mode` config key** — `"safety"` | `"standard"`. Persists the operator's hatch mode across re-runs and is used by `/hatch` to select the right CLAUDE-APPEND template.
- **`state-templates/CLAUDE-APPEND-SAFETY.md`** — a subset template for `safety` mode containing only mode-independent sections: §Git Safety, §Branch Discipline, §Technical Constraints, §Before Archiving a Task, §Dev Session Hygiene, §Dev Knowledge, §Dev Proposal Categories, and a trimmed §Dev Quick Reference. Does not include §Implementation Flow, §Tests Before PR, or `/dev-test`/`/dev-quality`/`/dev-pr` references.

### Changed

- **`state-templates/CLAUDE-APPEND.md`** — adds a one-sentence "project conventions take precedence" preamble to §Branch Discipline, §Implementation Flow, and §Tests Before PR. Makes `standard`-mode installs non-destructive in projects that already have their own commit/PR/release skills.
- **`/hatch` capability scan** — at hatch time, scans `.claude/skills/` for dirs named `commit`, `create-pr`, `pr`, `pull-request`, `release`, or `git-commit`. If matched, defaults the mode prompt to `safety` and surfaces the detected skill names. Else defaults to `standard`.
- **`/hatch` mode-conditional prompts** — in `safety` mode, skips prompts for `commands.test`, `commands.lint`, `commands.format`, `commands.pr_create`, and `pr_template_path` (workflow keys that feed sections not injected). Only asks `Protected` branches, `Hook` profile, and companion `Plugins`. In `standard` mode, behavior is unchanged from v0.3.1.
- **`/hatch` template selection** — injects `CLAUDE-APPEND-SAFETY.md` in safety mode, `CLAUDE-APPEND.md` in standard mode.

### Fixed

- **git-push-guard tests: `master`-branch cases falsely passing** — `runRaw` used `process.cwd()` as the guard's working directory, so it found the monorepo's `.claude-code-hermit/config.json` (which only lists `main`) and overrode the default `["main", "master"]` fallback. Fixed by running test spawns in a fresh tmpdir with no hermit config. Also wrapped `runWithConfig` in `try/finally` to prevent tmpdir leaks and unified `force: true` on both cleanup calls.

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

- **`/dev-test` skill (`skills/dev-test/SKILL.md`)** — run the configured test suite and record the result to `last-test.json`. Useful for mid-task verification and warming the `/dev-pr` test cache. Internally calls `record-test-result.js run`.
- **`/dev-quality` skill (`skills/dev-quality/SKILL.md`)** — re-introduces a `/dev-quality` skill (removed in v0.3.0 as "workflow ceremony") in leaner form as a mechanical pre-wrap quality gate: runs `/simplify` on the working-tree diff, re-runs `commands.test` if set, and reports results. On test regression, surfaces the failure and stops — no auto-rollback. If `/code-review:code-review` (`code-review@claude-plugins-official`) is in the agent's available slash-command list, the skill tells the agent to suggest it to the operator (never invokes it autonomously).

### Changed

- **`/dev-pr` Gate 0 tests check** — now runs tests automatically on cache miss instead of blocking with "run the test command yourself". A fresh `status:"pass"` record at the current HEAD is a cache hit (instant); anything else triggers `record-test-result.js run`. Fixes #12 (hook couldn't observe exit codes; gate previously refused all PRs).
- **`scripts/record-test-result.js`** — adds `run` subcommand (executes `commands.test`, records real exit code + duration) and `write <exit_code> <duration_ms>` subcommand (for direct callers and CI). Hook path now silently skips on missing exit code instead of writing `status:"unknown"`. Interrupted runs (`tool_response.interrupted === true`) are skipped.
- **`/dev-quality`** — test step now calls `record-test-result.js run` instead of `$COMMANDS_TEST`, so the result is recorded to `last-test.json` (note: SHA is pre-commit; `/dev-pr` will still re-run after commit).
- **`state-templates/CLAUDE-APPEND.md`** — adds step 4 to §Implementation Flow pointing to `/dev-quality`; rewrites §Tests Before PR to reference `/dev-quality` as the `/simplify`+re-run owner. Operators must re-run `/claude-code-dev-hermit:hatch` to refresh their project's CLAUDE.md.

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

**v0.3.0 — language-agnostic safety layer.** Mass cleanup: dropped ~6,000 lines (~70% of the plugin) to reframe dev-hermit as a thin safety layer instead of a stack-aware orchestrator. The plugin now ships 2 skills (`hatch`, `dev-pr`), 1 hook (`git-push-guard`), and a CLAUDE-APPEND template that injects safety rules into the project's CLAUDE.md. No built-in implementer agent — operators use the native `Agent` tool, `feature-dev`'s research/architect agents, or custom subagents, all governed by the injected rules. Three audits (value / complexity / native-delegation) and a series of design-iteration conversations led to this redesign; full rationale in the v0.3.0 plan (`/home/d0m/.claude/plans/cryptic-weaving-dolphin.md`).

### Changed

- **`state-templates/CLAUDE-APPEND.md`** — rewritten as the rules-of-the-road for any agent doing dev work. New sections: §Git Safety (no push, no `--no-verify`, no commits to protected, no force-push), §Branch Discipline (clean-tree gate, branch from `protected_branches[0]`, prefix detection, verbatim 5-step slug rules), §Implementation Flow (run configured test command before declaring done), §Tests Before PR (re-run after `/simplify`, `git checkout -- <changed>` on regression). Dropped Dev Agent table, 7-step Dev Workflow, Local Dev Environment, Watchdog, Always-on Worktree Topology. With no in-plugin agent, this prose is the only safety layer at non-strict hook profiles — written concretely and without hedging.
- **`/hatch` rewrite (`skills/hatch/SKILL.md`)** — 271 → ~155 lines. Subsumes `/dev-adapt`'s wizard prompts (`test_command`, `lint_command`, `format_command`, `protected_branches`, `pr_template_path`). Defaults to installing `git-push-guard` at strict profile with an explicit opt-out; never silently downgrades an existing strict install. Idempotent on re-run: every key offers `Keep current (<value>)` as the recommended option, so operators sweep through Enter-presses to fast-confirm. Reads `required_core_version` from `hermit-meta.json` instead of hardcoding the floor in skill prose. Detects GitLab vs GitHub remote to seed `commands.pr_create` (`gh pr create` vs `glab pr create`); preserves operator overrides.
- **`/dev-pr` rewrite (`skills/dev-pr/SKILL.md`)** — 241 → ~140 lines. Body assembly is inline LLM prose with explicit per-section templates (Summary / Context / Verification / Screenshots / Notes) instead of a 240-line template-merge engine. Dropped Gate 0 quality-check (no `/dev-quality`), Gate 0 alert-check (no watchdogs), the `--force` flag (clean-tree and protected-branch are NEVER skipped; quality/alert checks no longer exist), all `$HERMIT_AGENT_WORKTREE` always-on branching, all calls to the deleted `scripts/check-protected-branch.js` (replaced with inline bash glob via `case ... in <pattern>`). Project PR templates now append verbatim after the assembled body — no heading-merge engine.
- **`scripts/git-push-guard.js` simplification** — 286 → ~85 lines. Replaced the shell-aware tokenizer + per-flag option parser with regex chains. Inlined `loadProtectedBranches()` and the glob-to-regex conversion (formerly in `scripts/lib/protected-branches.js`). All exotic shell cases the old tokenizer handled (env-var prefix, `git -C path push`, `git -c key=val push`) still work — the regex approach catches them by looking at the whole subcommand. New policy: bare `--force` and `-f` are blocked unconditionally; `--force-with-lease` is allowed only to a non-protected branch with an explicit refspec (the safe rebase-recovery case), and blocked for protected targets and ambiguous-target leases. Hook now walks up from cwd to find `.claude-code-hermit/` instead of assuming `cwd == project root`. Trade-off: false positives on commit messages mentioning `--no-verify` and on deeply nested branch names matched against `release/*` glob (rename / use a different word in the message).
- **Docs rewritten for v0.3.0 identity** — full rewrites of `CLAUDE.md` (plugin-level), `README.md`, `docs/HOW-TO-USE.md`, `docs/WORKFLOW.md`. Substantive trim of `docs/GIT-SAFETY.md` and `docs/RECOMMENDED-PLUGINS.md`. Small structural edit to `CONTRIBUTING.md`. New identity throughout: "language-agnostic safety layer + dev conventions for any agent your hermit uses to write code." `README.md` adds a v0.2.x → v0.3.0 migration section pointing operators at `feature-dev` / native `Agent` as implementer replacements.

### Removed

- **Implementer agent** — `agents/implementer.md` and the entire `agents/` directory. Safety rules now live in `state-templates/CLAUDE-APPEND.md`; agents read and follow them. Operators relying on `subagent_type: implementer` must switch to native `Agent` or `feature-dev`'s `code-architect` / `code-explorer` (`feature-dev` does not ship a code-writing implementer of its own). `hermit-evolve` surfaces this on next run.
- **Skills**: `dev-branch` (slug rules + clean-tree gate now in CLAUDE-APPEND §Branch Discipline), `dev-quality` (tests-then-simplify-then-tests pattern now in CLAUDE-APPEND §Tests Before PR), `dev-cleanup` (use `git branch --merged | grep -v <protected> | xargs git branch -d`), `dev-doctor` (if `hatch` works and tests pass, the plugin works), `dev-adapt` (folded into `hatch`), `dev-up` / `dev-down` / `dev-log-watch` / `dev-status` (every language's dev server is different — operators write a project-specific skill or use `tmux` / `Bash run_in_background` directly).
- **Scripts**: `scripts/watchdog-health.js`, `watchdog-errors.js`, `check-protected-branch.js` and their test siblings. The watchdog pipeline (~1,370 lines including alerts-store and the `state/alerts.json` ack flow) was babysitter-watching-babysitter; Monitor's stderr-on-exit notification covers "dev server died" without it.
- **`scripts/lib/`** entire directory: `alerts-store`, `dev-server-command`, `health-poll`, `log-watch-builder`, `port-check`, `pr-body-builder`, `protected-branches`, `resolve-command`, `shell-utils` (~1,300 lines). Body builder inlined into `/dev-pr` SKILL prose; protected-branches inlined into `git-push-guard.js`; the rest were thin wrappers over `curl` / `tail -F | grep` / `command -v` / `lsof` that did not earn their keep across language stacks.
- **Tests**: `tests/agents-structure.test.js` (no agents to lint); `pr-body-builder.test.js`, `port-check.test.js`, `health-poll.test.js`, `log-watch-builder.test.js`, `dev-server-command.test.js`, `alerts-store.test.js`, `resolve-command.test.js`, `check-protected-branch.test.js`, `watchdog-health.test.js`, `watchdog-errors.test.js` (their subjects were deleted). 55 tests survive: 9 structural lints + 46 git-push-guard cases.
- **Docs**: `docs/DEV-LOG-WATCH.md` (the rotating-log monitoring skill it documented is gone).
- **CLAUDE.md plugin block updates** — operators upgrading via `hermit-evolve` will see the §Dev Agent table, §Local Dev Environment, §Watchdog block, and §Always-on Worktree Topology sections silently replaced with the new safety rules. Existing config keys for the dropped features become inert (harmless but unused) — see Migration below.

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

- **`subagent_type: implementer` calls will silently fall back** to general-purpose. Switch to the native `Agent` tool with the project's CLAUDE-APPEND rules in scope, or to `feature-dev:code-architect` / `code-explorer` for planning + the native `Agent` for writing.
- **Inert config keys** in `.claude-code-hermit/config.json` (no harm, but cleanly removable): `claude-code-dev-hermit.dev_health_url`, `dev_log_path_pattern`, `dev_error_pattern`, `dev_watchdog.*`, `commands.dev_start`, `commands.dev_stop`, `dev_port_agent`, `dev_required_ports`, `dev_auth_check`, `dev_expected_listeners`, `pr_title_format`, `pr_body_sections`. The `commands.test`, `commands.lint`, `commands.format`, `commands.pr_create`, `protected_branches`, `pr_template_path`, `pr_base_branch`, `env.AGENT_HOOK_PROFILE` keys are all preserved by the new `/hatch`.
- **Workflow scripts** that explicitly invoked `/dev-up`, `/dev-down`, `/dev-log-watch`, `/dev-status`, `/dev-quality`, `/dev-cleanup`, `/dev-doctor`, `/dev-adapt`, `/dev-branch` will fail with "skill not found." For dev servers, use `tmux` or `Bash run_in_background`. For test-then-simplify, the agent now runs that loop directly per CLAUDE-APPEND §Tests Before PR — no skill wrapper.
- **`required_core_version`** stays at `>=1.0.22`. The cleanup removed features that depended on later core changes, so the floor could potentially relax in a future release; for now we keep the existing floor.

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

- **`scripts/lib/protected-branches.js`** — shared protected-branch helpers (load, normalize, glob-match, isProtected) extracted from `git-push-guard.js`. All skills and agents now shell out to `check-protected-branch.js` instead of restating glob logic inline.
- **`scripts/check-protected-branch.js`** — CLI wrapper; exit 0 = not protected, exit 1 = protected (stdout names the matched pattern). Used by implementer Step 0b, `/dev-branch` Gate 0, `/dev-cleanup`, and `/dev-pr` Gate 0.
- **`tests/agents-structure.test.js`** — structural lint for `agents/*.md`: frontmatter required fields, `isolation: worktree` absent, Step 0a/0b refusal language distinct and referencing the right tokens.
- **`tests/test-utils.js`** — shared `parseFrontmatter` helper used by both structural test files.

### Changed

- **implementer: caller contract** — removed `isolation: worktree` (caller now owns worktree setup via `/dev-branch`). Added Step 0a (require `Worktree:` token in prompt) and Step 0b (verify branch is not protected via `check-protected-branch.js`) before any edits. Implementer refuses with actionable messages on missing token or protected branch. **Breaking workflow change**: any caller that invoked the implementer directly must now run `/dev-branch` first and copy its `Worktree:` line into the implementer's prompt verbatim.
- **`/dev-branch`: worktree + token emission** — in active-dev mode (no `$HERMIT_AGENT_WORKTREE`), Gate 6 now runs `git worktree add .claude/worktrees/<slug>` and emits `Worktree:`/`Branch:` tokens. Gate 0 short-circuits when already on a feature branch and emits the same tokens. Gate 4b adds a slug-path guard before Gate 5 to prevent silent conflicts.
- **`/dev-cleanup`: worktree removal** — before deleting a confirmed branch, checks `git worktree list` for a managed worktree under `.claude/worktrees/`; removes it (non-force) before the branch delete. Skips `agent/` basename and worktrees outside `.claude/worktrees/`.
- **`/dev-pr` Gate 0** — replaced inline glob-match logic with `check-protected-branch.js` shell-out.
- **`state-templates/CLAUDE-APPEND.md`** — step 2 (Implement) updated: `/dev-branch` is now mandatory before invoking the implementer; `Worktree:` token must be copied verbatim into the implementer prompt. Step 3 (after implementer) simplified: worktree cleanup is `/dev-cleanup`'s job.
- **`scripts/git-push-guard.js`** — imports `loadProtectedBranches`/`isProtected` from `lib/protected-branches.js`; destructures `{ branches }` from the new return shape.

### Fixed

- **`agents/implementer.md` and `skills/dev-branch/SKILL.md` frontmatter** — `description` values contained unquoted `Worktree:`/`Branch:` colons, causing the YAML parser to drop all frontmatter fields silently at runtime. Both descriptions are now quoted strings.
- **`scripts/lib/pr-body-builder.test.js` CLI smoke test** — `execSync` lacked an explicit `cwd`, so the relative `node scripts/lib/pr-body-builder.js` path resolved against the caller's CWD. Now sets `cwd` to the plugin root so the test passes when `tests/run-all.sh` is invoked from the repo root.

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

- **dev-pr: new skill** — opens a PR from the current feature branch. Assembles title + body from `/dev-quality` output, commits, work-binding context, screenshots, and an optional project PR template. Gates: protected-branch, clean tree, commits-ahead, fresh quality report, no unresolved health-degraded alerts. Accepts `--force` to skip quality and alert gates. Writes PR URL to `state/bindings.json`.
- **watchdog: health + error monitors** — `watchdog-health.js` polls `dev_health_url` and emits `health-degraded`/`health-recovered`; `watchdog-errors.js` tails the dev-server log and emits `error-spike`/`error-cleared` when rolling error count crosses `dev_watchdog.log_error_alert_threshold`. Registered by `/dev-up` Gate 5b in always-on mode; skipped in interactive mode or when `dev_watchdog.enabled === false`.
- **`scripts/lib/alerts-store.js`** — atomic `state/alerts.json` helpers with MAX_ALERTS=50 pruning and deduplication. Shared by both watchdog processes and `/dev-status`.
- **`scripts/lib/pr-body-builder.js`** — pure function assembling PR title + body from commits, quality report, binding, screenshots, and project template.

### Changed

- **dev-up: worktree `cwd` support** — when `$HERMIT_AGENT_WORKTREE` is set, the dev-server Monitor pipeline `cd`s into the worktree first so the server runs on the agent's branch, not the operator's checkout. A `cd` failure emits a `[dev-up] Fatal:` sentinel surfaced as a notification rather than silently falling back.
- **dev-up: watchdog registration (Gate 5b)** — in always-on mode, registers `dev-watchdog-health` and `dev-watchdog-errors` as persistent Monitor entries after the dev-server starts. Both shut down on `/dev-down`.
- **dev-up: `dev_port_agent` config key** — when `$HERMIT_AGENT_WORKTREE` is set, resolves the port from `dev_port_agent` instead of `dev_required_ports[0]`, so the agent's server doesn't collide with the operator's.
- **dev-adapt: PR template + GitLab detection** — reads `.github/PULL_REQUEST_TEMPLATE.md` / `docs/pull_request_template.md` during discovery; detects `.gitlab-ci.yml` and sets `commands.pr_create` default for GitLab remotes.
- **dev-quality / dev-status / dev-branch / dev-down / dev-cleanup / dev-doctor** — surface watchdog alerts in status output; `/dev-down` shuts down watchdog entries.
- **state-templates/CLAUDE-APPEND.md** — `/dev-pr` usage rules and watchdog alert acknowledgement flow added.
- **state-templates/CLAUDE-APPEND.md: routine schedule pointer** — removed hardcoded cron times from the routines quick-reference line; schedules and `enabled` state now point to `config.json → routines[]` (edit via `/claude-code-hermit:hermit-settings`) so the runtime context stays in sync with config.
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

- **`dev-up`: dev server no longer killed by Monitor on chatty output** — Gate 5 now wraps `commands.dev_start` in `{ … } 2>&1 | tee .claude-code-hermit/state/dev-server.log | grep --line-buffered -E <pattern> || true`. Monitor receives only error-matched lines and never trips its notification-rate limit. Full stdout is preserved in the log file for forensics. Error pattern defaults to anchored Node/Vite/Next.js signals (e.g. `^\s*(Error|TypeError|...):`, `EADDRINUSE`, `Uncaught`) to avoid false-positives on the bare word "error" common in Next.js compile output; override via `dev_error_pattern` in config.

### Added

- **`scripts/lib/dev-server-command.js`** — builds the Monitor pipeline command for `/dev-up` Gate 5. Handles shell-escaping of `commands.dev_start`, log path, and error pattern via `shellQuote`; ships the anchored default regex; exports `buildDevServerCommand({ devStart, logPath, errorPattern })`. Co-located `dev-server-command.test.js` covers input validation, defaulting, shell-injection safety (`bash -n` round-trips for adversarial inputs), and runtime smoke (filter correctness, zero-match exit-0 guard).

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
