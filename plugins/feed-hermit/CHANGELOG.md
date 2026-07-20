# Changelog

All notable changes to this project will be documented in this file.

---

## [Unreleased]

### Added
- **Initial plugin — feed-to-brief pipeline extracted from a standalone feed hermit.** One domain plugin, four internal layers: (1) brief engine (`feed-brief`, `weekly-digest`, the `source-fetcher` Haiku agent, `FEEDS.md` tone template, archive-frontmatter analytics contract, `pending-delivery` recovery queue), (2) source curation (`feed-sources.md`/`feed-categories.md` registry with a `validate-sources` PostToolUse hook, plus `add-source`/`source-scout`/`source-health`), (3) fetch adapters (`reddit-fetch.ts` unauthenticated-by-default with optional authed path; Chrome-typed sources skip gracefully when Chrome is down), (4) `story-arcs` + `deep-dive` follow-ups.
- **`fetch-guard` PreToolUse hook** — WebFetch domain allowlist derived from `feed-sources.md` plus an infra list; blocks off-allowlist fetches (fail-open on unreadable registry) as prompt-injection containment.
- **`hatch`** — seeds empty `feed-sources.md`/`feed-categories.md`/`FEEDS.md` (opt-in starter pack), registers morning/evening/weekly routines and a monthly `source-scout` scheduled check, and appends the Feed Workflow block to the consumer's `CLAUDE.md`.

### Upgrade Instructions
No manual steps. New plugin — run `/feed-hermit:hatch` in a project that already has the core hermit hatched.
