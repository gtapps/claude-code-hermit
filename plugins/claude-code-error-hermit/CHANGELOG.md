# Changelog — claude-code-error-hermit

## [Unreleased]

## [0.0.1] - 2026-07-03

Initial release: a production-error watcher for Sentry/GlitchTip. Built in four phases (API client → watch loop → repro/draft-fix → incident memory), all shipping together in the first version.

### Added
- **API client (`scripts/error-api.ts` + `error-api-lib.ts`)** — zero-dependency Bun `fetch` client covering both Sentry and GlitchTip via the shared `/api/0/` shape. Subcommands: `check`, `issues`, `issue`, `latest-event`, and the approval-gated `resolve` / `mute`. The token is never printed (`redact()` scrubs all output).
- **Two-layer write gate** — `resolve`/`mute` refuse without an exact `--confirm` token and send no request; a `write-confirm-gate.ts` PreToolUse hook enforces the same at a second, fail-open layer.
- **Watch loop** — `scripts/error-precheck.ts` is a zero-token gate (reads the cursor, never writes it, prints `SKIP` / `EVALUATE` / `ERROR`); `skills/error-triage` classifies new vs regression vs known-noise against `compiled/error-noise-ledger.md`, correlates with releases, and severity-gates to a DM or the digest queue. Wired as an hourly `error-triage` routine.
- **Repro + fix** — `skills/error-reproduce` (throwaway worktree at the offending SHA, failing test from the stack, `git bisect` to the suspect commit) and `skills/error-draft-fix` (fix on an `error-fix/<shortId>` branch, failing test committed first; push/PR delegated to `/claude-code-dev-hermit:dev-pr`, never improvised).
- **Incident memory** — `skills/error-incident-summary` (post-incident writeup linked from the ledger) and `skills/error-digest` (overnight summary draining the queue into one channel message, approvals as micro-proposals). Digest routine is offered optionally at hatch.
- **hatch skill** — verifies credentials with a live `check`, drops the noise-ledger template, injects the Error Watch block, extends the knowledge schema, stamps `config.json`, and registers the routines.
- **Offline test suite** — lib parsers, a `Bun.serve` fixture server driving the CLI and precheck, the hook matrix, and skill-structure checks. No live backend required.

### Files affected

| File | Change |
|------|--------|
| `.claude-plugin/{plugin,hermit-meta}.json` | new manifests, core `>=1.2.14` |
| `scripts/error-api-lib.ts`, `error-api.ts`, `error-precheck.ts` | client + watch gate |
| `hooks/{hooks.json,write-confirm-gate.ts}` | write-confirm gate |
| `skills/{hatch,error-triage,error-reproduce,error-draft-fix,error-incident-summary,error-digest}/SKILL.md` | six skills |
| `state-templates/CLAUDE-APPEND.md`, `state-templates/compiled/error-noise-ledger.md`, `docs/knowledge-schema.md` | operator-facing docs + templates |
| `tests/**` | offline suite + fixtures |

### Upgrade Instructions

Fresh install — no migration. Run `/claude-code-error-hermit:hatch` in the project you want to watch (after `/claude-code-hermit:hatch`).
