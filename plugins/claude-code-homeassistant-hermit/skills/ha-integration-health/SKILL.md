---
name: ha-integration-health
description: Detect dropped HA integrations by computing per-domain unavailable-entity ratios from the latest context snapshot. Flags domains where most entities are unavailable, suggesting the integration lost its connection. Runs daily as a scheduled check via reflect-scheduled-checks.
allowed-tools:
  - Bash
---

# HA Integration Health

## Purpose

When an HA integration loses its connection (lost WiFi, API change, expired token), its entities go `unavailable`. This skill reads the latest normalized snapshot, groups entities by domain, and flags domains with a high unavailable ratio.

## Steps

Run the integration-health check via the CLI:

```bash
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha integration-health
```

The CLI:
- Checks that `snapshot-ha-normalized-latest.json` exists and is fresh (< 24h). If stale or missing, runs `ha refresh-context` first to bring it up to date, then proceeds with analysis.
- Groups entities by domain prefix, computes unavailable ratios, and flags domains where `total >= 3` AND `ratio >= 0.5`.
- Writes `.claude-code-hermit/state/integration-health-degraded-domains.json` — a machine-readable state artifact consumed by `ha-analyze-patterns` (via `silence.ts`) to suppress overlapping `long_unavailable` findings.
- Prints the findings block to stdout in the documented format below.

## Output contract

reflect-scheduled-checks routes the findings block through the proposal pipeline. The stdout shape is fixed:

```
ha-integration-health findings — <date>
Degraded domains: N
- <domain>: <unavailable>/<total> entities unavailable (<percent>%)
```

If nothing is flagged: `No actionable findings. (D domains scanned)`.
If snapshot is stale or missing and HA is unreachable: `No actionable findings. (skipped: snapshot stale, refresh failed — <error>)`.
If the snapshot exists but can't be parsed: `No actionable findings. (skipped: snapshot unreadable — <error>)`.

Keep stdout to this shape — no prose, no extra sections.
