---
name: ha-apply-change
description: Validate and apply a generated HA automation or script YAML with safety checks and optional reload. Use after building or modifying an automation.
allowed-tools:
  - Bash
  - Read
  - Write
---

# Apply HA Change

## Steps

1. **Pre-check**: Run `${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha policy-check <artifact_path>` to verify safety. Read the `severity` field in the JSON output:
   - `"block"` (strict mode): stop and explain why. Create a proposal via `/claude-code-hermit:proposal-create`.
   - `"ask"` (ask mode): include the sensitive entities in the confirmation in step 2.
   - `"allow"`: proceed to step 2.

2. **Preview before native approval**: Present the artifact, policy result, affected entities, and reload domain. Invoke step 3 for Claude Code native permission, without another chat confirmation. A changed artifact or target requires a fresh preview and native approval. Denial stops execution.

3. **Validate and apply**: Run `${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha validate-apply <artifact_path> --reload automation` (or `script`).
   - This runs HA config check, **pushes the config to HA via REST**, then reloads the domain.
   - The artifact must include `id:` at the top level — if missing, the CLI derives an ID from the alias or filename and warns in the output. A derived ID drifts if the alias is renamed, creating a duplicate.

4. **Post-apply**: Check the JSON output for `creation_ok` and read `.claude-code-hermit/raw/audit-ha-apply-latest.md`.
   - `creation_ok: true` — config was pushed and verified via REST. Reload picks it up immediately.
   - `creation_ok: false` + message contains "YAML mode" — HA is in YAML config mode (403). Tell the operator to place the generated YAML in their HA config directory and reload manually.
   - `creation_ok: false` + other message — push failed with a validation error from HA. Show the error message and suggest fixing the YAML.
   - If overall successful: update your auto memory if this automation introduces a new pattern.

## Safety

- The apply path only reloads `automation` and `script` domains.
- A `block` policy verdict stops the apply; an `ask` verdict requires approval covering the sensitive entities.
- The operator must confirm before any reload happens.
