---
name: ha-morning-brief
description: Morning house brief — live status, overnight anomalies, energy snapshot, pending proposals, and today's priorities. Runs as a daily routine or on demand.
allowed-tools:
  - Read
  - Glob
  - Grep
  - Bash
  - mcp__homeassistant__GetLiveContext
  - mcp__homeassistant__GetDateTime
---

# HA Morning Brief

A house-focused morning brief that combines live HA state with hermit session context. Designed to run as the `morning` routine at start of day.

## Delivery Guard

Before doing any work, read `.claude-code-hermit/state/runtime.json` if it exists.

- If `session_state` is `waiting`: the operator is absent. Check `config.json` for a configured notification channel.
  - Channel present → proceed, notify the operator via the configured channel.
  - No channel → suppress entirely (log `morning-brief skipped: session_state=waiting, no channel` to SHELL.md Monitoring and exit).
- Otherwise: proceed normally.

## Steps

1. **Time & context** — Call `GetDateTime` for current time. Read `.claude-code-hermit/OPERATOR.md` for priorities and language preferences.

2. **Live house snapshot** — Call `GetLiveContext`. Extract and organize:
   - Presence (who is home/away)
   - Lights still on (unexpected at morning time?)
   - Cover/blind positions
   - Climate: indoor temps, HVAC mode
   - Any devices unavailable or in error state
   - Security: alarm state (read-only)

3. **Energy snapshot** — From the live context, pull current power draw and any energy sensors. Compare with known baselines from memory if available. Flag anything unusual (e.g., high overnight consumption).

4. **Context freshness** — Check `.claude-code-hermit/raw/snapshot-ha-context-latest.json` modification time. If older than 24h, note it as stale.

5. **Overnight activity** — Read `.claude-code-hermit/sessions/SHELL.md`. Scan both the **Monitoring** section and the **Findings** section (last 20 lines combined). In newborn-phase hermits (< 3 days old), pattern observations land in Findings as `Noticed: <pattern>` entries — include those. Surface any alerts or notable patterns found overnight.

6. **Cost-spike check** — Read `.claude-code-hermit/state/reflection-state.json` if it exists. Look for any `cost_spike` entry with a timestamp within the last 24 hours. If found, include a "Cost alert" bullet in the brief with the flagged amount.

7. **Pending work** — Scan for:
   - `Glob` for `.claude-code-hermit/proposals/PROP-*.md` — read status from each, list any `pending` proposals
   - Check if `.claude-code-hermit/sessions/NEXT-TASK.md` exists (queued task)
   - Read `.claude-code-hermit/cost-summary.md` if it exists — include yesterday's cost

8. **Compose brief** — Write a concise morning brief in the operator's language (from OPERATOR.md preferences). Use the format below.

9. **Write to `compiled/`** — Write the composed brief to `.claude-code-hermit/compiled/brief-morning-<YYYY-MM-DD>.md` with frontmatter:
   ```yaml
   title: "Morning Brief — <YYYY-MM-DD>"
   type: brief
   created: <ISO8601>
   session: <session_id from runtime.json, or null if absent>
   tags: [morning-brief, ha]
   ```
   Then append the following line to `.claude-code-hermit/sessions/SHELL.md` under a `### Artifacts produced this session` subsection in `## Monitoring` (create the subsection if absent):
   ```
   - [[compiled/brief-morning-<YYYY-MM-DD>]]
   ```
   This citation is lifted into `## Artifacts` when `/claude-code-hermit:session-close` archives the session.

## Output Format

```
Bom dia! Casa - [date]

Estado actual:
- [presence, lights, climate, covers - concise bullets]

Energia:
- [current draw, overnight highlights]

Alertas:
- [devices offline, unusual states, or "Tudo normal"]

Pendente:
- [proposals, queued tasks, or "Nada pendente"]

Custo:
- [yesterday's cost if available; cost-spike alert if flagged by reflect]

Prioridades hoje:
- [from OPERATOR.md Current Priority, filtered to actionable items]
```

Adapt the greeting and section headers to the operator's configured language. Keep the entire brief under 25 lines.

## Delivery

- If invoked as a routine and `session_state` is `waiting` with a channel configured: notify the operator via that channel only.
- Otherwise: output to terminal.
- Never include secrets, tokens, or internal file paths in the brief.
