# Operator Context

This is the source monorepo for claude-code-hermit and its fleet plugins. The operator is actively building and shipping these plugins — focus is on feature development, iteration, and cutting releases.

## Project

Four plugins ship from `plugins/<slug>/`: `claude-code-hermit` (core), `claude-code-dev-hermit`, `claude-code-homeassistant-hermit`, `claude-code-fitness-hermit`. Independent versioning; each plugin has its own CHANGELOG, tests, and CLAUDE.md.

## Approval Gates

Releases and publishing require explicit approval. Everything short of a release (commits, PRs, test runs, refactors) can proceed without asking.

## Comms Style

Detailed — provide full context and explanation when reporting findings or changes. Don't skip rationale.

## CI

GitHub Actions (test-ha.yml, test-hooks.yml). Tests run from inside each plugin directory — not from repo root. CI covers all plugins on every PR regardless of which plugin changed; a failure in an unrelated plugin test is expected and not your fault.
