# Changelog

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

## [Unreleased]

### Added

- **`docs/WORKFLOW.md` — end-to-end task lifecycle reference** — lays out what fires in what order across `/hatch`, `/dev-adapt`, implementer, `/dev-quality`, `/dev-cleanup`, `/dev-doctor`, and the core reflect/session-mgr loop, including the state each step writes. Linked from README Documentation section. Skills already cross-reference this path; the file now exists.

- **`create-pr` skill** — fills the gap between `/commit` and `/release`: pushes the current branch if needed, auto-drafts a Conventional Commits title and `## Summary` + `## Test plan` body from the commit range and diff, detects issue references for `Closes #N` links, shows the draft for approval, then runs `gh pr create`. Refuses early if on the default branch, dirty tree, no commits ahead, or a PR already exists.

### Fixed

- **`dev-quality`: lint never ran despite being configured** — Steps 3 and 6 now run `commands.lint` alongside test and typecheck. Lint at baseline (Step 3) is report-only and does not block simplify; lint regression after simplify (Step 6) triggers the same revert path as test regression.
- **`dev-quality`: pre-simplify snapshot failed on committed code** — replaced `git stash push` (fails silently on a clean working tree) with `PRESIMPLIFY=$(git stash create); [ -z "$PRESIMPLIFY" ] && PRESIMPLIFY=$(git rev-parse HEAD)`. Revert now uses `git checkout $PRESIMPLIFY -- <files>`. Works correctly after the implementer commits, after direct edits, and with concurrent operator changes (with a staged-edits warning).
- **`CLAUDE-APPEND.md`: main session did not check out the implementer's branch** — Step 3 now instructs the main session to run `git status -s` and, if the tree is clean, `git checkout <branch>` using the branch name from the implementer's `Branch:` line before updating SHELL.md and before running `dev-quality`. Without this, `dev-quality`'s diff detection targeted the wrong HEAD and `git diff merge-base` returned zero changed files on every run.
- **`agents/implementer.md`: pinned `Branch:` output format** — the `### Branch` return section now specifies the exact format `Branch: <branch-name>` (one token, no trailing prose) so the main session can parse it deterministically.
- **Worktree isolation hardening** — implementer's worktree is a fresh checkout, so `.claude-code-hermit/` (typically gitignored) is absent inside it. Two gaps closed: (1) branch-handoff collision — `git checkout <branch>` in the main repo failed with "already checked out at .claude/worktrees/<name>" because the subagent worktree persisted; fixed by adding a `Worktree:` return line to the implementer and updating CLAUDE-APPEND step 3 to prune → check → remove → checkout; (2) silent safety-rail degradation — `protected_branches` and `commit_format` fell back to defaults without warning; fixed by prompt-passing these values from the main session's config.json read and adding a scoped Concerns flag when defaults were used on a commit. Also: hatch now unconditionally writes a `.worktreeinclude` block so future implementer runs can fall back to file-read when prompt-passing is absent; dev-doctor gains checks 12 (`.claude/worktrees/` gitignored) and 13 (`.worktreeinclude` covers hermit config).

### Upgrade Instructions

1. Ensure `.worktreeinclude` at the repo root contains the claude-code-dev-hermit marker block. Run `/claude-code-hermit:hermit-evolve` — it will execute this step automatically. Or run `/claude-code-dev-hermit:hatch` manually if you prefer.

   If applying manually: create or append to `.worktreeinclude` at repo root:
   ```
   # claude-code-dev-hermit — implementer subagent worktree files
   .claude-code-hermit/config.json
   .claude-code-hermit/OPERATOR.md
   .env
   .env.local
   .env.test
   # end claude-code-dev-hermit
   ```
   If the marker is already present, skip — the block is idempotent.

2. No config.json changes required.

### Changed

- **Minimum core version bumped to v1.0.18** — `claude-code-hermit` v1.0.18 renamed `/doctor` to `/hermit-doctor` to avoid collision with Claude Code's built-in `/doctor`. `dev-doctor` manual mode composes this skill, so `required_core_version` in `plugin.json` is bumped and the composition callsites are updated accordingly. Operators on older cores are prompted by hatch's prereq gate to run `/claude-code-hermit:hermit-evolve`.
- **`dev-doctor`: compose `/claude-code-hermit:hermit-doctor` in manual mode** — Step 1 now runs `/hermit-doctor` in parallel alongside `smoke-test` and `hermit-config-validator`. Adds six new checks (config validity, hook scripts, state file integrity, cost vs idle_budget, open proposals health, file permissions) to the manual health report; scheduled mode is unchanged.
- **`dev-doctor`: check #5 validates test-command binary** — previously checked only that `commands.test` is non-null; now also strips env-var prefixes, splits compound commands, and runs `command -v` on the first executable token. Handles `npx`/`pnpm dlx`/`bunx` by checking the second token too. FAIL on unresolvable binary.
- **`dev-doctor`: check #11 — `commit_format` shape** — if `commit_format` is set but `commit_format_pattern` is absent (or vice versa), WARN and direct operator to re-run `/dev-adapt`.
- **`dev-adapt`: detect commit message format** — scans `git log --no-merges -50` and classifies the project's style as `conventional` / `gitmoji` / `null` (freeform or too few commits). Threshold: ≥70% match AND ≥10 commits. Persists `commit_format` and `commit_format_pattern` (the matched regex) to `config.json`. Surfaces in the `dev-profile` artifact under `## Commit format`.
- **`agents/implementer`: read `commit_format` from config** — if `commit_format` is set in config, applies it to all commit messages and validates each subject against `commit_format_pattern` before committing.
- **`agents/implementer`: `ultrathink` at pre-edit planning step** — new step 3 in "Before Starting" instructs the implementer to reason deeply through the task before the first file mutation. Mirrors the pattern core v1.0.17 added to reflect, reflection-judge, and proposal-create. Especially effective for refactors, unfamiliar code paths, and cross-file changes.
- **`CLAUDE.md`: remove `reviews/` from state dir listing** — the `reviews/` directory was removed from the core in v1.0.17 (weekly reviews now write to `compiled/review-weekly-*`). The state dir contract is updated to match.

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
