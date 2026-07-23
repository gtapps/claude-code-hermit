# Changelog

## [Unreleased]

### Fixed
- No-op `Write(path)` settings rules no longer trigger a boot warning; `Write(tmp/**)` is now `Edit(tmp/**)` so tmp fetch-scratch writes are auto-approved.

## [0.1.1] - 2026-07-21

### Fixed
- The `briefs` archive is now in `storage_drift.ignore`, preventing core session-start and reflect checks from reporting the canonical archive as layout drift.

### Upgrade Instructions

1. **Read `.claude-code-hermit/config.json`.**
2. **Ensure `storage_drift` is an object** — create it if absent or malformed, preserving any valid sibling keys.
3. **Ensure `storage_drift.ignore` is an array** — create it as an empty array if absent or malformed, preserving any existing entries.
4. **Append `"briefs"` to `storage_drift.ignore`** if it is not already present.
5. **Write the updated `config.json`.**

**Note:** `.claude-code-hermit/briefs/` is feed-hermit's own archive — nothing under it is moved or rewritten.

---

## [0.1.0] - 2026-07-20

### Added
- A feed-to-brief pipeline extracted from a standalone feed hermit, with a brief engine (`feed-brief`, `weekly-digest`, the `source-fetcher` Haiku agent, `FEEDS.md`, archive-frontmatter analytics, and `pending-delivery` recovery), source curation (`feed-sources.md`/`feed-categories.md`, `validate-sources`, `add-source`, `source-scout`, and `source-health`), fetch adapters (`reddit-fetch.ts` and graceful Chrome-source skips), and `story-arcs`/`deep-dive` follow-ups.
- The `fetch-guard` PreToolUse hook derives a WebFetch domain allowlist from `feed-sources.md` and infrastructure sources, blocking off-allowlist fetches while failing open when the registry is unreadable.
- `hatch` seeds an opt-in `feed-sources.md`/`feed-categories.md`/`FEEDS.md` starter pack, registers feed routines and the monthly `source-scout` check, and adds the Feed Workflow block to the consumer `CLAUDE.md`.

### Upgrade Instructions
No manual steps. New plugin — run `/feed-hermit:hatch` in a project that already has the core hermit hatched.
