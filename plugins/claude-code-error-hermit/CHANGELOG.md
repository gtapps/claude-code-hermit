# Changelog — claude-code-error-hermit

## [Unreleased]

## [0.0.1] - 2026-07-03

Initial scaffold: a Sentry/GlitchTip watcher plugin (Phase 1 of 4 — API client + hatch).

### Added
- **API client (`scripts/error-api.ts` + `error-api-lib.ts`)** — zero-dependency Bun `fetch` client covering both Sentry and GlitchTip via the shared `/api/0/` shape. Subcommands: `check`, `issues`, `issue`, `latest-event`, and the approval-gated `resolve` / `mute`.
- **Write gating** — `resolve`/`mute` refuse without an exact `--confirm` token and send no request; a `write-confirm-gate.ts` PreToolUse hook enforces the same at a second layer.
- **Token redaction** — all error output passes through `redact()`; the token is never printed.
- **hatch skill** — verifies credentials with a live `check`, injects the Error Watch block, extends the knowledge schema, and stamps `config.json`.
- **Offline test suite** — lib parsers, a `Bun.serve` fixture server driving the CLI, the hook matrix, and skill-structure checks. No live backend required.

### Files affected

| File | Change |
|------|--------|
| `.claude-plugin/{plugin,hermit-meta}.json` | new manifests, core `>=1.2.14` |
| `scripts/error-api-lib.ts`, `scripts/error-api.ts` | API client |
| `hooks/{hooks.json,write-confirm-gate.ts}` | write-confirm gate |
| `skills/hatch/SKILL.md` | setup wizard |
| `state-templates/CLAUDE-APPEND.md`, `docs/knowledge-schema.md` | operator-facing docs |
| `tests/**` | offline suite + fixtures |

### Upgrade Instructions

Fresh install — no migration. Run `/claude-code-error-hermit:hatch` in the project you want to watch (after `/claude-code-hermit:hatch`).
