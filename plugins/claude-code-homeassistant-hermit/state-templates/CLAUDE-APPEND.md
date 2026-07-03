
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

HA skills and subagents self-advertise through their own SKILL.md / agent descriptions — no catalog is kept here. Entry point: `/claude-code-homeassistant-hermit:ha-boot`.

### Channel Command Routing

When an inbound channel message (Discord/Telegram/voice, handled by
`/claude-code-hermit:channel-responder`) is about the house, route it before the
generic categories:

- **Control utterance** — an imperative naming a device or routine ("turn on the
  living room light", "close the blind", "good morning"): use HA Assist intent
  tools (`HassTurnOn`, `HassLightSet`, etc.) directly via MCP — requires
  `ha_assist_control_enabled: true` in `.claude-code-hermit/config.json` and
  each device exposed in HA (Settings → Voice assistants → Expose).
- **State question** — asks about house state ("what's on?", "is the door
  locked?"): dispatch to `/claude-code-homeassistant-hermit:ha-house-status`.

### MCP vs CLI

- **MCP (`homeassistant`)**: read-only by default (`GetLiveContext`, `GetDateTime`). When `ha_assist_control_enabled: true` is set, HA Assist intent tools (`HassTurnOn`, `HassLightSet`, etc.) are allowed — HA's expose-to-Assist setting is the control boundary.
- **CLI** (`${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab`): build and analysis operations — context refresh, simulation, policy checks, apply, audits, structural writes (helpers/areas/registries), and `ha trigger-automation`.

MCP tool IDs follow `mcp__homeassistant__*`. If you registered the HA MCP Server under a different name, update `hooks/hooks.json` accordingly.

### CLI

`${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab <domain> <command>` — full command catalog: run `ha-agent-lab --help` or see `docs/cli-reference.md` in the plugin (`src/cli.ts` is the source of truth). Structural writes (helpers/areas/registries) are gated by `ha_safety_mode` (strict → proposal, ask → `--confirm`).

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
- **[coverage-asymmetry]** — a paired-pattern gap (e.g. `morning_mode` with no `evening_mode`)
- **[unbuilt-intent]** — an operator-stated want with no automation implementing it

Ideas surfaced by `/claude-code-homeassistant-hermit:domain-brainstorm` are single-pass — the brainstorm establishes the candidate, so the cross-session recurrence condition is waived (consequence + operator-actionable still apply).

### Routines

HA routines (`daily-ha-context`, `morning-brief`, `evening-brief`) are registered by `hatch`. Run `/claude-code-hermit:hermit-routines load` once per interactive session to activate them. In unified mode (chosen at hatch), `morning-brief` subsumes the core `morning` routine and `evening-brief` subsumes the core `evening` routine — both disabled automatically. In legacy mode, `morning-brief` is disabled — flip `enabled: true` in `config.json` once the house profile is confirmed.

<!-- /claude-code-homeassistant-hermit: Home Assistant Workflow -->
