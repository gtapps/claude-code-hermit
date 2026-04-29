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

### Gate 0 — preconditions

```bash
git diff --quiet && git diff --cached --quiet
```

If both are empty: FAIL `"no working-tree diff — nothing to simplify"`.

### Gate 1 — run `/simplify`

Invoke `/simplify` on the current diff. Wait for it to complete. If `/simplify` reports no changes, note `simplify: no changes` and continue to Gate 2 anyway.

### Gate 2 — re-run tests

If `commands.test` is unset: skip this gate, record `tests: skipped`, and proceed to Gate 3 pass path.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/record-test-result.js" run
```

Use `timeout: 600000`. Records the result to `last-test.json`.

### Gate 3 — report

**Tests pass:**

Report the outcome. Then check whether `/code-review:code-review` is in the agent's available slash-command list. If available, append:

```
next: suggest the operator run /code-review:code-review for a deeper review before commit
```

Do **not** invoke `/code-review:code-review` autonomously — operator decision only. Skill exits clean; simplified changes remain uncommitted for the operator to commit.

**Tests fail:**

FAIL with `"tests regressed after /simplify (exit <N>) — investigate before committing"` and the last 20 lines of stderr. Leave the working tree as-is (post-simplify state) — the agent or operator decides whether to fix forward or revert the simplify pass manually (`git checkout -- <files>`).

## Output

```
dev-quality
  diff:     12 files modified
  simplify: applied
  tests:    pass (12.3s)
  next:     suggest operator run /code-review:code-review (installed)
  status:   ok
```

On Gate 3 failure:

```
dev-quality
  diff:     12 files modified
  simplify: applied
  tests:    FAIL (exit 1, 8.7s)
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

On Gate 0 failure:

```
dev-quality
  FAIL (Gate 0): no working-tree diff — nothing to simplify
```

## Rules

- **Main session only.** Subagents cannot invoke skills (see CLAUDE-APPEND §Technical Constraints) — `/dev-quality` only fires from the main session.
- **Never invokes `/code-review:code-review`.** Suggests it to the operator when available; the operator decides.
- **Never commits.** Leaves the diff uncommitted for the operator.
- **Never modifies the working tree on test failure.** Surfaces the regression and stops; no rollback.
- **Writes `last-test.json`, but no cross-skill contract.** The record is written at the pre-commit HEAD. After committing, `/dev-pr` sees a stale SHA and re-runs tests — expected behaviour.
