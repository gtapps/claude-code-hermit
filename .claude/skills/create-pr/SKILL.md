---
name: create-pr
description: Open a pull request for the current branch — pushes if needed, drafts a title and body from commits + diff, then runs `gh pr create`. Trigger when the user says "open a PR", "create pr", "send this for review", "pr this", "make a pull request", or finishes a feature branch and wants it reviewed. NOT for committing — defer to `/commit` first if the tree is dirty. NOT for cutting a release — that's `/release`. Use this proactively whenever the user has a pushed feature branch that doesn't yet have an open PR.
---

# Create PR

Push the branch if needed, draft a PR title and body from the commit range, wait for approval, then open the PR via `gh`. No commit, no merge, no tag.

## Guardrails (check before starting)

- **On `main`/`master`/default branch** → stop; tell the user to switch to a feature branch first.
- **Dirty tree** (`git status -s` is non-empty) → stop; point at `/commit`.
- **Detached HEAD, mid-rebase, or mid-merge** → stop; ask the user to resolve that first.
- **0 commits ahead of base** → stop; nothing to PR.
- **PR already open** (`gh pr list --head <branch> --state open`) → stop and print the existing URL.
- Never `--force`, `--no-verify`, close, or merge PRs from this skill.

## Steps

### 1. Detect branch state

```bash
git branch --show-current          # current branch
gh repo view --json defaultBranchRef -q .defaultBranchRef.name  # base (fallback: main)
git log --oneline <base>..HEAD     # commits ahead
git diff --stat <base>...HEAD      # files changed
```

Run the guardrails against these results before continuing.

### 2. Push the branch

- **No upstream set** → `git push --set-upstream origin <branch>`.
- **Upstream exists, local is ahead** → `git push`.
- **Local is behind upstream** → stop and ask the user (don't auto-rebase or force-push).

### 3. Draft title and body

**Detect plugin release branch:** Check if the current branch matches `<short-slug>/vX.Y.Z` (e.g. `dev-hermit/v0.3.0`, `hermit/v1.0.22`, `ha-hermit/v0.0.7`). If so, set `$PLUGIN_BRANCH=true` and infer the full plugin slug (`dev-hermit` → `claude-code-dev-hermit`, etc.).

**Title (≤ 70 chars):**

- **Plugin release branch**: use `release(<slug>): v<X.Y.Z>` derived from the branch name.
- **Otherwise**: use the Conventional Commits prefix that matches the dominant type across the commit range (`feat:`, `fix:`, `chore:`, `refactor:`, `docs:`, `test:`). If there is only one commit, use its subject line verbatim.

**Body:**

- **Plugin release branch**: detect which workflow applies and extract changelog content accordingly.

  **Post-release-prep (standard):** Run `git log <base>..HEAD --oneline` and look for lines matching the release commit format `<slug> v<X.Y.Z>: <summary>` (e.g. `claude-code-dev-hermit v0.2.2: /dev-pr skill, watchdog infrastructure`). For each matched slug+version, extract the `## [X.Y.Z]` section from `plugins/<slug>/CHANGELOG.md`:

  ```bash
  awk -v ver="X.Y.Z" '
    $0 ~ "^## \\[" ver "\\]" {flag=1; next}
    /^## \[/ && flag {exit}
    flag {print}
  ' plugins/<slug>/CHANGELOG.md
  ```

  For multi-plugin releases (multiple release commits on this branch), concatenate all sections in release order (core first), each preceded by a `### <slug> v<X.Y.Z>` heading.

  **Pre-release-prep (fallback):** If no release commits are found (PR opened before `/release` prep runs), fall back to reading the `## [Unreleased]` section from `plugins/<slug>/CHANGELOG.md` using the slug inferred from the branch name.

  Use the extracted content as the Summary block. Append the squash-merge warning below.
- **Otherwise**: check for `.github/PULL_REQUEST_TEMPLATE.md`. If present, fill it in using the commit range + diff as context. If no template:

  ```
  ## Summary
  - <1-3 bullets: what changed and why>

  ## Test plan
  - [ ] <how to verify the change works>
  ```

**Squash-merge warning (plugin release branches only):**

Append to the body after the Summary block:

```
---
> ⚠️ **Merge as merge commit — not squash or rebase.** Squash changes the
> SHA and strands the release tag on an orphan commit. After merging, run
> `/release <slug>` from `main` for each released plugin to tag.
```

**Issue links:**

Scan commit subjects, commit bodies, and the branch name for bare `#N`, `closes #N`, or `fixes #N` patterns. If found, append `Closes #N` lines after the Summary block.

### 4. Show the draft and wait for approval

Print the proposed title and full body verbatim. Then ask:

```
AskUserQuestion — single question, header "PR draft":
  "Ready to open this PR?"
  options:
    { label: "Approve", description: "Open the PR as-is" }
    { label: "Open as draft", description: "Open with --draft flag (not ready for review)" }
    { label: "Edit title/body", description: "Paste a replacement — I'll use what you provide" }
    { label: "Cancel", description: "Abort, don't open anything" }
```

If the user chooses **Edit**, ask them to paste the replacement title on one line followed by the body, then continue with their version.

If the user chooses **Cancel**, stop cleanly.

### 5. Open the PR

```bash
gh pr create \
  --base "<base>" \
  --head "<branch>" \
  --title "<title>" \
  --body "$(cat <<'EOF'
<body here>
EOF
)"
```

Add `--draft` if the user chose "Open as draft".

### 6. Report

Print the PR URL returned by `gh pr create`. Done — don't request reviewers, add labels, or do anything else.
