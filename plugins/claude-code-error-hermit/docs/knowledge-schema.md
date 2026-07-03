# claude-code-error-hermit knowledge schema

## Work Products

Work products live in `.claude-code-hermit/compiled/`. All artifacts are flat (no subdirectories).

- `error-noise-ledger`: living ledger of error fingerprints classified as known-noise, known, or fixed-in-`<release>`. **Producer**: `error-triage` skill. **Location**: `compiled/error-noise-ledger.md`. **Retention**: indefinite (the classification memory of the whole plugin).
- `incident-summary`: post-incident writeup — timeline, root cause, fix link, detection gap. **Producer**: `error-incident-summary` skill. **Location**: `compiled/incident-<YYYY-MM-DD>-<slug>.md`. **Retention**: indefinite. **Secret hygiene**: scrub quoted event data before writing.

## Raw Captures

- `error-triage-log`: per-run triage findings — the groups seen since the cursor, their classification, and release correlation. **Producer**: `error-triage` skill. **Location**: `raw/error-triage-<YYYY-MM-DD>.md`. **Retention**: 30 days. **Secret hygiene**: event detail must be scrubbed of credentials before writing.
