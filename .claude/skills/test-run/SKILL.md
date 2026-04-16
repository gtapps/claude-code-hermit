---
name: test-run
description: Run all plugin test suites, report pass/fail summary
disable-model-invocation: true
---
# Test Run

Run all test suites and report a concise summary.

## Plan

### 1. Run all suites

```bash
bash tests/run-all.sh 2>&1
```

Capture the output. Extract pass/fail counts from each suite's summary line.

### 2. Report

Output a concise summary:

```
Hook tests:     X passed, Y failed
Contract tests: X passed, Y failed
Script tests:   X passed, Y failed
Overall:        PASS / FAIL
```

If any test failed, include the failure details below the summary so the developer can act on them immediately.
