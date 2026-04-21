---
name: ha-refresh-context
description: Fetch and normalize the full Home Assistant state into durable artifacts. Use before drafting automations or when context is stale.
allowed-tools:
  - Bash
  - Read
  - Write
  - mcp__homeassistant__GetLiveContext
---

# HA Refresh Context

## Steps

1. Run `${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha refresh-context`.
2. Read the output JSON — note entity count and base_url_source.
3. Read `.claude-code-hermit/raw/snapshot-ha-normalized-latest.json` to understand what's in the house.
4. Compare with the previous entity count (check `MEMORY.md` House Profile section).
5. If new entities, areas, or domains appeared, update `MEMORY.md` House Profile.
6. If entities disappeared or became unavailable, note it in `MEMORY.md` Known Issues.

## Output

- `.claude-code-hermit/raw/snapshot-ha-context-latest.json` — raw HA API snapshot
- `.claude-code-hermit/raw/snapshot-ha-normalized-latest.json` — processed entity/service index
- `.claude-code-hermit/raw/audit-ha-context-refresh-latest.md` — audit entry

## When to Use

- Session start (via ha-boot) when context is stale
- Before building any automation
- After the operator reports changes to their HA setup
- Periodically to detect drift
