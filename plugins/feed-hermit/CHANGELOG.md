# Changelog

All notable changes to this project will be documented in this file.

---

## [Unreleased]

### Fixed
- **settings: drop no-op `Write(path)` rules** — Claude Code only matches file-permission checks against `Edit(path)` (which already covers Write), so the `Write(...)` allow/deny entries were dead and tripped a boot warning. `Write(tmp/**)` becomes `Edit(tmp/**)` so tmp fetch-scratch writes are actually auto-approved (the old `Write(...)` rule never matched, so they weren't before).

## [0.1.1] - 2026-07-21

### Fixed
- **hatch: register the `briefs` archive in `storage_drift.ignore`** — prevents core session-start and reflect checks from reporting feed-hermit's canonical archive as layout drift.

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
- **Initial plugin — feed-to-brief pipeline extracted from a standalone feed hermit.** One domain plugin, four internal layers: (1) brief engine (`feed-brief`, `weekly-digest`, the `source-fetcher` Haiku agent, `FEEDS.md` tone template, archive-frontmatter analytics contract, `pending-delivery` recovery queue), (2) source curation (`feed-sources.md`/`feed-categories.md` registry with a `validate-sources` PostToolUse hook, plus `add-source`/`source-scout`/`source-health`), (3) fetch adapters (`reddit-fetch.ts` unauthenticated-by-default with optional authed path; Chrome-typed sources skip gracefully when Chrome is down), (4) `story-arcs` + `deep-dive` follow-ups.
- **`fetch-guard` PreToolUse hook** — WebFetch domain allowlist derived from `feed-sources.md` plus an infra list; blocks off-allowlist fetches (fail-open on unreadable registry) as prompt-injection containment.
- **`hatch`** — seeds empty `feed-sources.md`/`feed-categories.md`/`FEEDS.md` (opt-in starter pack), registers morning/evening/weekly routines and a monthly `source-scout` scheduled check, and appends the Feed Workflow block to the consumer's `CLAUDE.md`.

### Upgrade Instructions
No manual steps. New plugin — run `/feed-hermit:hatch` in a project that already has the core hermit hatched.
