
---
<!-- claude-code-homeassistant-hermit: Home Assistant Workflow -->

## Home Assistant Workflow

This project has the `claude-code-homeassistant-hermit` plugin installed. The rules below apply whenever HA work is in scope.

### Core Rules

- `/claude-code-homeassistant-hermit:ha-boot` is the single entry point — starts the hermit session and checks HA connectivity.
- Never commit real HA URLs, tokens, or device inventories.
- Never autonomously actuate: `lock`, `alarm_control_panel`, security-related `cover`/`button`/`switch`.
- Uncertain entities default to sensitive. Blocked work becomes a proposal.
- Use the stored language from `MEMORY.md` for all user-facing output.

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
| `/claude-code-homeassistant-hermit:ha-automation-error-review` | Flag automations with recurring errors in HA's log (daily scheduled_check) |

### Subagents

| Agent | Purpose |
|-------|---------|
| `@claude-code-homeassistant-hermit:ha-safety-reviewer` | Review YAML for safety policy compliance (read-only) |
| `@claude-code-homeassistant-hermit:ha-automation-builder` | Build automation YAML in an isolated worktree |
| `@claude-code-homeassistant-hermit:ha-pattern-analyst` | Analyze history data for patterns (haiku, cheap) |

### MCP vs Python

- **MCP (`homeassistant`)**: live operations — `GetLiveContext`, `GetDateTime`, light/cover/fan control.
- **Python CLI** (`${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab`): bulk work — context refresh, simulation, policy checks, apply, audits.
- **Safety hook**: MCP actuation tools are gated by `hooks/mcp-safety-gate.py` before reaching HA.

MCP tool IDs follow `mcp__homeassistant__*`. If you registered the HA MCP Server under a different name, update `hooks/hooks.json` accordingly.

### CLI Commands

```
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha refresh-context [--incremental]
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha simulate <artifact>
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha validate-apply <artifact> [--reload automation|script]
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha policy-check <entity_id_or_yaml>
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha audit-automations
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha automation-errors [--min-hits N]
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab boot status [--probe]
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab boot store --language <locale> --url <url> [--token <token>]
```

### Environment

Requires `.env` at the project root (gitignored):

- `HOMEASSISTANT_URL` — your HA URL, local or remote (e.g. `http://homeassistant.local:8123` or a Nabu Casa URL)
- `HOMEASSISTANT_TOKEN` — Long-Lived Access Token (never committed)

**Advanced — roaming laptop (local-preferred with remote fallback):** set both `HOMEASSISTANT_LOCAL_URL` and `HOMEASSISTANT_REMOTE_URL` instead of `HOMEASSISTANT_URL`. The CLI will probe local first and fall back to remote automatically.

### Safety

- Sensitive files: `.env` (token/URL), `hooks/mcp-safety-gate.py`, `src/ha_agent_lab/policy.py`.
- MCP actuation tools are blocked by the safety hook before reaching HA.
- Explicit operator approval is required before applying automations or modifying safety policy.

### Routines

HA routines (`daily-ha-context`, `morning-brief`) are registered by `hatch`. Run `/claude-code-hermit:hermit-routines load` once per interactive session to activate them. `morning-brief` is disabled by default — flip `enabled: true` in `config.json` once the house profile is confirmed.

<!-- /claude-code-homeassistant-hermit: Home Assistant Workflow -->
