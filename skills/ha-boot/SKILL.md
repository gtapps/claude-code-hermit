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

0. **Hermit session**: Invoke the `/claude-code-hermit:session-start` skill first to start or resume a hermit session. This ensures session discipline is active before any HA work begins. If it errors (e.g. core hermit not initialized), stop and tell the operator to run `/claude-code-homeassistant-hermit:hatch`.

   After session-start completes, read `.claude-code-hermit/config.json`. If `routines` is present as an array but no entry has `"id": "reflect"`, show a one-line advisory:
   > "No `reflect` routine in config.json — run `/claude-code-hermit:hermit-evolve` to add it (required for hermit ≥ 1.0.13 pattern tracking)."

1. Run `${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab boot status --probe` and present the result.
2. Read `MEMORY.md` for the stored language. All user-facing output should use this locale.
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
- No language in `MEMORY.md`: ask the operator for their preferred locale.
