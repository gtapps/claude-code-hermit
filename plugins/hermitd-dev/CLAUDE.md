# hermitd-dev

Language-agnostic safety layer for any agent doing dev work in a hermit project: a `git-push-guard` hook, a worktree boundary guard, a one-time `/hatch` wizard, diagnosis and merge-conflict skills, and a CLAUDE-APPEND template that injects safety rules into the project's instructions.

## Structure

- `skills/`: one directory per skill; each `SKILL.md` frontmatter describes it. `diagnosing-bugs` and `resolving-merge-conflicts` are adapted from mattpocock/skills (MIT). `domain-brainstorm` is operator-invoked only and carries its own retirement criteria.
- `scripts/git-push-guard.ts`: strict-profile-only `PreToolUse` hook for Bash. Blocks `--no-verify`, `--force`/`-f` (always), `--force-with-lease` on protected branches or without an explicit refspec, `--mirror`/`--all`, and direct push to any branch in `hermitd-dev.protected_branches`.
- `scripts/worktree-boundary-guard.ts`: `PreToolUse` hook for `Edit`/`Write`. In a linked git worktree, blocks edits that escape into the main checkout (`.hermit/` carved out). No profile gate, inert outside worktrees; `WORKTREE_GUARD=off` disables it.
- `docs/`: `GIT-SAFETY.md` (what the hook blocks, the profile model), `HOW-TO-USE.md`, `RECOMMENDED-PLUGINS.md`.

Tests: `bash tests/run-all.sh` runs the structural lint plus every `scripts/*.test.ts`.

## Contracts

- **Profiles.** `AGENT_HOOK_PROFILE` is `minimal`/`standard`/`strict`; `git-push-guard` exits 0 immediately unless `strict`. `/hatch` defaults to strict, offers an explicit opt-out, and re-runs never silently downgrade an existing strict install.
- **Safety rules live in the rendered CLAUDE-APPEND block**, applied to whatever agent the operator uses; the plugin ships no implementer agent. `git-push-guard` backs §Git Safety at strict.
- **Execution state** is core's `.hermit/state/execution.json`; commitments live in task records.
- **Native surfaces first.** `/code-review` and `/simplify` already cover review and cleanup; CLAUDE-APPEND links to them rather than reimplementing. (`/debug` toggles Claude Code session debug logging, not code debugging.)

## Hatch target routing


Core owns target resolution. Hatch runs `domain-hatch preflight`, records Visibility with `domain-hatch ensure-target`, and applies `CLAUDE-APPEND.md` with `domain-hatch sync-block hermitd-dev`. Core `hermit-evolve` syncs this block on upgrade.
