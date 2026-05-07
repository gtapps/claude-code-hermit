---
name: dev-quality
description: Pre-wrap quality gate. Runs /simplify on the working-tree diff, re-runs commands.test, and reports results. Suggests /code-review:code-review when installed. Run this before committing.
---

# /dev-quality

Run a quality pass on the working-tree diff before declaring the task done. Invokes `/simplify`, re-runs the configured test command, and reports the outcome. Call this at task wrap-up, before committing.

## Prerequisites

- Verify `.claude-code-hermit/sessions/` exists. If not: tell the operator to run `/claude-code-hermit:hatch` and `/claude-code-dev-hermit:hatch` first.
- Read `commands.test` from `.claude-code-hermit/config.json`. If unset, the test step is skipped — `/simplify` still runs.

## Plan

### Argument

Optional `--cwd <path>`. When set, all git operations and the test re-run target `<path>` instead of `$PWD`. `<path>` must be a git working tree. Use this for nested-repo workflows (see CLAUDE-APPEND §Implementation Flow). State (`last-test.json`, hermit dir) still resolves from `$PWD`.

In the gates below, use `git -C "<path>"` for every git invocation when `--cwd` is set, otherwise omit the `-C` and run against `$PWD` as today. Below this is written as `git -C "$TARGET"` with `$TARGET` standing for either form.

### Gate 0 — preconditions

```bash
git -C "$TARGET" diff --quiet && git -C "$TARGET" diff --cached --quiet
```

If both are empty: working tree is clean. Before failing, check whether HEAD has commits ahead of the base:

1. Resolve `BASE_NAME` using the same priority order as `/dev-pr` Gate 0 step 4 (`pr_base_branch` → first non-glob `protected_branches` → `origin/HEAD` → `main`/`master`).
2. Resolve `BASE_REF`: try `git -C "$TARGET" rev-parse --verify "$BASE_NAME" 2>/dev/null`; on failure try `git -C "$TARGET" rev-parse --verify "origin/$BASE_NAME" 2>/dev/null`; if neither resolves, skip the NOTICE.
3. If `git -C "$TARGET" rev-list --count "$BASE_REF..HEAD"` > 0, emit before failing:

   ```
   NOTICE: working tree is clean but HEAD has N commits ahead of <BASE_NAME>.
           /dev-quality is designed to run BEFORE commit (so /simplify can edit the diff).
           Correct order: /dev-quality → commit → /dev-pr.
           To verify the committed state passes tests, run /dev-test instead.
   ```

Then FAIL `"no working-tree diff — nothing to simplify"`. Append the hint `hint: if edits are in a nested git repo, re-run with --cwd <path>` unless `--cwd` was already passed.

### Gate 1 — run `/simplify`

Invoke `/simplify` on the current diff. Wait for it to complete. If `/simplify` reports no changes, note `simplify: no changes` and continue to Gate 2 anyway.

When `--cwd <path>` is set, scope `/simplify` to files under `<path>` — list them via `git -C "<path>" diff --name-only` and pass that file set as the focus. Don't simplify outside `<path>`.

### Gate 2 — re-run tests

If `commands.test` is unset: skip this gate, record `tests: skipped`, and proceed to Gate 3 pass path.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/record-test-result.js" run
```

When `--cwd <path>` is set, append `--cwd "<path>"` to the invocation. The script runs the test command from `<path>` and records `<path>`'s HEAD SHA into `last-test.json` (so `/dev-pr` cache checks against the right commit).

Use `timeout: 600000`. Records the result to `last-test.json`.

### Gate 3 — report

**Tests pass:**

Report the outcome. Then check whether `/code-review:code-review` is in the agent's available slash-command list. If available, append:

```
next: suggest the operator run /code-review:code-review for a deeper review before commit
```

Do **not** invoke `/code-review:code-review` autonomously — operator decision only. Skill exits clean; simplified changes remain uncommitted for the operator to commit.

**Tests fail:**

Read `state/last-test.json` and include `likely_cause` in the failure message if present. FAIL with `"tests regressed after /simplify (exit <N>[, likely OOM|timeout|user-interrupt]) — investigate before committing"` and the last 20 lines of stderr. Leave the working tree as-is (post-simplify state) — the agent or operator decides whether to fix forward or revert the simplify pass manually (`git checkout -- <files>`).

## Output

```
dev-quality
  diff:     12 files modified
  simplify: applied
  tests:    pass (12.3s)
  next:     suggest operator run /code-review:code-review (installed)
  status:   ok
```

When invoked with `--cwd <path>`, prepend a `target:` line:

```
dev-quality
  target:   packages/foo
  diff:     3 files modified
  simplify: applied
  tests:    pass (4.1s)
  status:   ok
```

On Gate 3 failure:

```
dev-quality
  diff:     12 files modified
  simplify: applied
  tests:    FAIL (exit 137, likely OOM, 8.7s)
  recovery: investigate the regression; fix forward or `git checkout -- <files>` to revert the simplify pass
  status:   tests-regressed
```

When `commands.test` is unset:

```
dev-quality
  diff:     12 files modified
  simplify: applied
  tests:    skipped (commands.test not configured)
  status:   ok
```

On Gate 0 failure (clean tree, commits ahead):

```
dev-quality
  NOTICE: working tree is clean but HEAD has 3 commits ahead of main.
          /dev-quality is designed to run BEFORE commit (so /simplify can edit the diff).
          Correct order: /dev-quality → commit → /dev-pr.
          To verify the committed state passes tests, run /dev-test instead.
  FAIL (Gate 0): no working-tree diff — nothing to simplify
```

On Gate 0 failure (clean tree, no commits ahead or base unresolvable):

```
dev-quality
  FAIL (Gate 0): no working-tree diff — nothing to simplify
                 hint: if edits are in a nested git repo, re-run with --cwd <path>
```

(The `hint:` line is omitted when `--cwd` was already passed.)

## Rules

- **Main session only.** Subagents cannot invoke skills (see CLAUDE-APPEND §Technical Constraints) — `/dev-quality` only fires from the main session.
- **Never invokes `/code-review:code-review`.** Suggests it to the operator when available; the operator decides.
- **Never commits.** Leaves the diff uncommitted for the operator.
- **Never modifies the working tree on test failure.** Surfaces the regression and stops; no rollback.
- **Writes `last-test.json`, but no cross-skill contract.** The record is written at the pre-commit HEAD. After committing, `/dev-pr` sees a stale SHA and re-runs tests — expected behaviour.
