---
name: site-regression-triage
description: Correlate a flagged site-health regression with recent commits in the configured local site repo. Read-only — maps regressed pages to source files, ranks suspect commits by confidence, and writes a triage report. Run after site-health-check flags a regression.
---

# site-regression-triage — seo-hermit

Read-only investigation. It never edits the site repo — it explains *why* a regression likely
happened and whether a mechanical fix exists. Drafting fixes is `/seo-hermit:site-draft-fix`.

---

## Step 1 — Load the regression set

Read `state/site-health-ledger.json` and the latest `compiled/site-health-<date>.md`. Build the
regression set from the most recent report's Regressions + New-broken-links sections:

- regressed **pages** (search click/impression drops, index verdict flips),
- regressed **queries**,
- **CWV** pages that crossed to `needs-improvement`/`poor`,
- **broken internal links**.

Define the regression window: prior report's date → current report's date (fall back to the last
7–14 days if only one report exists).

## Step 2 — Resolve the site repo

Read `config.json["seo-hermit"].site_repo`.

- **unset / null** → **report-only mode**: skip commit correlation, still produce the triage artifact
  from the ledger evidence, and note "no site_repo configured — external cause cannot be ruled in/out."
- **set** → confirm the path exists and is a git repo (`git -C <repo> rev-parse --is-inside-work-tree`). If not, fall back to report-only mode and say so.

## Step 3 — Map regressed URLs to source files

For each regressed page URL, derive candidate source files. Use **read-only git only** — never write:

- `git -C <repo> log --since=<window-start> --until=<window-end> --stat` — commits in the window.
- `git -C <repo> show --stat <sha>` — files touched by a specific commit.

Map heuristics (best-effort, framework-agnostic):
- the URL path → a matching route/page/content file (e.g. `/blog/x` → `**/blog/x.*`, `content/blog/x.md`),
- shared **templates/layouts**, `robots.txt`, sitemap generators, and redirect files → global suspects
  for site-wide regressions.

## Step 4 — Correlate and rank

Assign each regression a confidence tier:

- **high** — a commit in the window touched the file backing the regressed page.
- **medium** — a commit touched a shared template/layout/config (robots.txt, sitemap generator,
  redirects, global CSS/JS affecting CWV).
- **low** — nothing in the window matches → "no candidate commit; likely external (algorithm/SERP
  shift, competitor, seasonality)."

For each regression, note whether a **mechanical fix** exists (the closed list `site-draft-fix`
handles): broken internal link on a confirmed slug rename, deleted page still in a static sitemap,
missing redirect for a renamed slug, missing/empty `<title>`/meta-description on a regressed page,
CLS-attributed image missing width/height.

## Step 5 — Write the triage report

Write `compiled/site-triage-<date>.md`:

```yaml
---
title: "Site regression triage — <date>"
type: site-triage
created: <ISO 8601 with offset>
session: <current session ID from SHELL.md>
tags: [site-triage]
---
```

Body, per regression: metric + delta, confidence tier, suspect commits (sha, subject, files),
mechanical-fix availability. Close with a one-line verdict per regression.

## Step 6 — Report

Channel summary per the core channel-send convention: the top regressions with their most likely
cause. If any mechanical fix was identified and `site_repo` is set, offer:
"Run `/seo-hermit:site-draft-fix` to draft the fix(es) on a branch for review."
Log one line to `SHELL.md`.
