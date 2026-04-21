---
name: ha-analyze-patterns
description: Analyze Home Assistant history data and entity patterns to identify automation opportunities, unused devices, and energy anomalies. Use periodically or when looking for optimization opportunities.
allowed-tools:
  - Bash
  - Read
  - Write
  - Glob
  - Grep
  - mcp__homeassistant__GetLiveContext
  - mcp__homeassistant__GetDateTime
---

# HA Pattern Analysis

## Steps

1. **Load existing analysis**: Read `.claude-code-hermit/raw/snapshot-ha-pattern-analysis-latest.json` if it exists.
2. **Get live context**: Call `GetLiveContext` and `GetDateTime` via MCP for current state.
3. **Read normalized inventory**: Read `.claude-code-hermit/raw/snapshot-ha-normalized-latest.json`.
4. **Analyze patterns**:
   - Devices that are always off or never used
   - Usage patterns by time of day / day of week
   - Energy consumption patterns
   - Entities stuck in unavailable/unknown
   - Automation opportunities based on correlated state changes
5. **Write findings**: Save to `.claude-code-hermit/raw/` as `<timestamp>__snapshot-ha-pattern-analysis.json` and update `snapshot-ha-pattern-analysis-latest.json`.
6. **Update memory**:
   - Update `MEMORY.md` Learned Patterns section with key findings.
   - If findings are extensive, write details to `memory/house-entities.md`.
7. **Emit summary for reflect**: Always output a plain-text findings block to stdout, regardless of how the skill was invoked. Reflect reads this when running the skill as a `plugin_check` and routes actionable items through the proposal pipeline. Use this format:

   ```
   ha-analyze-patterns findings — <date>
   Automation opportunities: <N>
   - <opportunity 1>
   - <opportunity 2>
   Reliability issues: <N>
   - <issue 1>
   Waste patterns: <N>
   - <waste 1>
   No action needed: <list anything normal or already automated>
   ```

   If there are zero findings across all categories, output: `ha-analyze-patterns findings — <date>\nNo actionable findings.`

8. **Propose automations**: If clear patterns emerge, suggest them. For complex ones, delegate to `@ha-automation-builder`.

## What to Look For

- **Time patterns**: lights/devices that follow daily schedules (candidates for time-based automations)
- **Correlation patterns**: events that always happen together (candidates for grouped automations)
- **Waste patterns**: devices left on for long periods, unnecessary power draw
- **Reliability issues**: entities frequently unavailable, integrations that drop
- **Missing automations**: manual actions that could be automated based on triggers

## Output

- `.claude-code-hermit/raw/<timestamp>__snapshot-ha-pattern-analysis.json`
- `.claude-code-hermit/compiled/<timestamp>__pattern-analysis.md` (curated summary, written when non-trivial findings exist)
- Updated `MEMORY.md` Learned Patterns section
