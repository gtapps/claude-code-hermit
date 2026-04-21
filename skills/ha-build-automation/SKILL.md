---
name: ha-build-automation
description: Draft a Home Assistant automation or script YAML from a description. Validates against the entity inventory and safety policy. Use when the user wants to create or modify HA automations.
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - mcp__homeassistant__GetLiveContext
  - mcp__homeassistant__GetDateTime
---

# Build HA Automation

## Steps

1. **Gather context**:
   - Read `.claude-code-hermit/raw/snapshot-ha-normalized-latest.json` for available entities and services.
   - Read `MEMORY.md` for stored language — use it for `alias` and `description` fields.
   - Optionally call `GetLiveContext` via MCP for current state.

2. **Draft the YAML**:
   - Use stable, language-neutral IDs (e.g., `kitchen_motion_after_sunset_notification`).
   - Use the stored locale for `alias` and `description`.
   - Set `mode` explicitly where concurrency matters.
   - Write to `.claude-code-hermit/raw/automation-<automation_id>.yaml`.

3. **Validate**:
   - Run `${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha simulate <path>` to check entity references and policy.
   - Run `${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha policy-check <path>` for a safety assessment.

4. **Handle results**:
   - If valid and safe: offer to apply via `/claude-code-homeassistant-hermit:ha-apply-change`.
   - If blocked by policy: explain why and create a proposal using `/claude-code-hermit:proposal-create`.
   - If entities are missing: suggest refreshing context first.

## YAML Conventions

- IDs: `snake_case`, language-neutral, descriptive
- Aliases: stored locale, human-readable
- Descriptions: stored locale, explain the purpose
- Triggers: use `platform:` explicitly
- Actions: use `service:` with full domain (e.g., `light.turn_on`)
- Targets: prefer `entity_id` over area/device when specific

## Safety

Never draft automations that actuate: `lock`, `alarm_control_panel`, or security-related `cover`/`button`/`switch`. If the user requests this, explain the safety boundary and create a proposal for manual review.
