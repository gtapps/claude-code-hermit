---
name: ha-safety-audit
description: Audit all live Home Assistant automations and scripts against the safety policy. Catches policy drift from entities added via the HA UI that bypassed this plugin's safety gate. Runs weekly as a scheduled check via reflect --scheduled-checks.
allowed-tools:
  - Bash
  - Read
---

# HA Safety Audit

## Purpose

The plugin's safety gate only runs when automations are built through `ha-build-automation`. Automations and scripts added directly via the HA UI bypass it. This skill re-audits every live automation and script against the current safety policy and surfaces violations so the operator can review them.

Violations listed in `.claude-code-hermit/compiled/acknowledged-violations.md` (under `automation_ids` or `script_ids`) are suppressed from the actionable findings and reported separately as acknowledged.

## Steps

1. Run `${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha audit-automations`.
2. Run `${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha audit-scripts`.
3. Each command writes JSON + markdown artifacts under `.claude-code-hermit/raw/audit-ha-safety-*` and `.claude-code-hermit/raw/audit-ha-script-safety-*` and prints a stdout findings block.
4. Concatenate the two stdout blocks with a blank separator line and pass the result through unchanged — reflect --scheduled-checks consumes it as the scheduled check output.

## Output contract

Each CLI command prints a block in this shape:

```
ha-safety-audit findings — YYYY-MM-DD
Policy violations: N
- <alias> (`<id>`): <reasons>
No action needed: M automations passed
Acknowledged (suppressed): K
```

Scripts use `ha-script-safety-audit findings — YYYY-MM-DD` as the first line and `scripts` in place of `automations`.

If no violations: `No actionable findings. (N automations scanned)` or `No actionable findings. (N scripts scanned)`.

## Failure modes

- HA unreachable → CLI exits non-zero with an error message. Treat that as "skipped, cannot audit" in reflect --scheduled-checks context; do not retry automatically.
- No automations or scripts configured → `No actionable findings. (0 automations/scripts scanned)` — not an error.
