
---
<!-- claude-code-homeassistant-hermit: Home Assistant Workflow -->

## Home Assistant Workflow

### Core Rules

- `/claude-code-homeassistant-hermit:ha-boot` is the single entry point — starts the hermit session and checks HA connectivity.
- Never commit real HA URLs, tokens, or device inventories.
- Actuation of sensitive domains (`lock`, `alarm_control_panel`, security-related `cover`/`button`/`switch`) and structural writes (helpers/areas/registries) are gated by `ha_safety_mode` (the `mcp-safety-gate` hook and the CLI both enforce it). Unresolvable or malformed targets hard-block in **both** modes; for a concrete sensitive target, `strict` blocks and `ask` uses native approval (CLI writes retain `--confirm`). Show the preview, then invoke for native approval without another chat confirmation. A block means the policy fired: surface it as a proposal, don't route around it.
- Uncertain entities default to sensitive.
- Explicit operator approval is required before applying automations or modifying safety policy.
- Use the stored language from `.claude-code-hermit/OPERATOR.md` (`## HA hermit` section) for all user-facing output.

HA skills and subagents self-advertise through their own SKILL.md / agent descriptions — no catalog is kept here. Entry point: `/claude-code-homeassistant-hermit:ha-boot`.

### Channel Command Routing

House imperatives arriving on a channel → HA Assist intent tools (`HassTurnOn`, `HassLightSet`, …) via MCP, which requires `ha_assist_control_enabled` and the device exposed in HA. House state questions → `/claude-code-homeassistant-hermit:ha-house-status`.

### MCP vs CLI

- **MCP (`homeassistant`, tool IDs `mcp__homeassistant__*`)**: read-only by default (`GetLiveContext`, `GetDateTime`). With `ha_assist_control_enabled: true`, HA Assist intent tools are allowed and HA's own expose-to-Assist setting becomes the control boundary.
- **CLI** (`${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab <domain> <command>`): build and analysis work — context refresh, simulation, policy checks, apply, audits, structural writes, `ha trigger-automation`. Full command catalog: `ha-agent-lab --help`.

### HA Proposal Categories

Use these prefixes in capability-gap proposal titles (from `domain-brainstorm`):
- **[automation-gap]** — a device/sensor/area wired into zero automations
- **[coverage-asymmetry]** — a paired-pattern gap (e.g. `morning_mode` with no `evening_mode`)
- **[unbuilt-intent]** — an operator-stated want with no automation implementing it

Brainstorm ideas are single-pass — the cross-session recurrence condition is waived (consequence + operator-actionable still apply).

### Routines

HA routines (`daily-ha-context`, `morning-brief`, `evening-brief`, `ha-patterns`, `ha-safety-audit`, `ha-integration-health`, `ha-update-check`) are registered by `hatch`. Run `/claude-code-hermit:hermit-routines load` once per interactive session to activate them.

<!-- /claude-code-homeassistant-hermit: Home Assistant Workflow -->
