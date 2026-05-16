---
name: ha-boot
description: Check Home Assistant connectivity, context freshness, and locale. Auto-refresh context if stale. Use at session start or when HA status is unclear.
allowed-tools:
  - Bash
  - Read
  - Glob
  - mcp__homeassistant__GetLiveContext
  - mcp__homeassistant__GetDateTime
---

# HA Boot Check

Run this at the start of every session or when you need to verify HA status.
This skill is the single entry point for this project — it also initializes the hermit session.

## Steps

0. **Steer the hermit**: Invoke `/claude-code-hermit:steer` first to load operator context, run dirty-shutdown recovery if needed, and orient the hermit. If it errors (e.g. core hermit not initialized), stop and tell the operator to run `/claude-code-homeassistant-hermit:hatch`.

1. Run `${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab boot status --probe` and present the result.
2. Read `.claude-code-hermit/OPERATOR.md` for the stored language (in the `## HA hermit` section). All user-facing output should use this locale.
3. Check `.claude-code-hermit/raw/snapshot-ha-normalized-latest.json` modification time.
   - If older than 24 hours or missing, auto-run `${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha refresh-context`.
4. Optionally call `GetLiveContext` via MCP for a quick live snapshot.
5. Present a summary:
   - HA connectivity: ok/failed
   - Context: fresh/stale/missing (age in hours)
   - Language: the stored locale
   - Entity count from last context

## If Something Is Missing

- No `.env` or missing token: tell the operator to copy `.env.example` to `.env` and set `HOMEASSISTANT_TOKEN`.
- No endpoint: tell the operator to set `HOMEASSISTANT_URL` in `.env`.
- No language in OPERATOR.md: ask the operator for their preferred locale.
