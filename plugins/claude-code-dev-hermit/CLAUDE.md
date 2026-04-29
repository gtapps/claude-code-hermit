# claude-code-dev-hermit

Language-agnostic safety layer for any agent doing dev work in a hermit project. Ships a `git-push-guard` hook, a one-time `/hatch` wizard, a `/dev-pr` skill, and a CLAUDE-APPEND template that injects safety rules into the project's CLAUDE.md.

## Plugin Structure

- `skills/hatch/` — one-time setup wizard. Idempotent, re-runnable, defaults to strict hook profile.
- `skills/dev-pr/` — push the current feature branch and open a PR with an inline-assembled body. Refuses on protected branches, dirty trees, or zero commits ahead.
- `skills/dev-quality/` — pre-wrap quality gate: runs `/simplify` on the working-tree diff and re-runs `commands.test` if configured. Surfaces failures; suggests `/code-review:code-review` when installed.
- `skills/dev-test/` — run the configured test suite and record the result to `state/last-test.json`. Useful for mid-task verification and warming the `/dev-pr` test cache.
- `scripts/git-push-guard.js` — strict-profile-only `PreToolUse` hook for Bash. Blocks `--no-verify`, force-push (incl. `--force-with-lease`), `--mirror`/`--all`, and direct push to any branch in `claude-code-dev-hermit.protected_branches`.
- `hooks/hooks.json` — registers `git-push-guard.js`.
- `state-templates/CLAUDE-APPEND.md` — the rules-of-the-road for any agent doing dev work in this project. Sections: §Git Safety, §Branch Discipline, §Implementation Flow, §Tests Before PR, §Technical Constraints, §Before Archiving a Task, §Dev Session Hygiene, §Dev Knowledge, §Dev Proposal Categories, §Dev Quick Reference. Injected by `/hatch` into the target project's `CLAUDE.md`.
- `tests/` — `run-all.sh` central runner + `skill-structure.test.js` structural lint.
- `docs/` — `GIT-SAFETY.md` (what the hook blocks), `HOW-TO-USE.md` (workflow), `RECOMMENDED-PLUGINS.md` (companion suggestions). `WORKFLOW.md` describes the end-to-end mechanics.
- `.claude-plugin/plugin.json` — plugin manifest.
- `.claude-plugin/hermit-meta.json` — `required_core_version` and `requires` (hermit-internal, validator-invisible).

## Constraints

- Before implementing any new capability, check Claude Code docs (https://code.claude.com/docs) and plugins (https://claude.com/plugins) for native features that already cover it. If overlap exists, delegate — don't build. Specifically: built-in skills (`/simplify`, `/batch`, `/debug`) and the `code-review@claude-plugins-official` plugin already cover common surfaces; link to them from CLAUDE-APPEND or this README rather than reimplementing.

## Hook Profiles

The `git-push-guard` hook activates at **strict** profile only (`AGENT_HOOK_PROFILE=strict`). `/hatch` defaults to installing strict and offers an explicit opt-out; once strict, `/hatch` re-runs never silently downgrade. See `docs/GIT-SAFETY.md` for the full profile model.

## Depends On

- `claude-code-hermit` v1.0.22+ (core). Authoritative source: `.claude-plugin/hermit-meta.json` (`required_core_version` field). Step 7 of v0.3.0 verified that the surviving 3 components (`hatch`, `dev-pr`, `git-push-guard`) only need core's config.json + CLAUDE-APPEND injection mechanism + hook-profile env var; the floor may be relaxed in a future release.

## Core Contracts

1. **Profile-gating**: `AGENT_HOOK_PROFILE` values are `minimal`/`standard`/`strict`. The `git-push-guard` hook self-gates on this and exits 0 immediately if the profile is not `strict`.
2. **Safety rules live in CLAUDE-APPEND.md**: the plugin no longer ships its own implementer agent. The rules in `state-templates/CLAUDE-APPEND.md` apply to whatever agent the operator uses (native `Agent` tool, `feature-dev`'s research/architect agents, custom subagents). The `git-push-guard` hook backs §Git Safety at strict profile.
3. **Session state**: `.claude-code-hermit/state/runtime.json` is authoritative for session lifecycle. SHELL.md `Status:` is cosmetic only — never read it for programmatic state checks.
4. **Learning loop**: `reflect` runs at every task boundary (per core hermit's contract).
5. **Proposal gate**: the three-condition rule and tier mapping live in `state-templates/CLAUDE-APPEND.md` §Dev Proposal Categories.
