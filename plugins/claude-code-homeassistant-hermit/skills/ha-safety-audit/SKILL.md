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
2. The CLI writes JSON + markdown artifacts under `.claude-code-hermit/raw/audit-ha-safety-*` and prints a stdout findings block. The stdout block is already filtered against `.claude-code-hermit/compiled/acknowledged-violations.md` (if present); acknowledged automations are silent in stdout but recorded in the JSON sidecar's `acknowledged[]` array for audit-trail purposes.
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

**Acknowledged suppression**: items listed in `.claude-code-hermit/compiled/acknowledged-violations.md` (operator-curated, see `state-templates/compiled/acknowledged-violations.md` for the format) are filtered from stdout before the count is computed. `Policy violations: N` is the post-filter count. The full unfiltered audit trail lives in `raw/audit-ha-safety-latest.json` under `acknowledged[]`. The suppression uses a subset check on per-id `refs=[...]` declared in the file — if an acknowledged automation later touches a NEW sensitive ref, it re-surfaces.

## Failure modes

- HA unreachable → CLI exits non-zero with an error message. Treat that as "skipped, cannot audit" in reflect-scheduled-checks context; do not retry automatically.
- No automations configured → `No actionable findings. (0 automations scanned)` — not an error.
