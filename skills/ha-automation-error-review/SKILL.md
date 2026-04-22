---
name: ha-automation-error-review
description: Scan the Home Assistant error log for recurring automation failures. Surfaces any automation that appears in error-flagged log lines three or more times, which typically indicates a silently broken automation. Runs daily as a scheduled check via reflect-scheduled-checks.
allowed-tools:
  - Bash
  - Read
---

# HA Automation Error Review

## Purpose

An automation can stop working silently — a renamed entity, a stale trigger, a missing service — and HA logs the error without surfacing it. This skill reads HA's error log, counts occurrences per automation, and flags ones with recurring hits.

## Steps

1. Run `${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha automation-errors`.
2. The CLI fetches `/api/error_log`, regex-matches `automation.*` references on lines containing error keywords (`error`, `failed`, `timeout`, `could not`, `unable to`), counts hits per automation, and flags any with `>= 3` occurrences.
3. Artifacts are written to `.claude-code-hermit/raw/audit-ha-automation-errors-*`.
4. Pass the stdout findings block through unchanged.

## Output contract

```
ha-automation-errors findings — YYYY-MM-DD
Automations with recurring errors: N
- automation.<id>: <count> error-pattern hits
```

If nothing meets the threshold: `No actionable findings.`

## Tuning

- Default threshold is 3 hits in the current error log. Override with `--min-hits N` for noisier environments.
- Detection is keyword-based, not structured. False positives are possible (an automation name contains the word "error"); recurring false positives should be added to an ignore list in a future iteration.

## Failure modes

- HA unreachable or `/api/error_log` returns empty → `No actionable findings. (0 lines scanned)` — not a problem, just means the log rotated or HA has been quiet.
- CLI exits non-zero only on connection / auth errors. reflect-scheduled-checks should treat those as "skipped."
