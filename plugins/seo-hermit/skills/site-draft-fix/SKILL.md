---
name: site-draft-fix
description: Draft a mechanical SEO fix on a branch inside the configured local site repo, behind an explicit approval gate. Handles broken internal links, stale sitemap entries, missing redirects, empty title/meta tags, and CLS image dimensions. Never pushes; never touches a protected branch.
---

# site-draft-fix — seo-hermit

Drafts a **mechanical** fix for a finding from `/seo-hermit:site-regression-triage`, on a branch, and
stops for approval before committing. Write-only toward the operator's own repo; read-only toward
everything else. This skill does the one thing incumbents can't: turn a diagnosed regression into a
reviewable diff.

---

## Closed fix list (nothing outside this)

Draft **only** these, and only when triage positively identified the cause:

1. **Broken internal link** → rewrite the `href` to the resolvable target — only when git history
   shows the slug was renamed (the old target once existed at the new path).
2. **Deleted page still in a static sitemap file** → remove the stale `<url>` entry.
3. **Missing redirect for a renamed slug** → add a redirect rule, only in a format you can positively
   identify in the repo: `_redirects`, `netlify.toml`, or `vercel.json`.
4. **Missing/empty `<title>` or meta-description on a regressed page** → populate from the page's `h1`
   (or existing frontmatter title). Never invent marketing prose.
5. **CLS-attributed image missing `width`/`height`** → add the intrinsic attributes, only when triage
   tied the CLS regression to that image.

Anything else — content rewrites, config redesigns, dependency changes, "while I'm here" edits — is
**out of scope**. If the fix isn't on this list, say so and stop.

## Gate — before any change

Read `config.json["seo-hermit"].site_repo`. Then, inside that repo, verify **all** of:

- `site_repo` is set and is a git work tree (`git -C <repo> rev-parse --is-inside-work-tree`). Unset → stop: "No site_repo configured; nothing to draft against."
- **Clean tree**: `git -C <repo> status --porcelain` is empty. Dirty → stop and surface the diff; let the operator commit/stash first.
- **Not detached HEAD**: `git -C <repo> symbolic-ref -q HEAD` succeeds.
- The change set is **≤10 files**. More than that → do **not** draft; file a proposal via
  `/claude-code-hermit:proposal-create` describing the scope, and stop.

If any gate fails, stop with the specific reason. Do not attempt a workaround.

## Step 1 — Branch

Determine the repo's default branch (`git -C <repo> symbolic-ref refs/remotes/origin/HEAD` or fall
back to the current branch). **Refuse to proceed if the current branch is a protected branch**
(`main`/`master`, or the repo's own configured protected list). Create:

```
git -C <repo> checkout -b seo-hermit/fix-<YYYY-MM-DD>-<slug>
```

`<slug>` is a short kebab descriptor of the fix (e.g. `broken-blog-links`).

## Step 2 — Apply the mechanical edits

Make only the edits from the closed list, only for the findings triage confirmed. Use the Edit tool.
Keep each edit surgical — every changed line must trace to a specific finding.

## Step 3 — Surface, then approve

Show the operator the **full diff** (`git -C <repo> diff`). Summarize what changed and why (which
finding each edit addresses). Then ask with `AskUserQuestion`:

> "Commit these fixes on branch `seo-hermit/fix-…`? (commit / discard)"

- **discard** → `git -C <repo> checkout .` and delete the branch; report that nothing was committed.
- **commit** → continue.

**Never commit without this explicit approval.** **Never `git push`.**

## Step 4 — Commit

```
git -C <repo> add -A
git -C <repo> commit -m "fix(seo): <summary>"
```

## Step 5 — PR handoff (optional)

- If `claude-code-dev-hermit` is installed and hatched in the site repo → offer to open the PR via
  `/claude-code-dev-hermit:dev-pr --cwd <site_repo>` (its Gate 0, protected-branch, and test gates
  apply; `--cwd` targets the site repo's own remote).
- Otherwise → stop at the local branch and print the manual push/PR steps. Do not push.

## Step 6 — Record

Write `compiled/site-fix-<date>.md`:

```yaml
---
title: "Site fix draft — <date>"
type: site-fix
created: <ISO 8601 with offset>
session: <current session ID from SHELL.md>
tags: [site-fix]
---
```

Body: branch name, the findings addressed, a diff summary (files + one line each), and the approval
outcome (committed / discarded, PR opened or manual steps printed). Log one line to `SHELL.md`.
