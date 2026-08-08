<!-- seo-hermit: SEO Workflow -->
## SEO / Site-Health Workflow

This project runs the **seo-hermit** layer: a weekly-cadence watcher over Google Search Console,
broken links, and Core Web Vitals. The raw monitoring is commodity; the value is the judgment
layer — deciding which signal changes matter, correlating a regression with a specific deploy, and
drafting the fix. Everything below that line is a diff-and-report.

### Core rules

- **Read-only toward Google.** The plugin never writes to Search Console or any search-facing
  config. All GSC/PSI calls go through `scripts/site-api.ts`, which reads credentials from `.env`
  and never accepts them on a command line.
- **Never Read or relay the service-account JSON.** It holds an RSA private key. Its path lives in
  `SEO_HERMIT_GSC_CREDENTIALS`; credential validity is proven by `site-api.ts check`, never by
  opening the file.
- **Report only changes.** The weekly routine diffs against `state/site-health-ledger.json` and
  surfaces only what moved (new broken links, coverage flips, CWV threshold crossings, search
  deltas beyond ±20%). A quiet week is one line.
- **Writes to the site repo are approval-gated.** `site-draft-fix` drafts mechanical fixes on a
  branch inside the configured local site repo, shows the full diff, and waits for explicit
  approval before committing. It never pushes and never touches a protected branch.
- **URL Inspection is budgeted.** Index status is checked per-URL against a weekly budget
  (~2,000/day/property quota), rotating through the sitemap via a cursor in the ledger.

### Skills

- `/seo-hermit:hatch` — one-time setup (credentials, live GSC check, routine wiring).
- `/seo-hermit:site-health-check` — weekly routine: pull deltas, diff the ledger, report changes.
- `/seo-hermit:site-regression-triage` — correlate a flagged regression with recent site-repo commits.
- `/seo-hermit:site-draft-fix` — draft a mechanical fix on a branch, behind the approval gate.

### Conventions

- Machine-readable diff state lives in `state/site-health-ledger.json` (rolling history, trimmed).
- Durable dated reports go to `compiled/site-health-<date>.md`; raw API pulls to `raw/` (flat, no subdirs).
- Credentials: service-account JSON in `.claude.local/`, PSI key in `.env`. Both gitignored.
<!-- /seo-hermit: SEO Workflow -->
