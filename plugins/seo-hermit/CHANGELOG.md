# Changelog — seo-hermit

## [Unreleased]

### Added
- **Scaffold + hatch** — new domain plugin `seo-hermit`. One-time `/seo-hermit:hatch` wizard collects the site URL, sitemap URL, a Google Search Console service-account JSON path, and an optional PageSpeed Insights key, then verifies GSC access with a live `searchAnalytics.query` round-trip. Requires `claude-code-hermit` ≥1.2.14.
- **`scripts/site-api.ts`** — zero-dependency Bun client for the Search Console and PageSpeed Insights APIs. Ships the `check` (credential probe: `missing`/`invalid`/`unreachable`/`ok`) and `search-analytics` subcommands. Service-account auth is a JWT-bearer flow signed with `node:crypto` — no npm packages.
- **`site-health-weekly` routine + ledger** — weekly `/seo-hermit:site-health-check` pulls Search Console deltas, link-checks the sitemap, samples Core Web Vitals via PageSpeed Insights, and inspects a rotating budget of URLs for index status. Everything diffs against `state/site-health-ledger.json`; only changes are reported. A quiet week is one line.
- **Judgment layer** — `/seo-hermit:site-regression-triage` correlates a regression with recent commits in a locally-configured site repo; `/seo-hermit:site-draft-fix` drafts mechanical fixes (broken internal links, stale sitemap entries, missing redirects/meta tags, CLS image dimensions) on a branch, behind an explicit approval gate. Read-only toward Google; write-only toward the operator's own repo.

### Upgrade Instructions
New plugin — no in-place migration. Install with `claude plugin install seo-hermit@claude-code-hermit`, then run `/seo-hermit:hatch` in the target project.
