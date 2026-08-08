# seo-hermit knowledge schema

Work-product and raw-capture types this plugin produces. Frontmatter on every `compiled/`
artifact: `title` (quoted), `type` (one of the keys below), `created` (ISO 8601 with offset),
`tags` (array), plus optional domain fields. Storage is flat — no subdirectories in `raw/` or
`compiled/` (base hermit storage contract).

## Work Products

- **site-health** — weekly site-health report. Only the metrics that changed since the last run;
  a quiet week is a single line. Producer: `seo-hermit:site-health-check`. Location:
  `compiled/site-health-<YYYY-MM-DD>.md`. Frontmatter carries `verdict: quiet | changes`.
- **site-triage** — regression-to-commit correlation for a flagged week: suspect commits, confidence
  tier, whether a mechanical fix exists. Producer: `seo-hermit:site-regression-triage`. Location:
  `compiled/site-triage-<YYYY-MM-DD>.md`.
- **site-fix** — record of a drafted mechanical fix: branch name, diff summary, approval outcome.
  Producer: `seo-hermit:site-draft-fix`. Location: `compiled/site-fix-<YYYY-MM-DD>.md`.

## Raw Captures

Retention: 14 days (base hermit `knowledge.raw_retention_days`).

- **site-health-snapshot** — the assembled weekly snapshot fed to the ledger diff.
  `raw/site-health-snapshot-<date>.json`.
- **gsc-search-analytics** — raw Search Console rows for the current + prior window.
  `raw/gsc-search-analytics-<date>.json`.
- **site-linkcheck** — sitemap link-check results. `raw/site-linkcheck-<date>.json`.
- **site-psi** — PageSpeed Insights field/lab metrics per sampled page. `raw/site-psi-<date>.json`.
- **site-inspect** — URL Inspection index-status results for the rotating budget.
  `raw/site-inspect-<date>.json`.

## State

- **site-health-ledger** — `state/site-health-ledger.json`. The rolling machine-readable ledger the
  weekly routine diffs against: search history (12 weeks), broken-link set with first/last-seen,
  CWV history per page (8 entries), index status sample, and the `inspect_cursor` for URL rotation.
  Permanent (trimmed in place, never archived).
