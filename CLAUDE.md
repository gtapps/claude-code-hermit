# claude-code-homeassistant-hermit

A Home Assistant domain layer for `claude-code-hermit`: skills, subagents, a safety hook, and a Python CLI for bulk work.

## This Repo is a Plugin

This repo is structured as a Claude Code plugin. It is NOT a standalone project — it gets installed into other projects via:

```
claude plugin marketplace add gtapps/claude-code-homeassistant-hermit
claude plugin install claude-code-homeassistant-hermit@claude-code-homeassistant-hermit --scope project
```

After install, run `/claude-code-homeassistant-hermit:hatch` in the target project. The core hermit (`claude-code-hermit`) must be installed and hatched first — `hatch` will prompt if it isn't.

## Plugin Structure

- `skills/ha-*/` — HA workflow skills namespaced as `/claude-code-homeassistant-hermit:ha-*`
- `agents/ha-*.md` — HA subagents (`ha-safety-reviewer`, `ha-automation-builder`, `ha-pattern-analyst`)
- `hooks/` — `mcp-safety-gate.py` + `hooks.json` (PreToolUse on `mcp__homeassistant__Hass.*`)
- `bin/ha-agent-lab` — Python CLI launcher (resolves `.venv` automatically)
- `src/ha_agent_lab/` — Python package (REST client, policy engine, simulation, apply)
- `settings.json` — pre-approved permissions for safe CLI and read-only MCP tools
- `state-templates/CLAUDE-APPEND.md` — block injected into the target project's `CLAUDE.md` by `hatch`
- `tests/` — hook and policy tests
- `.claude-plugin/plugin.json` — plugin manifest (`requires: claude-code-hermit >= 1.0.13`)

## Core Rules

- `/claude-code-homeassistant-hermit:ha-boot` is the single entry point — starts the hermit session and checks HA connectivity.
- Never commit real HA URLs, tokens, or device inventories.
- Never autonomously actuate sensitive domains: `lock`, `alarm_control_panel`, security-related `cover`/`button`/`switch`.
- Uncertain entities default to sensitive. Blocked work becomes a proposal.
- Use the stored language from `MEMORY.md` for all user-facing output.
- Prefer the Python CLI over ad-hoc reasoning when a helper exists.

## MCP vs Python

- **Home Assistant MCP Server** (`homeassistant`): live ops — `GetLiveContext`, `GetDateTime`, light/cover/fan control. Gated by `hooks/mcp-safety-gate.py`.
- **Python CLI** (`bin/ha-agent-lab`): bulk work — context refresh, YAML simulation, policy checks, apply, audits.

MCP tool IDs follow the pattern `mcp__homeassistant__*`. The `homeassistant` name is required — the safety hook matches on it.

## CLI Commands

```
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha refresh-context [--incremental]
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha simulate <artifact>
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha validate-apply <artifact> [--reload automation|script]
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha policy-check <entity_id_or_yaml>
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha audit-automations
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha automation-errors [--min-hits N]
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab boot status [--probe]
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab boot store --language <locale> --url <url> [--token <token>]
.venv/bin/pytest tests/ -v
```

## Routines and Plugin Checks

`hatch` registers entries in `.claude-code-hermit/config.json`:

- **Routines**: `daily-ha-context` (08:30 daily, enabled), `morning-brief` (09:00 daily, disabled until the operator confirms the house profile).
- **Plugin checks** (reflect-driven, proposal-producing): `ha-patterns` (weekly), `ha-safety-audit` (weekly), `ha-integration-health` (daily), `ha-automation-errors` (daily).

In interactive sessions, run `/claude-code-hermit:hermit-routines load` once to activate scheduled routines. In always-on deployments they load automatically.

## Memory Conventions

- `MEMORY.md` (auto-loaded, max 200 lines): language, house profile, learned patterns, known issues.
- `memory/*.md`: detailed topic files (entities, automation history).
- `.claude-code-hermit/raw/` — HA context snapshots, normalized data, audits, staged automation YAML.
- `.claude-code-hermit/compiled/` — durable domain outputs injected at session start.
- `.claude-code-hermit/sessions/S-*-REPORT.md` — archived session reports.

## Development

Test locally against a target project without installing:

```
cd /path/to/target-project
claude --plugin-dir /path/to/claude-code-homeassistant-hermit
```

Then run `/claude-code-homeassistant-hermit:hatch` in the target.

Run tests:

```
.venv/bin/pytest tests/ -v
```

**Development constraints:**

- Python deps (`PyYAML`, `python-dotenv`) are installed into a project-local `.venv` by `hatch`. Do not assume system Python has them.
- The safety hook fails closed — if an MCP call's target cannot be resolved to concrete entity IDs, it is blocked.
- The deny-pattern hook blocks Bash commands whose arguments contain the literal string `TOKEN`. Read credentials via the CLI (`bin/ha-agent-lab boot status`) or via `dotenv`, never `cat .env` / `echo $HOMEASSISTANT_TOKEN`.
- Agent references in skill instructions must use the full namespaced form (e.g., `claude-code-homeassistant-hermit:ha-safety-reviewer`). Bare names will fail at dispatch.
