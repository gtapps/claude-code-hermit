---
name: site-health-check
description: Weekly SEO/site-health routine. Pulls Search Console deltas, link-checks the sitemap, samples Core Web Vitals, inspects a rotating budget of URLs, diffs against the ledger, and reports only what changed. Runs via the site-health-weekly routine or on demand.
---

# site-health-check — seo-hermit

The weekly site-health pass. Everything runs through `${CLAUDE_PLUGIN_ROOT}/scripts/site-api.ts`
(under `--plugin-dir`, substitute the absolute plugin path — `${CLAUDE_PLUGIN_ROOT}` is not
expanded there). The diff is mechanical: the script owns the ledger comparison, so "report only
changes" is deterministic and a quiet week reliably collapses to one line.

Read `.claude-code-hermit/config.json` once for `["seo-hermit"]` settings (`inspect_budget` default
20, `link_check_budget` default 200) and `timezone`. All raw pulls are written flat to `raw/`.

---

## Step 1 — Preflight

Run `bun ${CLAUDE_PLUGIN_ROOT}/scripts/site-api.ts check`.

- Line 1 not `ok` → send one channel line ("Site health: GSC credentials {status} — run `/seo-hermit:hatch`") per the core channel-send convention, log it to `SHELL.md`, and **stop**.
- `ok` → continue. Note whether a `psi:ok` line is present; if not, skip the CWV step (Step 4).

## Step 2 — Compute windows

Search Console data lags ~3 days. Let `end = today − 3 days`.

- **current window**: the 7 days ending `end`.
- **prior window**: the 7 days immediately before the current window.

Record `week_end = end` (the current window's last day).

## Step 3 — Search Console deltas

For each window, run:

```
bun ${CLAUDE_PLUGIN_ROOT}/scripts/site-api.ts search-analytics --start <start> --end <end> --dimensions page --row-limit 20
```

Parse the two `{ok,data:{rows,totals}}` documents. Write both to `raw/gsc-search-analytics-<date>.json`.

## Step 4 — Core Web Vitals (skip if no `psi:ok`)

Pick the homepage plus the top 3 pages by clicks from the current-window rows (≤4 URLs). For each:

```
bun ${CLAUDE_PLUGIN_ROOT}/scripts/site-api.ts psi <url> --strategy mobile
```

Collect the `{url, strategy, lcp_ms, inp_ms, cls, perf_score}` results into `raw/site-psi-<date>.json`.

## Step 5 — Link check

```
bun ${CLAUDE_PLUGIN_ROOT}/scripts/site-api.ts link-check --budget <link_check_budget>
```

Write the `{results:[…]}` to `raw/site-linkcheck-<date>.json`.

## Step 6 — Index inspection (rotating budget)

```
bun ${CLAUDE_PLUGIN_ROOT}/scripts/site-api.ts sitemap
```

Take `inspect_budget` URLs from the sitemap starting at the ledger's `inspect_cursor` (read
`state/site-health-ledger.json`; default cursor 0; wrap around the end). Then:

```
bun ${CLAUDE_PLUGIN_ROOT}/scripts/site-api.ts inspect <url1> <url2> … --budget <inspect_budget>
```

Write to `raw/site-inspect-<date>.json`. (The script advances the cursor when the ledger runs.)

## Step 7 — Assemble the snapshot and diff the ledger

Write `raw/site-health-snapshot-<date>.json` with this exact shape (the ledger engine's input):

```json
{
  "date": "<today YYYY-MM-DD>",
  "week_end": "<week_end>",
  "search_current": { "totals": { "clicks": 0, "impressions": 0, "ctr": 0, "position": 0 } },
  "search_prior":   { "totals": { "clicks": 0, "impressions": 0, "ctr": 0, "position": 0 } },
  "links":  [ { "url": "", "status": 200, "ok": true, "final_url": "" } ],
  "cwv":    [ { "url": "", "strategy": "mobile", "lcp_ms": 0, "inp_ms": 0, "cls": 0, "perf_score": 0 } ],
  "index":  [ { "url": "", "verdict": "PASS", "coverage_state": "", "last_crawl_time": null, "robots_txt_state": "" } ],
  "sitemap_count": 0
}
```

(Use the `totals` from Step 3, the `results` arrays from Steps 4–6, and the sitemap length from Step
6. Omit `search_current`/`cwv` entries you don't have — pass `null` / `[]`.)

Then run the diff engine, which reads/writes `state/site-health-ledger.json` and prints the change set:

```
bun ${CLAUDE_PLUGIN_ROOT}/scripts/site-api.ts ledger --snapshot raw/site-health-snapshot-<date>.json
```

Parse `{ok,data:{quiet, regressions, improvements, new_broken, resolved, notes}}`.

## Step 8 — Write the report

Write `compiled/site-health-<date>.md` with frontmatter:

```yaml
---
title: "Site health — w/e <week_end>"
type: site-health
created: <ISO 8601 with offset>
session: <current session ID from SHELL.md>
tags: [site-health]
verdict: <quiet|changes>
---
```

Body: **only** the non-empty change categories, one short section each (Regressions, Improvements,
New broken links, Resolved, Notes). If `quiet`, the body is a single line: "No changes since last
week." Never pad with unchanged metrics.

## Step 9 — Channel brief

Per the core channel-send convention (channel first, push-notification fallback, else `SHELL.md`
Progress Log — send at most once):

- **quiet** → one line: `"Site health w/e <week_end>: no changes (<N> links, <M> URLs inspected, CWV stable)."`
- **changes** → ≤8 lines: lead with regressions and new broken links, then improvements/resolved. Link the report path.

## Step 10 — Regression handoff

If `regressions` or `new_broken` is non-empty, add a final report line:
"Regressions found — run `/seo-hermit:site-regression-triage` to correlate with recent commits."
Log one line to `SHELL.md` and close idle.
