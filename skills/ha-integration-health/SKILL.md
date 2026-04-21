---
name: ha-integration-health
description: Detect dropped HA integrations by computing per-domain unavailable-entity ratios from the latest context snapshot. Flags domains where most entities are unavailable, suggesting the integration lost its connection. Runs daily as a plugin_check via reflect.
allowed-tools:
  - Bash
  - Read
---

# HA Integration Health

## Purpose

When an HA integration loses its connection (lost WiFi, API change, expired token), its entities go `unavailable`. Nobody notices until they try to use one. This skill reads the latest normalized snapshot, groups entities by domain, and flags domains with a high unavailable ratio.

## Steps

1. Check freshness: read the modification time of `.claude-code-hermit/raw/snapshot-ha-normalized-latest.json`. If older than 24 hours or missing, emit:
   ```
   ha-integration-health findings — <date>
   No actionable findings. (skipped: snapshot stale or missing)
   ```
   and stop. The `daily-ha-context` routine keeps the snapshot fresh.

2. Load the snapshot JSON. The `entity_index` field maps `entity_id → state object`. The `unavailable_entities` field lists entity IDs whose state is `unavailable` or `unknown`.

3. Group by domain (the prefix before the first `.`). For each domain compute:
   - `total` = count of entity IDs in `entity_index` with that domain prefix
   - `unavailable` = count of those same IDs present in `unavailable_entities`
   - `ratio` = unavailable / total

4. Flag each domain where **all** are true:
   - `total >= 3` (avoids single-device false positives)
   - `ratio >= 0.5` (half or more unavailable)

5. Emit the findings block:
   ```
   ha-integration-health findings — <date>
   Degraded domains: N
   - <domain>: <unavailable>/<total> entities unavailable (<percent>%)
   ```

   If nothing is flagged: `No actionable findings. (D domains scanned)`.

## Output contract

Reflect routes the findings block through the proposal pipeline. Keep output to the exact shape above — no prose, no extra sections.

## No Python helper

This skill is intentionally pure-skill — it reads an existing artifact and does arithmetic. No CLI command backs it. If the logic grows more complex (e.g., day-over-day drift detection), consider promoting it to a Python helper.
