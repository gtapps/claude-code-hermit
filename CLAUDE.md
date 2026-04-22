# claude-code-dev-hermit

Git safety, quality workflow, and dev conventions for claude-code-hermit.

## This Repo is a Plugin

This repo is a Claude Code plugin. It extends `claude-code-hermit` (core v1.0.16+) with software development capabilities.

Install flow for target projects:

```
claude plugin marketplace add gtapps/claude-code-hermit
claude plugin install claude-code-hermit@claude-code-hermit --scope project
/claude-code-hermit:hatch

claude plugin marketplace add gtapps/claude-code-dev-hermit
claude plugin install claude-code-dev-hermit@claude-code-dev-hermit --scope project
/claude-code-dev-hermit:hatch
```

## Plugin Structure

- `agents/` — implementer agent (worktree-isolated code writing)
- `skills/` — hatch, dev-quality, dev-cleanup
- `hooks/hooks.json` — git-push-guard hook (strict profile only)
- `scripts/` — hook scripts
- `state-templates/` — CLAUDE-APPEND.md (dev workflow rules appended to CLAUDE.md)
- `.claude-plugin/plugin.json` — plugin manifest

## Constraints

- Before implementing any new capability, check Claude Code docs (https://code.claude.com/docs)
  and plugins (https://claude.com/plugins) for native features that already cover it.
  If overlap exists, delegate — don't build.

## Hook Profiles

The `git-push-guard` hook activates at **strict** profile only (`AGENT_HOOK_PROFILE=strict`).
The `hatch` skill recommends enabling strict profile during setup.

## Built-in Claude Code Skills Used

- `/simplify` — code cleanup after implementation
- `/batch` — parallel pattern-based execution
- `/debug` — diagnostics for blocked work

Code review: `/simplify` runs parallel review agents (reuse/quality/efficiency) as part of `/claude-code-dev-hermit:dev-quality` and covers the quality bar for typical solo work. The `code-review` plugin (`code-review@claude-plugins-official`) is an optional companion offered during `/claude-code-dev-hermit:hatch` for PR review and high-stakes code — invoke `/code-review` explicitly when warranted.

## Depends On

- `claude-code-hermit` v1.0.16+ (core)

## Core Contracts

1. Profile-gating via `AGENT_HOOK_PROFILE` env var (`minimal`/`standard`/`strict`)
2. Session lifecycle: dev workflow operates within core's session loop; `/session-close` is only called by the operator
3. State dir: `.claude-code-hermit/` (sessions/, proposals/, reviews/, templates/, state/, raw/, compiled/)
4. Learning loop: invoke `reflect` at every task boundary
5. Ambient dev rules: git safety, task checklist, and proposal categories apply to all dev work regardless of how it was initiated
6. Proposal gate: three-condition rule and tier mapping — see CLAUDE-APPEND.md Dev Proposal Categories
7. Scheduled checks: companion plugin health registered via `scheduled_checks` in config.json during `/claude-code-dev-hermit:hatch` setup
8. Session state: `state/runtime.json` is the authoritative lifecycle source; SHELL.md `Status:` is cosmetic only — never read it for programmatic state checks
