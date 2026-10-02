---
name: ha-automation-diff
description: Report which Home Assistant automations were added, removed, edited, enabled, or disabled since the last snapshot — change memory across sessions, including UI edits that bypass this plugin. Read-only. Use when the operator asks "what changed", "what moved since last time", or to explain a regression.
allowed-tools:
  - Bash
  - Read
---

# HA Automation Diff

## Purpose

`ha-safety-audit` catches POLICY drift at a point in time. This skill catches CHANGE drift: which automations were added, removed, edited, enabled, or disabled since the last snapshot — including edits made directly in the HA UI that bypass `ha-build-automation`. It gives the hermit a memory of "what moved" between sessions, which is what explains regressions and keeps the estate legible.

It is read-only against Home Assistant: it enumerates automations, hashes each stored config, and diffs against the previous snapshot.

## Steps

1. Run `${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha automation-diff`.
2. The command writes a JSON snapshot to `.hermit/raw/snapshot-ha-automations-latest.json` (the baseline for the next run) and a markdown findings artifact under `.hermit/raw/audit-ha-automation-diff-*`, and prints a stdout findings block.
3. Pass the stdout block through unchanged.

## Output contract

```
ha-automation-diff findings — YYYY-MM-DD
Changes since last snapshot: K
- added: <name> (`<id>`)
- removed: <name> (`<id>`)
- edited: <name> (`<id>`)
- disabled: <name> (`<id>`)
- enabled: <name> (`<id>`)
Untracked (YAML-packaged, config not diffable): M
```

First run (no prior snapshot): `Baseline established. (N automations tracked)`.

No changes: `No changes since last snapshot. (N automations tracked)`.

## Failure modes

- HA unreachable → CLI exits non-zero with an error message. Treat as "skipped, cannot diff"; do not retry automatically.
- YAML-packaged automations have no numeric id and are not REST-retrievable, so their config is not diffable. They are counted under "Untracked" rather than silently dropped — the diff is honest about what it does not cover.
