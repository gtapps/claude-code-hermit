---
name: dev-quality
description: Run the post-implementation quality pass — tests, simplify, tests, risk check. Call this after implementation completes, before marking the task done.
---
# /dev-quality

Run the full quality pass on the current implementation. Call after implementation completes (via `claude-code-dev-hermit:implementer` or direct edits), before the task completion checklist.

## Steps

### 1. Read config

Read `.claude-code-hermit/config.json` → `claude-code-dev-hermit.commands.test`, `claude-code-dev-hermit.commands.typecheck`, `claude-code-dev-hermit.commands.lint`, and `claude-code-dev-hermit.protected_branches`.

If `claude-code-dev-hermit.commands.test` is null or absent: emit one line — `No test command configured. Run /claude-code-dev-hermit:dev-adapt to set one.` — then stop with an advisory (do not fail the task; the operator may not have tests).

### 2. Determine the diff

Get the set of changed files using, in order of preference:

1. The implementer's returned file list (from its `### Files Modified` summary) — most accurate after a worktree handoff
2. `git diff $(git merge-base HEAD $(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's|refs/remotes/||') 2>/dev/null || echo HEAD~1) HEAD --name-only` — everything on this branch not yet on the default branch
3. `git diff HEAD~1 HEAD --name-only` — fallback for the last commit only

### 3. Baseline test run

Run `claude-code-dev-hermit.commands.test`, plus `claude-code-dev-hermit.commands.typecheck` and `claude-code-dev-hermit.commands.lint` if configured. Capture exit code and last 30 lines of output for each.

If tests fail: **stop and report** — there is a pre-existing failure to fix before running quality. Do not proceed to simplify.

Lint failure at this stage is **report-only** — do not block simplify. Style nits are exactly what simplify may clean up. Record the result for the regression comparison in step 6.

### 4. Snapshot pre-simplify state

Before running `/simplify`, record a snapshot SHA that works regardless of dirty/clean working tree:

```bash
PRESIMPLIFY=$(git stash create)
[ -z "$PRESIMPLIFY" ] && PRESIMPLIFY=$(git rev-parse HEAD)
```

`git stash create` writes a stash commit object without touching the index, working tree, or stash stack. It returns an empty string (exit 0) when the tree is already clean — the fallback to `HEAD` handles that case. **Do not use `git stash push`** — it fails silently when the tree is clean, which is the normal state after the implementer commits.

**Staged-edits warning:** if `git diff --cached --quiet` exits non-zero, warn the operator: "staged edits exist at snapshot time — revert via PRESIMPLIFY will overwrite them."

Note: `git stash create` does not include untracked files. For the standard implementer flow (all changes committed), this is fine. If the operator has untracked files in the changed-files set, surface a warning rather than silently losing them.

### 5. Run /simplify

Invoke `/simplify` on the changed files identified in step 2.

### 6. Re-run tests

Run the same commands as step 3.

**If tests pass and lint did not regress:** proceed. The `PRESIMPLIFY` snapshot from step 4 is no longer needed.

**If lint regresses** (was passing in step 3, fails now after simplify): treat it as a test regression — trigger the revert path below.

**If tests regress (or lint regressed):**

1. Restore the changed files to their pre-simplify state using the file list from Step 2:
   ```bash
   git checkout $PRESIMPLIFY -- <file1> <file2> ...
   ```
2. If the checkout applies cleanly: proceed with the pre-simplify code. Log to SHELL.md: `simplify caused regression — reverted to pre-simplify snapshot`.
3. If the checkout fails (e.g. merge conflict, missing path): **stop and ask the operator** — do not silently overwrite their edits. Log the conflict to SHELL.md.

### 7. Risk classification

Look at the diff content (from step 2 source). Classify risk as `low` / `medium` / `high` using judgment, not path matching. Categories that warrant elevated risk:

- Auth, session, identity, permissions, or credentials code
- Database schema migrations or raw SQL
- Deploy, release, or production configuration
- Secret handling or key management
- Public API contracts (routes, SDK methods, serialization formats)
- Concurrency, background jobs, or queue consumers
- CI/CD workflow changes
- Dependency version bumps crossing a major version
- Changes with no tests covering the modified logic

Write one sentence of reasoning tied to the actual change ("adds a new column to users table with no migration rollback path" — not just "touched migrations/").

If `high`: emit — `Risk-high change: invoke /code-review:code-review before merging.`

This is a recommendation, not an automatic invocation. The operator decides.

### 8. Report

Emit the report block exactly — same keys every run:

```
dev-quality report
  test:      <pass|fail> (<Xs>)   — `<command>`
  typecheck: <pass|fail|skipped>  — `<command or "not configured">`
  lint:      <pass|fail|skipped>  — `<command or "not configured">`
  simplify:  <applied|reverted|conflict — ask operator>
  risk:      <low|medium|high>    — <one sentence reasoning>
  review:    <not needed|recommended — /code-review:code-review>
  concerns:  <none or specific notes>
```
