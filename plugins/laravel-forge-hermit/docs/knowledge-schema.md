# laravel-forge-hermit knowledge schema

## Work Products

Work products live in `.claude-code-hermit/compiled/`. All artifacts are flat (no subdirectories).

- `deploy-incident`: per-failure deployment record with scrubbed log tail and resolution notes. **Producer**: `forge-deploy` skill on a `--watch` failure. **Location**: `compiled/deploy-incident-<site-name>-<YYYY-MM-DD>.md`. **Tags**: `[deploy, failure, <site-name>]`. **Retention**: indefinite (read by `[reliability]` proposals to identify patterns). **Secret hygiene**: log tail must be scrubbed of credentials before writing — see `forge-deploy` SKILL.md.

## Raw Captures

(none in v0.0.1 — the estate scan emits findings to stdout, not raw artifacts)

## Deferred types

The following types are reserved for future skills and must not be created manually:

- `estate-snapshot` — org-wide estate inventory (requires a producing skill)
- `forge-estate` — aggregated site/server registry (requires a producing skill)
- `forge-deploy-history` — cached deployment history (requires a producing skill)
