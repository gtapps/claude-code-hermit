
---
<!-- claude-code-homeassistant-hermit: Home Assistant Workflow -->

## Home Assistant Workflow

This project has the `claude-code-homeassistant-hermit` plugin installed. The rules below apply whenever HA work is in scope.

### Core Rules

- `/claude-code-homeassistant-hermit:ha-boot` is the single entry point — starts the hermit session and checks HA connectivity.
- Never commit real HA URLs, tokens, or device inventories.
- Actuation of sensitive domains (`lock`, `alarm_control_panel`, security-related `cover`/`button`/`switch`) is gated by `ha_safety_mode` in `.claude-code-hermit/config.json`. Default `strict` = always blocked. `ask` = operator is prompted before actuation (both YAML apply and direct MCP calls). Read the config before deciding whether to draft or block.
- Uncertain entities default to sensitive. Blocked work becomes a proposal.
- Use the stored language from `.claude-code-hermit/OPERATOR.md` (`## HA hermit` section) for all user-facing output.

### Entry Flow

1. `/claude-code-homeassistant-hermit:ha-boot` — starts hermit session + checks HA connectivity, context freshness, locale
2. Work using skills and subagents (below)
3. `/claude-code-hermit:session-close` — archive session with structured report

### Skills

| Skill | Purpose |
|-------|---------|
| `/claude-code-homeassistant-hermit:ha-boot` | Start hermit session + check HA connectivity and context freshness |
| `/claude-code-homeassistant-hermit:ha-refresh-context` | Fetch and normalize full HA state |
| `/claude-code-homeassistant-hermit:ha-build-automation` | Draft automation YAML with validation |
| `/claude-code-homeassistant-hermit:ha-apply-change` | Validate and apply YAML with safety checks |
| `/claude-code-homeassistant-hermit:ha-analyze-patterns` | Identify patterns and automation opportunities |
| `/claude-code-homeassistant-hermit:ha-house-status` | Live house status via MCP |
| `/claude-code-homeassistant-hermit:ha-morning-brief` | Morning brief — live status, overnight anomalies, recommendations |
| `/claude-code-homeassistant-hermit:ha-safety-audit` | Re-audit live automations against the safety policy (weekly scheduled_check) |
| `/claude-code-homeassistant-hermit:ha-integration-health` | Detect dropped integrations via per-domain unavailable ratios (daily scheduled_check) |
| `/claude-code-homeassistant-hermit:ha-delete-config` | Discover and delete an automation/script config from HA |
| `/claude-code-homeassistant-hermit:ha-automation-explorer` | Browse and explain active automations by topic, keyword, or last-fired |
| `/claude-code-homeassistant-hermit:ha-evening-brief` | End-of-day security check: locks, alarm, open covers, device status, energy |
| `/claude-code-homeassistant-hermit:ha-presence-report` | Presence history, tracker health, and arrival/departure diagnostics |
| `/claude-code-homeassistant-hermit:domain-brainstorm` | On-demand capability-gap brainstorm — surfaces missing automations/coverage as proposals (operator-invoked) |

### Subagents

| Agent | Purpose |
|-------|---------|
| `@claude-code-homeassistant-hermit:ha-safety-reviewer` | Review YAML for safety policy compliance (read-only) |
| `@claude-code-homeassistant-hermit:ha-automation-builder` | Build automation YAML in an isolated worktree |
| `@claude-code-homeassistant-hermit:ha-pattern-analyst` | Analyze history data for patterns (haiku, cheap) |

### MCP vs CLI

- **MCP (`homeassistant`)**: live operations — `GetLiveContext`, `GetDateTime`, light/cover/fan control.
- **CLI** (`${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab`): bulk work — context refresh, simulation, policy checks, apply, audits.
- **Safety hook**: MCP actuation tools are gated by `hooks/mcp-safety-gate.ts` before reaching HA.

MCP tool IDs follow `mcp__homeassistant__*`. If you registered the HA MCP Server under a different name, update `hooks/hooks.json` accordingly.

### CLI Commands

```
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha refresh-context [--incremental]
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha simulate <artifact>
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha validate-apply <artifact> [--reload automation|script|scene]
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha policy-check <entity_id_or_yaml>
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha audit-automations
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha audit-scripts
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha list-automations
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha list-scripts
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha delete-automation <id>
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha delete-script <id>
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha get-automation-config <id>
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha get-script-config <id>
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha integration-health
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha fetch-history [--window-days N] [--entities <glob> …] [--include-transitions]
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha probe <path>
# WebSocket structural commands (helpers/areas/registries); writes gated by ha_safety_mode (strict→proposal, ask→--confirm)
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha list-helpers [--type <helper_type>]
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha create-helper <type> <json> [--confirm]
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha delete-helper <type> <id> [--confirm]
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha list-areas
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha create-area <name> [--confirm]
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha delete-area <id> [--confirm]
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha list-entities --registry
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha rename-entity <entity_id> --name <name> [--confirm]
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha set-entity-area <entity_id> --area <area_id> [--confirm]
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha set-entity-enabled <entity_id> --enabled true|false [--confirm]
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha list-devices
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha set-device-area <device_id> --area <area_id> [--confirm]
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha rename-device <device_id> --name <name> [--confirm]
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab boot status [--probe]
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab boot store --language <locale> --url <url> [--token <token>]
```

### Environment

Requires `.env` at the project root (gitignored):

- `HOMEASSISTANT_URL` — your HA URL, local or remote (e.g. `http://homeassistant.local:8123` or a Nabu Casa URL)
- `HOMEASSISTANT_TOKEN` — Long-Lived Access Token (never committed)

**Advanced — roaming laptop (local-preferred with remote fallback):** set both `HOMEASSISTANT_LOCAL_URL` and `HOMEASSISTANT_REMOTE_URL` instead of `HOMEASSISTANT_URL`. The CLI will probe local first and fall back to remote automatically.

### Safety

- Sensitive files: `.env` (token/URL), `hooks/mcp-safety-gate.ts`, `src/policy.ts`.
- MCP actuation tools are blocked by the safety hook before reaching HA.
- Explicit operator approval is required before applying automations or modifying safety policy.

### HA Proposal Categories

Use these prefixes in capability-gap proposal titles (from `domain-brainstorm`):
- **[automation-gap]** — a device/sensor/area wired into zero automations
- **[coverage-asymmetry]** — a paired-pattern gap (e.g. `bom_dia` with no `boa_noite`)
- **[unbuilt-intent]** — an operator-stated want with no automation implementing it

Ideas surfaced by `/claude-code-homeassistant-hermit:domain-brainstorm` are single-pass — the brainstorm establishes the candidate, so the cross-session recurrence condition is waived (consequence + operator-actionable still apply).

### Routines

HA routines (`daily-ha-context`, `morning-brief`, `evening-brief`) are registered by `hatch`. Run `/claude-code-hermit:hermit-routines load` once per interactive session to activate them. In unified mode (chosen at hatch), `morning-brief` subsumes the core `morning` routine and `evening-brief` subsumes the core `evening` routine — both disabled automatically. In legacy mode, `morning-brief` is disabled — flip `enabled: true` in `config.json` once the house profile is confirmed.

<!-- /claude-code-homeassistant-hermit: Home Assistant Workflow -->
