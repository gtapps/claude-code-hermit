---
name: dev-quality
description: Pre-wrap quality gate. Runs /claude-code-hermit:simplify for a cleanup pass on the working-tree diff (including untracked files), re-runs commands.test, and reports results. Suggests /code-review for a deeper review. Run this before committing.
---

# /dev-quality

Run a cleanup pass on the working-tree changes before declaring the task done. Invokes `/claude-code-hermit:simplify` — three parallel reviewers (reuse, quality, efficiency) propose edits; the skill applies the edits it picks (per its Principles) and reports totals. Then re-runs the configured test command. Call this at task wrap-up, before committing.

## Prerequisites

- Verify `.claude-code-hermit/sessions/` exists. If not: tell the operator to run `/claude-code-hermit:hatch` and `/claude-code-dev-hermit:hatch` first.
- Read `.claude-code-hermit/config.json` once. Cache `commands.test` (if unset, the test step is skipped — `/claude-code-hermit:simplify` still runs) and `claude-code-dev-hermit.protected_branches` (default `["main", "master"]` if absent).

## Plan

### Argument

Optional `--cwd <path>`. When set, all git operations and the test re-run target `<path>` instead of `$PWD`. `<path>` must be a git working tree. Use this for nested-repo workflows (see CLAUDE-APPEND §Implementation Flow). State (`last-test.json`, hermit dir) still resolves from `$PWD`.

In the gates below, use `git -C "<path>"` for every git invocation when `--cwd` is set, otherwise omit the `-C` and run against `$PWD` as today. Below this is written as `git -C "$TARGET"` with `$TARGET` standing for either form.

### Gate 0 — preconditions

```bash
git -C "$TARGET" status --porcelain
```

Empty output → working tree is clean (no modified, staged, or untracked-but-not-ignored files). Any non-empty output passes Gate 0, including untracked-only changes — `/claude-code-hermit:simplify` captures new files via `git status --short` + synthetic `+++` blocks, so a task that only adds files still has cleanup scope.

Before failing on empty output, run the following checks in order:

1. Resolve `BASE_NAME` using the same priority order as `/dev-pr` Gate 0 step 4 (`pr_base_branch` → first non-glob `protected_branches` → `origin/HEAD` → `main`/`master`).
2. Resolve `BASE_REF`: try `git -C "$TARGET" rev-parse --verify "$BASE_NAME" 2>/dev/null`; on failure try `git -C "$TARGET" rev-parse --verify "origin/$BASE_NAME" 2>/dev/null`; if neither resolves, skip the NOTICE.
3. If `git -C "$TARGET" rev-list --count "$BASE_REF..HEAD"` > 0, emit before failing:

   ```
   NOTICE: working tree is clean but HEAD has N commits ahead of <BASE_NAME>.
           /dev-quality is designed to run BEFORE commit (so cleanup edits can be applied to the working tree before they're locked into a commit).
           Correct order: /dev-quality → commit → /dev-pr.
           To verify the committed state passes tests, run /dev-test instead.
   ```

4. Detect whether the current branch is protected using bash glob semantics (same pattern as `/dev-pr` Gate 0 step 1):

   ```bash
   PROTECTED_BRANCHES=(main master)   # from config.claude-code-dev-hermit.protected_branches
   CURRENT_BRANCH=$(git -C "$TARGET" rev-parse --abbrev-ref HEAD)
   ON_PROTECTED=0
   for pattern in "${PROTECTED_BRANCHES[@]}"; do
     case "$CURRENT_BRANCH" in $pattern) ON_PROTECTED=1 ;; esac
   done
   ```

   - If `ON_PROTECTED=1`: FAIL `"no working-tree changes — nothing to clean up"` with hint:
     ```
     hint: you're on protected branch '<CURRENT_BRANCH>' with a clean tree.
           create a feature branch before making changes (see CLAUDE-APPEND.md §Branch Discipline).
     ```
   - Otherwise: FAIL `"no working-tree changes — nothing to clean up"`. Append `hint: if edits are in a nested git repo, re-run with --cwd <path>` unless `--cwd` was already passed.

### Gate 1 — run `/claude-code-hermit:simplify`

Invoke `/claude-code-hermit:simplify` on the current working tree. Wait for it to complete.

When `--cwd <path>` is set, scope the cleanup pass to files under `<path>` — list them via `git -C "<path>" status --porcelain` (covers tracked changes + untracked) and pass that file set as the focus. Don't review files outside `<path>`.

