---
name: ha-automation-explorer
description: Browse and explain the Home Assistant automations you already have — list them grouped by topic, filter and explain by keyword, or sort by last-fired. Use when the operator asks "what automations do I have", "what does X do", or which automations are stale.
allowed-tools:
  - Bash
  - Read
  - Glob
  - Grep
---

# HA Automation Explorer

Browse and explain existing automations. Three modes based on `$ARGUMENTS`:

- **Empty** → inventory grouped by topic
- **`--last-fired`** → stale view sorted by last execution
- **`<keyword>`** → filter by name/id and explain matching automations

Use the stored language from OPERATOR.md (`## HA hermit` section) for all user-facing output.

## Steps

1. In parallel: run `${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha list-automations` (on non-zero exit, report the error verbatim and stop) and read `.claude-code-hermit/raw/snapshot-ha-normalized-latest.json`. Extract from the snapshot:
   - `silence_summary.dead_automations` — list of `{entity_id, last_triggered, days_silent, never_fired}` entries
   - `entity_index` — per-entity state map (used by `--last-fired`)

   If the snapshot is missing, tell the operator to run `/claude-code-homeassistant-hermit:ha-refresh-context` first and stop.

2. **Route by mode:**

**Mode 1 — no args (inventory):**

Group automations by topic using `entity_id` and `friendly_name` heuristics. Suggested groups (collapse to "other" if no clear match): security, comfort, presence, energy, lighting, other.

One line per automation:
- Friendly name (or `entity_id` if absent) + enabled/disabled (from `state`: `on`=enabled)
- Mark dead/never-fired by cross-referencing `silence_summary.dead_automations` on `entity_id`. Use a clear visual marker (e.g. `⚠ dead — N days` or `⚠ never fired`). Do not recompute — read directly from the snapshot.

If no automations are returned, say "No automations found on this instance."

**Mode 2 — `<keyword>` (filter + explain):**

Case-insensitive substring match on `entity_id` and `friendly_name` from the `list-automations` output.

If no matches: say "No automations match '<keyword>'." and stop.

For each match with a **non-null `id`**: fetch all configs in parallel, then explain each.

```
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha get-automation-config <id>
```

Produce a plain-language explanation of triggers, conditions, and actions in the stored locale. Keep each explanation concise — one short paragraph or a brief bullet list.

For each match with `id: null` (YAML-packaged automation): note that the config is not retrievable via REST and report the friendly_name and current state only. (YAML-packaged automations have no numeric id — see CLAUDE.md "HA API gotchas".)

**Mode 3 — `--last-fired` (stale view):**

Build a last-fired table from `entity_index` in the snapshot. For each `automation.*` entity, read:
- `entity_index[entity_id].attributes.last_triggered` — ISO timestamp or null
- `entity_index[entity_id].state` — `on`/`off`

Cross-reference `silence_summary.dead_automations` to pick up pre-computed `days_silent` and `never_fired` flags for the dead ones.

Sort ascending by last-fired time (never-fired last). Display a table or list:
- Each row: friendly_name, last triggered (human-readable, stored locale), days since
- Highlight: `never fired` (enabled automations with `last_triggered: null`) and `>30 days` silent

Do **not** call `fetch-history` or use `automation.*` history entries to infer execution — `silence_summary.dead_automations` and `last_triggered` from the snapshot are the sanctioned sources.

If the entity_index contains no automation entries, say "No automation state found in snapshot — try `/claude-code-homeassistant-hermit:ha-refresh-context`."
