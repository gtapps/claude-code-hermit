---
name: test-run
description: Run the hermit plugin test suites and report pass/fail summary
triggers:
  - /claude-code-hermit:test-run
---

# Test Run

Run all hermit test suites and report a concise pass/fail summary.

## Steps

1. Run all suites via the unified entry point:
   ```bash
   bash ${CLAUDE_PLUGIN_ROOT}/tests/run-all.sh 2>&1
   ```

2. Report results:
   - Show the final result line from each suite (`Ran N tests — OK` and `=== Results: N passed, 0 failed ===`)
   - If any test failed, show the failing test names and their error output
   - Exit message: `All tests passed.` or `X test(s) failed — see above.`
