---
name: ha-integration-health
description: Detect dropped HA integrations by computing per-domain unavailable-entity ratios from the latest context snapshot. Flags domains where most entities are unavailable, suggesting the integration lost its connection. Runs daily as a scheduled check via reflect-scheduled-checks.
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

5. Emit the findings block. Each flagged domain bullet is followed by a `hint:` line pointing at the most likely cause for that domain (table below). The hint is one line, prefixed `hint:`, no prose around it:
   ```
   ha-integration-health findings — <date>
   Degraded domains: N
   - <domain>: <unavailable>/<total> entities unavailable (<percent>%)
     hint: <domain-specific cause>
   ```

   Domain → hint lookup:

   | Domain(s)                        | Hint                                                                  |
   | -------------------------------- | --------------------------------------------------------------------- |
   | `button`, `switch`, `sensor`     | usually a Zigbee/Z-Wave coordinator drop — check coordinator radio    |
   | `light`                          | check the integration hub (Hue, deCONZ, etc.) and its network         |
   | `camera`, `media_player`         | network or expired credentials                                        |
   | `device_tracker`                 | presence integration (router, GPS app) dropped                        |
   | `binary_sensor`                  | split: BLE proxy or upstream integration                              |
   | _other_                          | check integration page in HA settings                                 |

   If nothing is flagged: `No actionable findings. (D domains scanned)`.

## Output contract

reflect-scheduled-checks routes the findings block through the proposal pipeline. Keep output to the exact shape above — no prose, no extra sections. The `hint:` line per finding is part of the contract.

## No Python helper

This skill is intentionally pure-skill — it reads an existing artifact and does arithmetic. No CLI command backs it. If the logic grows more complex (e.g., day-over-day drift detection), consider promoting it to a Python helper.
