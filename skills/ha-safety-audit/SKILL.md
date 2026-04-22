---
name: ha-safety-audit
description: Audit all live Home Assistant automations against the safety policy. Catches policy drift from automations added via the HA UI that bypassed this plugin's safety gate. Runs weekly as a scheduled check via reflect-scheduled-checks.
allowed-tools:
  - Bash
  - Read
---

# HA Safety Audit

## Purpose

The plugin's safety gate only runs when automations are built through `ha-build-automation`. Automations added directly via the HA UI bypass it. This skill re-audits every live automation against the current safety policy and surfaces violations so the operator can review them.

## Steps

1. Run `${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha audit-automations`.
2. The CLI writes JSON + markdown artifacts under `.claude-code-hermit/raw/audit-ha-safety-*` and prints a stdout findings block.
3. Pass the stdout block through unchanged — reflect-scheduled-checks consumes it as the scheduled check output.

## Output contract

The CLI always prints a block in this shape (reflect-scheduled-checks routes it through the proposal pipeline):

```
ha-safety-audit findings — YYYY-MM-DD
Policy violations: N
- <alias> (`<id>`): <reasons>
No action needed: M automations passed
```

Or, if no violations: `No actionable findings. (N automations scanned)`.

## Failure modes

- HA unreachable → CLI exits non-zero with an error message. Treat that as "skipped, cannot audit" in reflect-scheduled-checks context; do not retry automatically.
- No automations configured → `No actionable findings. (0 automations scanned)` — not an error.
