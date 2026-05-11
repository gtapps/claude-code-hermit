---
name: ha-import-config
description: Import a live Home Assistant automation or script into the repo as a tracked YAML artifact. Wraps the export CLI with simulate-result interpretation so policy-sensitive imports are distinguished from genuine failures. Use when the operator wants to bring an existing HA-managed automation under the hermit workflow.
allowed-tools:
  - Bash
  - Read
---

# HA Import Config

Pull a live automation or script config out of Home Assistant and into `.claude-code-hermit/raw/` as a YAML artifact the rest of the toolchain understands. Closes the missing read-from-HA direction.

## Inputs

The operator provides:

- `<domain>` — `automation` or `script`
- `<id>` — the config id (not the entity_id; `kitchen_lights`, not `automation.kitchen_lights`)

If the operator doesn't know the id, they can run `${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha list-automations` or `list-scripts` first.

## Steps

1. **Export**: run `${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha export-<domain> <id>`. The CLI writes YAML to `.claude-code-hermit/raw/<domain>-<slug>.yaml` and prints a JSON line with `ok`, `path`, and `message`. If `ok` is false, surface the message verbatim and stop.

2. **Simulate**: run `${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha simulate <path>` against the exported YAML.

3. **Interpret the simulate result** — this is the skill's main value-add. `simulate.py` returns `valid = not blocked_reasons and not missing_entities`, which conflates policy issues and missing-entity issues into the same flag. Distinguish them in the operator-facing report:

   - **`valid: true`** → "Imported clean; safe to edit and re-apply via `/claude-code-homeassistant-hermit:ha-apply-change`."
   - **`valid: false` with non-empty `missing_entities`** → genuine problem. The live config references entity IDs the inventory doesn't know about. Suggest `${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha refresh-context` and a retry. List the missing entities.
   - **`valid: false` with only `blocked_reasons` populated** (no missing entities) → expected for the alarm-bypass class of automations under `strict` mode. Report as: **"Imported successfully; policy-sensitive (would be blocked by current `ha_safety_mode`). This is normal for deliberate carve-outs. If you want to silence audits for this id, add it to `.claude-code-hermit/compiled/acknowledged-violations.md` with `refs=[<entities>]` declared."** Do NOT treat this as an import failure — the YAML is on disk and editable.

4. **Output**: print the YAML path so the operator can open and edit it.

## Failure modes

- HA unreachable → CLI exits non-zero; surface the error and stop.
- Empty or entity-id-shaped id → CLI rejects it with a clear stderr message; surface and stop.
- HA returns 400 ("Resource not found") for unknown ids or YAML-packaged automations (no numeric config id) — surface verbatim.

## Note

This skill is intentionally minimal. It does not list candidates or prompt for selection. If the operator wants to browse, they call `list-automations` / `list-scripts` themselves first. The skill's job is to take a known id, run export + simulate, and interpret the simulate flag correctly — nothing more.