`/claude-code-hermit:simplify` applies its own edits (parallel review, sequential apply with conflict resolution per the skill's Principles) and ends with a totals line:

```
Totals: applied N · deduped M · principle-rejected K · stale-anchor skips L · parse failures P
```

Capture the content after the `Totals:` label and pass through to Gate 3 as the `simplify:` field value. If the totals line is missing or unparseable, record `simplify: completed (totals unavailable)` and continue to Gate 2. Never block on totals ambiguity.

### Gate 2 — re-run tests

If `commands.test` is unset: skip this gate, record `tests: skipped`, and proceed to Gate 3 pass path.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/record-test-result.js" run
```

When `--cwd <path>` is set, append `--cwd "<path>"` to the invocation. The script runs the test command from `<path>` and records `<path>`'s HEAD SHA into `last-test.json` (so `/dev-pr` cache checks against the right commit).

Use `timeout: 600000`. Records the result to `last-test.json`.

### Gate 3 — report

**Tests pass:**

Report the outcome. Append:

```
next: suggest the operator run /code-review for a deeper review before commit
```

Do **not** invoke `/code-review` autonomously — operator decision only. Skill exits clean; reviewed changes remain uncommitted for the operator to commit.

**Tests fail:**

Read `state/last-test.json` and include `likely_cause` in the failure message if present. FAIL with `"tests regressed after applied edits (exit <N>[, likely OOM|timeout|user-interrupt]) — investigate before committing"` and the last 20 lines of stderr. Leave the working tree as-is (post-apply state) — the agent or operator decides whether to fix forward or revert the applied edits manually (`git checkout -- <files>`).

## Output

`simplify:` is the totals line emitted by `/claude-code-hermit:simplify`, copied verbatim: `applied N · deduped M · principle-rejected K · stale-anchor skips L · parse failures P`. On totals-missing: `completed (totals unavailable)` (see Gate 1 fallback). No `unapplied:` block — `/claude-code-hermit:simplify` reports its own "Noticed but not applied" section inline before the totals line.

```
dev-quality
  diff:        12 files modified
  simplify:    applied 4 · deduped 1 · principle-rejected 2 · stale-anchor skips 0 · parse failures 0
  tests:       pass (12.3s)
  next:        suggest operator run /code-review
  status:      ok
```

When invoked with `--cwd <path>`, prepend a `target:` line:

```
dev-quality
  target:      packages/foo
  diff:        3 files modified
  simplify:    applied 1 · deduped 0 · principle-rejected 0 · stale-anchor skips 0 · parse failures 0
  tests:       pass (4.1s)
  status:      ok
```

On Gate 3 failure:

```
dev-quality
  diff:        12 files modified
  simplify:    applied 2 · deduped 0 · principle-rejected 1 · stale-anchor skips 0 · parse failures 0
  tests:       FAIL (exit 137, likely OOM, 8.7s)
  recovery:    investigate the regression; fix forward or `git checkout -- <files>` to revert the applied edits
  status:      tests-regressed
```

When `commands.test` is unset:

```
dev-quality
  diff:        12 files modified
  simplify:    applied 1 · deduped 0 · principle-rejected 0 · stale-anchor skips 0 · parse failures 0
  tests:       skipped (commands.test not configured)
  status:      ok
```

On Gate 0 failure (clean tree, commits ahead):

```
dev-quality
  NOTICE: working tree is clean but HEAD has 3 commits ahead of main.
          /dev-quality is designed to run BEFORE commit (so cleanup edits can be applied to the working tree before they're locked into a commit).
          Correct order: /dev-quality → commit → /dev-pr.
          To verify the committed state passes tests, run /dev-test instead.
  FAIL (Gate 0): no working-tree changes — nothing to clean up
```

On Gate 0 failure (clean tree, no commits ahead or base unresolvable):

```
dev-quality
  FAIL (Gate 0): no working-tree changes — nothing to clean up
                 hint: if edits are in a nested git repo, re-run with --cwd <path>
```

(The `hint:` line is omitted when `--cwd` was already passed.)

On Gate 0 failure (clean tree, on a protected branch):

```
dev-quality
  FAIL (Gate 0): no working-tree changes — nothing to clean up
                 hint: you're on protected branch 'main' with a clean tree.
                       create a feature branch before making changes (see CLAUDE-APPEND.md §Branch Discipline).
```

## Rules

- **Main session only.** Subagents cannot invoke skills (see CLAUDE-APPEND §Technical Constraints) — `/dev-quality` only fires from the main session.
- **Never invokes `/code-review`.** Suggests it to the operator; the operator decides.
- **Never commits.** Leaves the diff uncommitted for the operator.
- **Never modifies the working tree on test failure.** Surfaces the regression and stops; no rollback.
- **Writes `last-test.json`, but no cross-skill contract.** The record is written at the pre-commit HEAD. After committing, `/dev-pr` sees a stale SHA and re-runs tests — expected behaviour.
