---
name: test-run
description: Run the hermit plugin test suites and report pass/fail summary
triggers:
  - /claude-code-hermit:test-run
---

# Test Run

Run both hermit test suites and report a concise pass/fail summary.

## Steps

1. Run the contract tests:
   ```bash
   python3 ${CLAUDE_PLUGIN_ROOT}/tests/run-contracts.py 2>&1
   ```

2. Run the hook tests:
   ```bash
   bash ${CLAUDE_PLUGIN_ROOT}/tests/run-hooks.sh 2>&1
   ```

3. Report results:
   - Show the final result line from each suite (e.g. `Ran N tests — OK` and `=== Results: N passed, 0 failed ===`)
   - If any test failed, show the failing test names and their error output
   - Exit message: `All tests passed.` or `X test(s) failed — see above.`
