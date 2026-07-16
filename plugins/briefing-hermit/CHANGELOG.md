# Changelog

All notable changes to this project will be documented in this file.

---

## [Unreleased]

### Added
- **Initial plugin — news/trending briefing pipeline extracted from a standalone briefing hermit.** One domain plugin, four internal layers: (1) briefing engine (`news-brief`, `weekly-digest`, the `source-fetcher` Haiku agent, `BRIEFING.md` tone template, archive-frontmatter analytics contract, `pending-delivery` recovery queue), (2) source curation (`sources.md`/`categories.md` registry with a `validate-sources` PostToolUse hook, plus `add-source`/`source-scout`/`source-health`), (3) fetch adapters (`reddit-fetch.ts` unauthenticated-by-default with optional authed path; Chrome-typed sources skip gracefully when Chrome is down), (4) `story-arcs` + `deep-dive` follow-ups.
- **`fetch-guard` PreToolUse hook** — WebFetch domain allowlist derived from `sources.md` plus an infra list; blocks off-allowlist fetches (fail-open on unreadable registry) as prompt-injection containment.
- **`hatch`** — seeds empty `sources.md`/`categories.md`/`BRIEFING.md` (opt-in starter pack), registers morning/evening/weekly routines and a monthly `source-scout` scheduled check, and appends the Briefing Workflow block to the consumer's `CLAUDE.md`.

### Upgrade Instructions
No manual steps. New plugin — run `/briefing-hermit:hatch` in a project that already has the core hermit hatched.
