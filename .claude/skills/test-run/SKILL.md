---
name: test-run
description: Run contract and hook test suites, report pass/fail summary
disable-model-invocation: true
---
# Test Run

Run both test suites and report a concise summary.

## Plan

### 1. Run contract tests

```bash
python3 tests/run-contracts.py -v 2>&1
```

Capture the output. Extract pass/fail counts from the summary line.

### 2. Run hook tests

```bash
bash tests/run-hooks.sh 2>&1
```

Capture the output. Extract pass/fail counts from the summary line.

### 3. Report

Output a concise summary:

```
Contract tests: X passed, Y failed
Hook tests:     X passed, Y failed
Overall:        PASS / FAIL
```

If any test failed, include the failure details below the summary so the developer can act on them immediately.
