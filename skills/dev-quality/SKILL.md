---
name: dev-quality
description: Run the post-implementation quality pass — tests, simplify, tests. Call this after implementation completes, before marking the task done.
---
# /dev-quality

Run the full quality pass on the current implementation. Invoke this after implementation completes (via `claude-code-dev-hermit:implementer` agent or direct edits), before the task completion checklist.

`/simplify` already runs parallel review agents (reuse, quality, efficiency) on the changed files, so a separate code-review pass is not part of the default flow. For PR review, security-sensitive changes, or large refactors where a heavier second pass is warranted, invoke `code-review:code-review` explicitly after this skill returns.

## Steps

### 1. Run tests

Confirm the implementation works. If tests fail, stop and report — there is a pre-existing failure to fix first.

### 2. Run `/simplify` on changed files

Use `git diff --name-only` or the implementer's returned file list to identify which files to pass.

### 3. Run tests again

Confirm `/simplify` didn't break anything.

- If tests fail after `/simplify`:
  - Revert the `/simplify` changes (`git checkout` on affected files)
  - Log to SHELL.md: "simplify caused test regression — committed without simplification"
  - Proceed with the pre-simplify code

## Output

Report back:
- Test status (pass/fail, before and after simplify)
- Whether `/simplify` was applied or reverted
