---
name: dev-test
description: Run the configured test suite and record the result to .claude-code-hermit/state/last-test.json. /dev-pr reads this record; a fresh pass at HEAD skips re-running. Use for mid-task verification, debugging a failing test in isolation, or as a building block for /dev-quality.
---

# /dev-test

Run the project's configured test command and record the result.

## Plan

Run the following Bash command. Use `timeout: 600000` (10-min ceiling).

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/record-test-result.js" run
```

If exit 0: report `tests: pass`.

If exit 1 and stderr is `"commands.test not configured"`: tell the operator to set `commands.test` in `.claude-code-hermit/config.json` (or re-run `/claude-code-dev-hermit:hatch`).

If exit non-zero for any other reason: report `tests: FAIL (exit N)` with the last 10 lines of output.

## Notes

`/dev-pr` invokes the same machinery on cache miss — running `/dev-test` first is optional but warms the cache (a second `/dev-pr` call at the same HEAD skips the test run entirely).

For suites longer than 10 min (Bash ceiling): run the test command directly in a terminal, then record the result manually:

```bash
node <CLAUDE_PLUGIN_ROOT>/scripts/record-test-result.js write <exit_code> <duration_ms>
```

Then re-run `/dev-pr`.
