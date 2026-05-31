# claude-code-dev-hermit

Language-agnostic safety layer for any agent doing dev work in a hermit project. Ships a `git-push-guard` hook, a one-time `/hatch` wizard, a `/dev-pr` skill, and a CLAUDE-APPEND template that injects safety rules into the project's CLAUDE.md.

## Plugin Structure

- `skills/hatch/` — one-time setup wizard. Idempotent, re-runnable, defaults to strict hook profile.
- `skills/dev-pr/` — push the current feature branch and open a PR with an inline-assembled body. Refuses on protected branches, dirty trees, or zero commits ahead.
- `skills/dev-quality/` — pre-wrap quality gate: runs `/claude-code-hermit:simplify` on the working tree (cleanup pass) and re-runs `commands.test` if configured. Surfaces failures; suggests `/code-review:code-review` when installed for a deeper correctness review.
- `skills/dev-test/` — run the configured test suite and record the result to `state/last-test.json`. Useful for mid-task verification and warming the `/dev-pr` test cache.
- `scripts/git-push-guard.js` — strict-profile-only `PreToolUse` hook for Bash. Blocks `--no-verify`, `--force`/`-f` (always), `--force-with-lease` on protected branches or without an explicit refspec, `--mirror`/`--all`, and direct push to any branch in `claude-code-dev-hermit.protected_branches`.
- `scripts/worktree-boundary-guard.js` — `PreToolUse` hook for `Edit`/`Write`. In a linked git worktree, blocks edits that escape into the main checkout (`.claude-code-hermit/` carved out). Self-limiting (no profile gate — inert outside worktrees); `WORKTREE_GUARD=off` disables it.
- `hooks/hooks.json` — registers `git-push-guard.js` and `worktree-boundary-guard.js`.
- `state-templates/CLAUDE-APPEND.md` — full (standard mode) template. Sections: §Git Safety, §Branch Discipline, §Implementation Flow, §Tests Before PR, §Technical Constraints, §Before Archiving a Task, §Dev Session Hygiene, §Dev Knowledge, §Dev Proposal Categories, §Dev Quick Reference. Injected by `/hatch` into the target project's `CLAUDE.md` when `hatch_mode = "standard"`.
- `state-templates/CLAUDE-APPEND-SAFETY.md` — safety mode template. Subset: §Git Safety, §Branch Discipline, §Technical Constraints, §Before Archiving a Task, §Dev Session Hygiene, §Dev Knowledge, §Dev Proposal Categories, trimmed §Dev Quick Reference. No §Implementation Flow, §Tests Before PR, or `/dev-pr`/`/dev-quality`/`/dev-test` references. Injected by `/hatch` when `hatch_mode = "safety"` (recommended for projects that already have their own commit/PR/release skills).
- `tests/` — `run-all.sh` central runner + `skill-structure.test.js` structural lint.
- `docs/` — `GIT-SAFETY.md` (what the hook blocks), `HOW-TO-USE.md` (workflow), `RECOMMENDED-PLUGINS.md` (companion suggestions). `WORKFLOW.md` describes the end-to-end mechanics.
- `.claude-plugin/plugin.json` — plugin manifest.
- `.claude-plugin/hermit-meta.json` — `required_core_version` and `requires` (hermit-internal, validator-invisible).

## Constraints

- Before implementing any new capability, check Claude Code docs (https://code.claude.com/docs) and plugins (https://claude.com/plugins) for native features that already cover it. If overlap exists, delegate — don't build. Specifically: built-in skills (`/code-review`, `/batch`, `/debug`), the plugin-owned `/claude-code-hermit:simplify` cleanup pass, and the `code-review@claude-plugins-official` plugin already cover common surfaces; link to them from CLAUDE-APPEND or this README rather than reimplementing.

## Hook Profiles

`git-push-guard` activates at **strict** profile only. `/hatch` defaults to installing strict and offers an explicit opt-out; once strict, `/hatch` re-runs never silently downgrade. See `docs/GIT-SAFETY.md` for the full profile model.

## Hatch target routing

`/hatch` Step 3 reads `.claude-code-hermit/state/hatch-options.json` (written by core hatch) to determine where to write the CLAUDE-APPEND block: `target = "local"` → `CLAUDE.local.md`; `target = "committed"` → `CLAUDE.md`. If core hatch hasn't run yet, the skill detects `core_install_scope` from `claude plugin list --json`, presents the scope-derived default at position 0 of the Visibility prompt, and stamps the full canonical schema (`target`, `core_install_scope`, `stamped_at`, `stamped_by`, `version`) into `hatch-options.json`. Applies to both `CLAUDE-APPEND.md` (standard) and `CLAUDE-APPEND-SAFETY.md` (safety) templates.

**Migration on target change.** When the operator flips `hatch_target` (e.g. via core 1.1.1's `hermit-evolve` Upgrade Instructions), the dev block can end up stranded in the old file. The most recent CHANGELOG entry's `### Upgrade Instructions` run a one-shot migration via `hermit-evolve` Step 7's sibling upgrade flow to strip the stranded block.

## Depends On

- `claude-code-hermit` v1.1.2+ (core). Authoritative source: `.claude-plugin/hermit-meta.json` (`required_core_version` field).

## Core Contracts

1. **Profile-gating**: `AGENT_HOOK_PROFILE` values are `minimal`/`standard`/`strict`. The `git-push-guard` hook self-gates on this and exits 0 immediately if the profile is not `strict`.
2. **Safety rules live in the selected CLAUDE-APPEND template**: the plugin no longer ships its own implementer agent. The rules in the chosen template (CLAUDE-APPEND.md for standard mode, CLAUDE-APPEND-SAFETY.md for safety mode) apply to whatever agent the operator uses. The `git-push-guard` hook backs §Git Safety at strict profile.
3. **Session state**: `.claude-code-hermit/state/runtime.json` is authoritative for session lifecycle. SHELL.md `Status:` is cosmetic only — never read it for programmatic state checks.
4. **Learning loop**: `reflect` runs at every task boundary (per core hermit's contract).
5. **Proposal gate**: the three-condition rule and tier mapping live in both CLAUDE-APPEND templates' §Dev Proposal Categories section.
