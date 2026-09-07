# claude-code-dev-hermit

Language-agnostic safety layer for any agent doing dev work in a hermit project: a `git-push-guard` hook, a worktree boundary guard, a one-time `/hatch` wizard, `/dev-pr`, `/dev-quality`, `/dev-test`, diagnosis and merge-conflict skills, and a CLAUDE-APPEND template that injects safety rules into the project's instructions.

## Structure

- `skills/`: one directory per skill; each `SKILL.md` frontmatter describes it. `diagnosing-bugs` and `resolving-merge-conflicts` are adapted from mattpocock/skills (MIT). `domain-brainstorm` is operator-invoked only and carries its own retirement criteria.
- `scripts/git-push-guard.ts`: strict-profile-only `PreToolUse` hook for Bash. Blocks `--no-verify`, `--force`/`-f` (always), `--force-with-lease` on protected branches or without an explicit refspec, `--mirror`/`--all`, and direct push to any branch in `claude-code-dev-hermit.protected_branches`.
- `scripts/worktree-boundary-guard.ts`: `PreToolUse` hook for `Edit`/`Write`. In a linked git worktree, blocks edits that escape into the main checkout (`.claude-code-hermit/` carved out). No profile gate, inert outside worktrees; `WORKTREE_GUARD=off` disables it.
- `state-templates/CLAUDE-APPEND.md`: single-source template with `<!-- mode:standard-only -->` / `<!-- mode:safety-only -->` markers. Safety rendering is a strict subset: no §Implementation Flow or `/dev-quality`/`/dev-test` references, trimmed §Dev Quick Reference, reworded §Before Archiving bullet (for projects with their own commit/PR/release skills). §Dev Proposal Categories (three-condition rule, tier mapping) is mode-independent.
- `scripts/render-append.ts`: `bun scripts/render-append.ts <standard|safety>` strips the markers and emits the selected block; exports pure `render(mode, templateText)`. `scripts/render-append.test.ts` pins both outputs against `tests/fixtures/`; update the fixtures deliberately when the intended instructions change.
- `docs/`: `GIT-SAFETY.md` (what the hook blocks, the profile model), `HOW-TO-USE.md`, `WORKFLOW.md` (end-to-end mechanics), `RECOMMENDED-PLUGINS.md`.

Tests: `bash tests/run-all.sh` runs the structural lint plus every `scripts/*.test.ts`.

## Contracts

- **Profiles.** `AGENT_HOOK_PROFILE` is `minimal`/`standard`/`strict`; `git-push-guard` exits 0 immediately unless `strict`. `/hatch` defaults to strict, offers an explicit opt-out, and re-runs never silently downgrade an existing strict install.
- **Safety rules live in the rendered CLAUDE-APPEND block**, applied to whatever agent the operator uses; the plugin ships no implementer agent. `git-push-guard` backs §Git Safety at strict.
- **Session state** is core's `.claude-code-hermit/state/runtime.json`. SHELL.md `Status:` is cosmetic; never read it programmatically.
- **Native surfaces first.** `/code-review` and `/simplify` already cover review and cleanup; CLAUDE-APPEND links to them rather than reimplementing. (`/debug` toggles Claude Code session debug logging, not code debugging.)

## Hatch target routing

Core's `scripts/domain-hatch.ts` owns install-scope detection, target resolution, and `hatch-options.json`. `/hatch` Step 1 runs `.claude-code-hermit/bin/hermit-run domain-hatch preflight claude-code-dev-hermit`, asks the Visibility question only when `needs_target_question` says so, and records the answer with `domain-hatch ensure-target claude-code-dev-hermit --target <choice>`. Step 3 pipes the mode-specific rendering into `domain-hatch sync-block claude-code-dev-hermit --rendered-stdin`, so a mode change is a block replacement. Core `hermit-evolve` defers this block because only `render-append.ts` can resolve the mode markers: after a plugin update, re-run `/claude-code-dev-hermit:hatch`.
