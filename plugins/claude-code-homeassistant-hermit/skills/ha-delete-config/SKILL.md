---
name: ha-delete-config
description: Delete an automation or script from Home Assistant via REST API with operator confirmation. Use when the operator asks to remove, delete, or disable a specific automation or script.
allowed-tools:
  - Bash
  - Read
---

# Delete HA Config

Removes an automation or script from Home Assistant via `DELETE /api/config/{domain}/config/{id}`.

## Steps

1. **Identify the target**: Ask the operator which automation or script to delete (name or ID).
   - If unknown, list options: `${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha list-automations` or `ha list-scripts`.
   - The `id` column is the config ID needed for deletion. The `alias` column shows the friendly name.

2. **Confirm with operator**: Show the target details (entity_id, id, alias, state) and ask for explicit confirmation before proceeding. This action cannot be undone via CLI.

3. **Delete**: Run the appropriate command:
   - `${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha delete-automation <id>` for automations.
   - `${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha delete-script <id>` for scripts.

4. **Check result**: Read the JSON output.
   - `ok: true` — config deleted. The entity stays in the registry until the next reload.
   - `ok: false, message: "Resource not found"` — the ID doesn't exist in HA (note: HA returns 400, not 404).
   - `ok: false` + other message — surface the error to the operator.

5. **Reload (optional)**: After deletion the entity stays in the registry until the next reload. Offer to trigger one:
   - Tell the operator to go to **HA Developer Tools → Services → `automation.reload`** (or `script.reload`).
   - Do **not** use `validate-apply` for this — it would also push the supplied YAML as a new config.

## Safety

- Always confirm with the operator before deleting. Deletion is immediate and removes the config from HA storage.
- Deletion does not check for sensitive entities — the automation is already gone, there is nothing to gate.
- After deletion, the automation will no longer fire. The entity_id remains in the registry until reload.
