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

1. **Pre-check**: Run `${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha policy-check <artifact_path>` to verify safety.
   - If blocked: stop and explain why. Create a proposal via `/claude-code-hermit:proposal-create`.

2. **Validate and apply**: Run `${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha validate-apply <artifact_path> --reload automation` (or `script`).
   - This runs HA config check, then reloads the domain.

3. **Confirm with operator**: Always ask before executing the apply. Show:
   - The artifact being applied
   - Policy check result
   - What domain will be reloaded

4. **Post-apply**: Read the apply report from `.claude-code-hermit/raw/audit-ha-apply-latest.md`.
   - If successful: update `MEMORY.md` Automation Insights if this is a new pattern.
   - If failed: explain the error and suggest fixes.

## Safety

- The apply path only reloads `automation` and `script` domains.
- Sensitive entities are blocked at the policy-check step.
- The operator must confirm before any reload happens.
