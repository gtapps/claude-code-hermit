---
name: ha-evening-brief
description: Evening house brief — end-of-day security check, device status, and energy snapshot. Runs as a daily routine at 22:30 or on demand.
allowed-tools:
  - Bash
  - Read
  - Glob
  - Grep
  - Write
  - mcp__homeassistant__GetLiveContext
  - mcp__homeassistant__GetDateTime
---

# HA Evening Brief

An end-of-day house check that confirms the house is secure before night. Designed to run as the `evening-brief` routine at 22:30.

When both `claude-code-hermit` and `claude-code-homeassistant-hermit` are installed and `evening-brief` is enabled, this skill subsumes `/claude-code-hermit:brief --evening` — operators should disable the core `evening` routine to avoid duplicate ~22:30 notifications. For hermits without HA, `/claude-code-hermit:brief --evening` remains the standalone path.

## Delivery Guard

Before doing any work, read `.claude-code-hermit/state/runtime.json` if it exists.

- If `session_state` is `waiting`: the operator is absent. Check `config.json` for a configured notification channel.
  - Channel present → proceed, notify the operator via the configured channel.
  - No channel → suppress entirely (log `evening-brief skipped: session_state=waiting, no channel` to SHELL.md Monitoring and exit).
- Otherwise: proceed normally.

## Steps

1. **Time & context** — Call `GetDateTime` for current time. Read `.claude-code-hermit/OPERATOR.md` for language preferences.

2. **Live house snapshot** — Call `GetLiveContext`. Extract and organize:
   - Security: alarm state, lock states, open covers/blinds
   - Devices: robovac status (completed / docked / running / error), lights still on
   - Any devices unavailable or in error state

3. **Anomalous sensors** — From the live snapshot, identify currently unavailable, stuck, or unexpected-state sensors. Report only what is currently wrong — no baseline diff required.

4. **Energy snapshot** — From the live context, pull current power draw and day's energy consumption if HA energy entities exist. Omit this section if no energy sensors are available.

5. **Compose brief** — Write a concise evening brief in the operator's language (from OPERATOR.md). Use the format below.

6. **Write to `compiled/`** — Write the composed brief to `.claude-code-hermit/compiled/brief-evening-<YYYY-MM-DD>.md` with frontmatter:
   ```yaml
   title: "Evening Brief — <YYYY-MM-DD>"
   type: brief
   created: <ISO8601>
   session: <session_id from runtime.json, or null if absent>
   tags: [evening-brief, ha]
   ```
   Then append the following line to `.claude-code-hermit/sessions/SHELL.md` under a `### Artifacts produced this session` subsection in `## Monitoring` (create the subsection if absent):
   ```
   - [[compiled/brief-evening-<YYYY-MM-DD>]]
   ```
   This citation is lifted into `## Artifacts` when `/claude-code-hermit:session-close` archives the session.

## Output Format

```
Good evening! Home - [date]

Security:
- [alarm state, lock states, open covers — or "All secure"]

Devices:
- [robovac status, lights left on — or "All clear"]

Sensors:
- [currently unavailable or anomalous — or "None"]

Energy:
- [day's consumption, current draw — omit section when unavailable]
```

Keep the entire brief under 10 lines. Adapt the greeting and section headers to the operator's configured language.

## Delivery

- If invoked as a routine and `session_state` is `waiting` with a channel configured: notify the operator via that channel only.
- Otherwise: output to terminal.
- Never include secrets, tokens, or internal file paths in the brief.
