---
title: "Routine: Strava Health Check"
type: routine-prompt
created: 2026-04-25T00:00:00+00:00
tags: [routine, strava]
---

# Routine: strava-health-check

Check whether Strava is still connected. Alert operator if disconnected.

## Steps

1. Call `mcp__strava__check-strava-connection`.
2. If **connected**: log one line to SHELL.md Progress Log — `[HH:MM] Strava health check: connected ✓` — and stop. Do not notify the channel.
3. If **disconnected**:
   - Log to SHELL.md Findings: `[YYYY-MM-DD] Strava connection lost — operator action needed. Refresh tokens in .env, then re-run /claude-code-fitness-hermit:hatch to rewrite .mcp.json.`
   - Notify operator via the configured channel: "Strava disconnected. Refresh `STRAVA_ACCESS_TOKEN` / `STRAVA_REFRESH_TOKEN` in `.env`, then run `/claude-code-fitness-hermit:hatch` to rewrite `.mcp.json`."
   - If no channel is configured, the SHELL.md Findings entry above is the sole operator signal — do not skip it.
   - Do not retry or attempt reconnection.
