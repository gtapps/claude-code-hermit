---
name: ha-morning-brief
description: Morning house brief — live status, overnight anomalies, energy snapshot, pending proposals, and today's priorities. Runs as a daily routine or on demand.
allowed-tools:
  - Bash
  - Read
  - Glob
  - Grep
  - Write
  - mcp__homeassistant__GetLiveContext
  - mcp__homeassistant__GetDateTime
---

# HA Morning Brief

A house-focused morning brief that combines live HA state with hermit session context. Designed to run as the `morning-brief` routine at start of day.

When both `claude-code-hermit` and `claude-code-homeassistant-hermit` are installed and `morning-brief` is enabled, this skill subsumes `/claude-code-hermit:brief --morning` — operators should disable the core `morning` routine to avoid duplicate notifications. For hermits without HA, `/claude-code-hermit:brief --morning` remains the standalone path.

## Delivery Guard

Before doing any work, read `.claude-code-hermit/state/runtime.json` if it exists.

- If `session_state` is `waiting`: the operator is absent. Check `config.json` for a configured notification channel.
  - Channel present → proceed, notify the operator via the configured channel.
  - No channel → suppress entirely (log `morning-brief skipped: session_state=waiting, no channel` to SHELL.md Monitoring and exit).
- Otherwise: proceed normally.

## Steps

1. **Time & context** — Call `GetDateTime` for current time. Read `.claude-code-hermit/OPERATOR.md` for priorities and language preferences.

2. **Fetch overnight history**: Run `${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha fetch-history --window-days 1`. On non-zero exit, log a single line to SHELL.md `## Monitoring` (`history fetch failed: <stderr first line>`) and skip the `Overnight:` section entirely — no fallback wording in the brief. On success, read `.claude-code-hermit/raw/snapshot-ha-history-1d-latest.json`.

3. **Live house snapshot** — Call `GetLiveContext`. Extract and organize:
   - Presence (who is home/away)
   - Lights still on (unexpected at morning time?)
   - Cover/blind positions
   - Climate: indoor temps, HVAC mode
   - Any devices unavailable or in error state
   - Security: alarm state (read-only)

4. **Overnight highlights** (only when 1d history artifact is present): read `.claude-code-hermit/raw/snapshot-ha-normalized-latest.json` for `silence_summary.silent_event_sensors`, then surface 1–3 highlights for the `Overnight:` section using only honest signals:
   - **Top-active entity between 00:00–06:00**: scan `entity_aggregates[*].hour_histogram[0:7]` for the highest sum across all entities. If any non-trivial activity (sum > 0), emit one line — e.g., "`light.kitchen` — 12 state changes between 00:00 and 06:00".
   - **Stuck event sensors**: from `silence_summary.silent_event_sensors`, emit sensors still silent — e.g., "`binary_sensor.motion_corridor` — no events for 14 days".
   - **HVAC duration**: for each `climate.*` entity, read `state_durations` from the history artifact. If `state_durations["heat"]` or `state_durations["cool"]` ≥ 1800 seconds (30 min), emit one line — e.g., "`climate.heat_pump` — heated ~Xh overnight" where X is derived directly from `state_durations`. Never substitute event count for active hours.

5. **Energy snapshot** — From the live context, pull current power draw and any energy sensors. Compare with known baselines from memory if available. Flag anything unusual (e.g., high overnight consumption).

6. **Context freshness** — Check `.claude-code-hermit/raw/snapshot-ha-context-latest.json` modification time. If older than 24h, note it as stale.

7. **Overnight activity** — Read `.claude-code-hermit/sessions/SHELL.md`. Scan both the **Monitoring** section and the **Findings** section (last 20 lines combined). In newborn-phase hermits (< 3 days old), pattern observations land in Findings as `Noticed: <pattern>` entries — include those. Surface any alerts or notable patterns found overnight.

8. **Cost-spike check** — Read `.claude-code-hermit/state/reflection-state.json` if it exists. Look for any `cost_spike` entry with a timestamp within the last 24 hours. If found, include a "Cost alert" bullet in the brief with the flagged amount.

9. **Pending work** — Scan for:
   - `Glob` for `.claude-code-hermit/proposals/PROP-*.md` — read status from each, list any `pending` proposals
   - Check if `.claude-code-hermit/sessions/NEXT-TASK.md` exists (queued task)
   - Read `.claude-code-hermit/cost-summary.md` if it exists — include yesterday's cost

<!-- keep in sync with plugins/claude-code-hermit/skills/brief/SKILL.md — same MP lifecycle protocol -->
9a. **Micro-proposals lifecycle** — Read `.claude-code-hermit/state/micro-proposals.json`. If the `pending` array is non-empty:
   - Each entry with `follow_up_count` of 0: include in `Awaiting decision:` output (see Output Format). Do not mutate.
   - Each entry with `follow_up_count` of 1: include in `Awaiting decision:` with softer framing: "Still waiting on MP-YYYYMMDD-N: [question] (ignore again to drop it)". Increment `follow_up_count` to 2.
   - Each entry with `follow_up_count` >= 2: capture `id` and `question` first, set `status: "expired"`, remove from `pending`. Append to `.claude-code-hermit/state/proposal-metrics.jsonl` using Python (avoids JSON injection from question text). Schema matches core's `append-metrics.js`: `ts`, `type`, `micro_id`, `action`, `question`:
     ```bash
     python3 -c "import json,sys; print(json.dumps({'ts':sys.argv[1],'type':'micro-resolved','micro_id':sys.argv[2],'action':'expired','question':sys.argv[3]}))" "<ISO8601>" "<id>" "<question>" >> .claude-code-hermit/state/proposal-metrics.jsonl
     ```
     (Core's `append-metrics.js` is unreachable from HA's `${CLAUDE_PLUGIN_ROOT}` — write directly.)
   - If `pending` is empty: skip this step entirely.

10. **Compose brief** — Write a concise morning brief in the operator's language (from OPERATOR.md preferences). Use the format below.

11. **Write to `compiled/`** — Write the composed brief to `.claude-code-hermit/compiled/brief-morning-<YYYY-MM-DD>.md` with frontmatter:
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
Good morning! Home - [date]

Current state:
- [presence, lights, climate, covers - concise bullets]

Overnight:
- [top-active entity, stuck sensors, HVAC duration — omit section when history unavailable]

Energy:
- [current draw, notable consumption]

Alerts:
- [devices offline, unusual states, or "All clear"]

Pending:
- [proposals, queued tasks, or "Nothing pending"]

Awaiting decision:
- [follow_up_count 0: "MP-YYYYMMDD-N (tier N): [question] — Reply `MP-YYYYMMDD-N yes` or `MP-YYYYMMDD-N no`"]
- [follow_up_count 1: "Still waiting on MP-YYYYMMDD-N: [question] (ignore again to drop it)"]
- [Omit section entirely when no pending entries (count 0 or 1).]

Cost:
- [yesterday's cost if available; cost-spike alert if flagged by reflect]

Today's priorities:
- [from OPERATOR.md Current Priority, filtered to actionable items]
```

Adapt the greeting and section headers to the operator's configured language. Keep the entire brief under 25 lines — strip lower-priority lines (e.g., Cost when no spike) if the Overnight section pushes over the cap. **`Awaiting decision:` lines are final and non-droppable** — strip from `Energy`, `Cost`, and `Today's priorities` before touching MP lines.

## Delivery

- If invoked as a routine and `session_state` is `waiting` with a channel configured: notify the operator via that channel only.
- Otherwise: output to terminal.
- Never include secrets, tokens, or internal file paths in the brief.
