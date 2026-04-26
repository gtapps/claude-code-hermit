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

**Title (≤ 70 chars):**

Use the Conventional Commits prefix that matches the dominant type across the commit range (`feat:`, `fix:`, `chore:`, `refactor:`, `docs:`, `test:`). If there is only one commit, use its subject line verbatim (it's already conventional).

**Body:**

Check for `.github/PULL_REQUEST_TEMPLATE.md`. If present, fill it in using the commit range + diff as context.

If no template, use this structure:

```
## Summary
- <1-3 bullets: what changed and why>

## Test plan
- [ ] <how to verify the change works>
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
