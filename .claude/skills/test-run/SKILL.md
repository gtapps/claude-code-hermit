---
name: test-run
description: Run plugin test suites in this monorepo and report a concise pass/fail summary. Optional plugin slug arg; without arg, runs all plugins under plugins/.
disable-model-invocation: true
---
# Test Run

Run plugin test suites and report a concise summary. Operates on a single plugin when given a slug; otherwise loops every plugin in `plugins/`.

## Usage

`/test-run` — run tests for every plugin in `plugins/` and report a per-plugin summary plus an overall PASS/FAIL.

`/test-run <plugin-slug>` — run tests for just that plugin.

Examples:
- `/test-run claude-code-hermit`
- `/test-run claude-code-homeassistant-hermit`

## Steps

### 0. Resolve target slugs

- If a slug arg was passed, validate `plugins/<slug>/.claude-plugin/plugin.json` exists. If not, abort with: `Plugin 'plugins/<slug>/' not found. Available: <comma-separated slugs>.`
- If no slug, glob `plugins/*/.claude-plugin/plugin.json` and collect the directory names. Run tests for each in sequence.

### 1. Run each suite (per slug)

Plugins ship one of two test conventions. Detect and dispatch:

- **Bash entrypoint** — if `plugins/<slug>/tests/run-all.sh` exists (dev/fitness/scribe/forge convention):
  ```bash
  bash plugins/<slug>/tests/run-all.sh 2>&1
  ```
- **Bun entrypoint** — else if any `plugins/<slug>/tests/*.test.ts` exists (core/HA convention): `cd plugins/<slug> && bun test 2>&1`.
- **Neither marker** — mark `no tests configured` and continue.

Capture full output. Extract pass/fail counts from each suite's summary line.

### 2. Report

Per-plugin block:

```
=== <slug> ===
Hook tests:     X passed, Y failed         (bash convention only)
Contract tests: X passed, Y failed         (bash convention only)
Script tests:   X passed, Y failed         (bash convention only)
Bun tests:      X passed, Y failed         (bun convention only)
Plugin result:  PASS / FAIL / SKIP
```

Final overall line:

```
Overall: PASS / FAIL  (<n> passed, <m> failed, <k> skipped across <p> plugins)
```

If any test failed, include the failure details below the summary so the developer can act on them immediately.
