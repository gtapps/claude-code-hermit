# seo-hermit

A weekly SEO/site-health watcher for [claude-code-hermit](https://github.com/gtapps/claude-code-hermit).

It pulls Google Search Console deltas, checks the sitemap for broken links, samples Core Web Vitals
via PageSpeed Insights, and inspects a rotating budget of URLs for index status — then reports **only
what changed** since last week. When a metric regresses, it correlates the regression with recent
commits in your site's repo and can draft the mechanical fix on a branch for your approval.

## Positioning (read this first)

The raw monitoring here is commodity — cheap incumbents and a cron + link-checker cover most of it,
and the signals move weekly, not hourly. seo-hermit earns its keep in the **judgment layer**:
deciding which of many Search Console warnings matter, tying a Core Web Vitals regression to a
specific deploy, and drafting the fix when your site's repo is available locally. If you just want
raw dashboards, use the incumbents. If you want a hermit that watches, correlates, and drafts, this
is that.

## What runs weekly

1. Search Console click/impression/position deltas (current week vs prior, ~3-day data lag applied).
2. Sitemap link-check (bounded concurrency, HEAD-first).
3. Core Web Vitals (LCP / INP / CLS) for the homepage + top pages, via PageSpeed Insights (optional).
4. URL Inspection index status for a rotating budget of sitemap URLs.

All of it diffs against `state/site-health-ledger.json`. A quiet week is one line; a week with
changes gets a compact report and a channel brief.

## Requirements

- Core `claude-code-hermit` ≥1.2.14, installed and hatched.
- A **Google Search Console** property and a **service account** with read access to it.
- Optionally, a **PageSpeed Insights** API key (enables the Core Web Vitals checks).

### Search Console setup

1. In Google Cloud console, create/pick a project and enable the **Search Console API**.
2. Create a **service account**, download its JSON key, save it to `.claude.local/gsc-service-account.json`.
3. In Search Console, add the service account's `client_email` as a **user** on your property.

## Install

```
claude plugin marketplace add gtapps/claude-code-hermit
claude plugin install seo-hermit@claude-code-hermit --scope local
```

Then run `/seo-hermit:hatch` in the target project.

## Environment (`.env`)

| Variable | Required | Meaning |
|----------|----------|---------|
| `SEO_HERMIT_SITE_URL` | yes | GSC property — `sc-domain:example.com` or `https://www.example.com/`. |
| `SEO_HERMIT_SITEMAP_URL` | yes | Full sitemap URL. |
| `SEO_HERMIT_GSC_CREDENTIALS` | yes | Path to the service-account JSON (keep it in `.claude.local/`). |
| `SEO_HERMIT_PSI_KEY` | no | PageSpeed Insights API key. Blank → CWV checks skipped. |

The variable names deliberately avoid `TOKEN`/`SECRET`/`API_KEY` so the base hermit's deny-patterns
hook doesn't block routine reads of `.env`.

## Safety posture

- **Read-only toward Google.** No writes to Search Console or any search-facing config.
- **Fix-drafting is approval-gated.** `site-draft-fix` only ever drafts on a branch inside your
  configured local site repo, shows the full diff, and waits for your approval. It never pushes and
  never touches a protected branch. The closed set of fixes it will draft: broken internal links
  (on a confirmed slug rename), stale static-sitemap entries, missing redirects for renamed slugs,
  empty `<title>`/meta-description on a regressed page, and missing image width/height behind a CLS
  regression.
- **Quota-aware.** URL Inspection is capped to a weekly budget (default 20 URLs), rotating through
  the sitemap across weeks (Google's quota is ~2,000/day/property).
