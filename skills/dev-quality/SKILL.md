---
name: dev-quality
description: Run the post-implementation quality pass — tests, simplify, tests again, review. Call this after implementation completes, before marking the task done.
---
# /dev-quality

Run the full quality pass on the current implementation. Invoke this after implementation completes (via `claude-code-dev-hermit:implementer` agent or direct edits), before the task completion checklist.

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
  - Proceed to review with the pre-simplify code

### 4. Run `code-review:code-review`

- If critical issues are found: report them to the operator and loop back to implementation
- If clean or minor issues only: proceed

## Output

Report back:
- Test status (pass/fail, before and after simplify)
- Whether `/simplify` was applied or reverted
- Review recommendation (`approve` / `request-changes` / `discuss`)
- Any critical issues that require looping back to implementation

## Notes

- If the code review surfaces a repeated pattern (e.g., same class of bug in 3+ files), note it as a proposal candidate but do not create the proposal here — let `reflect` handle it at the task boundary.
