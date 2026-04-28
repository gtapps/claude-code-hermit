# claude-code-dev-hermit

Git safety, quality workflow, and dev conventions for claude-code-hermit.

## Plugin Structure

- `agents/` — implementer agent (worktree-isolated code writing)
- `skills/` — hatch, dev-adapt, dev-branch, dev-up, dev-down, dev-log-watch, dev-status, dev-quality, dev-cleanup, dev-doctor
- `hooks/hooks.json` — git-push-guard hook (strict profile only)
- `scripts/` — hook scripts; `scripts/lib/` — shared Node helpers (resolve-command, port-check, health-poll, log-watch-builder, dev-server-command, shell-utils) with co-located `.test.js` runners
- `state-templates/` — CLAUDE-APPEND.md (dev workflow rules appended to CLAUDE.md)
- `docs/` — DEV-LOG-WATCH.md, SKILLS.md, WORKFLOW.md, etc.
- `.claude-plugin/plugin.json` — plugin manifest

## Constraints

- Before implementing any new capability, check Claude Code docs (https://code.claude.com/docs)
  and plugins (https://claude.com/plugins) for native features that already cover it.
  If overlap exists, delegate — don't build. Specifically: built-in skills (`/simplify`, `/batch`, `/debug`) and the `code-review@claude-plugins-official` plugin already cover common surfaces; link to them from the relevant skill instead of reimplementing. Invoke `/code-review` explicitly for PR review and high-stakes code.

## Hook Profiles

The `git-push-guard` hook activates at **strict** profile only (`AGENT_HOOK_PROFILE=strict`).
The `hatch` skill recommends enabling strict profile during setup.

## Depends On

- `claude-code-hermit` v1.0.22+ (core)

## Core Contracts

1. **Profile-gating**: `AGENT_HOOK_PROFILE` values are `minimal`/`standard`/`strict`. Hooks self-gate on this.
2. **Session lifecycle**: `/session-close` is operator-only — never invoke programmatically. Dev workflow operates within core's session loop.
3. **Ambient rules always apply**: git safety, task checklist, and proposal categories apply to all dev work regardless of how the session started.
4. **Learning loop**: invoke `reflect` at every task boundary.
5. **Proposal gate**: three-condition rule and tier mapping live in `state-templates/CLAUDE-APPEND.md` (Dev Proposal Categories §).
6. **Session state**: `.claude-code-hermit/state/runtime.json` is authoritative. SHELL.md `Status:` is cosmetic only — never read it for programmatic state checks.
