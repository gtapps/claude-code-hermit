# claude-code-error-hermit knowledge schema

## Work Products

Work products live in `.claude-code-hermit/compiled/`. All artifacts are flat (no subdirectories).

- `error-noise-ledger`: living ledger of error fingerprints classified as known-noise, known, or fixed-in-`<release>`. **Producer**: `error-triage` skill (Phase 2). **Location**: `compiled/error-noise-ledger.md`. **Retention**: indefinite (the classification memory of the whole plugin).

## Raw Captures

- `error-triage-log`: per-run triage findings — the groups seen since the cursor, their classification, and release correlation. **Producer**: `error-triage` skill (Phase 2). **Location**: `raw/error-triage-<YYYY-MM-DD>.md`. **Retention**: 30 days. **Secret hygiene**: event detail must be scrubbed of credentials before writing.

## Deferred types

Reserved for later phases; must not be created manually until their producing skill ships:

- `incident-summary` — post-incident writeup (Phase 4, `error-incident-summary` skill). `compiled/incident-<YYYY-MM-DD>-<slug>.md`.
