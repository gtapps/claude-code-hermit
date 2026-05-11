# claude-code-homeassistant-hermit

A Home Assistant domain layer for `claude-code-hermit`: skills, subagents, a safety hook, and a Python CLI for bulk work.

## Plugin Structure

- `skills/ha-*/` — workflow skills namespaced as `/claude-code-homeassistant-hermit:ha-*`
- `agents/` — `ha-safety-reviewer`, `ha-automation-builder`, `ha-pattern-analyst`
- `hooks/` — `mcp-safety-gate.py` + `hooks.json` (PreToolUse on `mcp__homeassistant__Hass.*`)
- `bin/ha-agent-lab` + `src/ha_agent_lab/` — Python CLI (REST client, policy engine, simulation, apply)
- `settings.json` — pre-approved permissions for safe CLI and read-only MCP tools
- `state-templates/CLAUDE-APPEND.md` — block injected into the target project's `CLAUDE.md` by `hatch`
- `.claude-plugin/plugin.json` — plugin manifest
- `.claude-plugin/hermit-meta.json` — hermit-internal fields (`required_core_version`, `requires`, `hermit.boot_skill`)

## Core Rules

- `/claude-code-homeassistant-hermit:ha-boot` is the single entry point — starts the hermit session and checks HA connectivity.
- Never commit real HA URLs, tokens, or device inventories.
- Actuation of sensitive domains (`lock`, `alarm_control_panel`, security-related `cover`/`button`/`switch`) is gated by `ha_safety_mode` in `.claude-code-hermit/config.json` (absent = `strict`). Under `strict` (default): never autonomously actuate — blocked work becomes a proposal. Under `ask`: the operator is prompted before any sensitive actuation (both YAML apply and direct MCP calls). When in doubt about a new domain, default to sensitive. See `SAFETY.md` for the full safety model.
- Uncertain entities default to sensitive. Blocked work becomes a proposal.
- Use the stored language from OPERATOR.md (`## HA hermit` section) for all user-facing output.
- Prefer the Python CLI over ad-hoc reasoning when a helper exists.
- Don't overengineer.

## Memory Conventions

- **Auto memory** (`~/.claude/projects/<key>/memory/`): Claude-derived knowledge — learned patterns, house profile observations, known issues, cross-session suppression signals. Platform-managed; loaded automatically at each session start.
- **`.claude-code-hermit/OPERATOR.md`** — operator-set config (locale today; future room defaults, alert preferences, etc.). Curated by the operator under a `## HA hermit` section. Read by the Python CLI and by skills/agents at session start.
- `.claude-code-hermit/raw/` — HA context snapshots, normalized data, audits, staged automation YAML (ephemeral; aged out by retention).
- `.claude-code-hermit/compiled/` — durable domain outputs (morning briefs, house profile) injected at session start.
- `.claude-code-hermit/state/` — machine state (runtime, reflection, micro-proposals, alert state).
- `.claude-code-hermit/proposals/` — PROP-NNN improvement proposals.
- `.claude-code-hermit/sessions/S-*-REPORT.md` — archived session reports.

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
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha audit-scripts
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha list-automations
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha list-scripts
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha delete-automation <id>
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha delete-script <id>
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha probe <path>
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab boot status [--probe]
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab boot store --language <locale> --url <url> [--token <token>]
.venv/bin/pytest tests/ -v
```

Run `--help` for current flags. Source of truth: `src/ha_agent_lab/cli.py`.

## HA API gotchas

- REST API docs: https://developers.home-assistant.io/docs/api/rest/
- WebSocket API docs: https://developers.home-assistant.io/docs/api/websocket/

Before changing HA endpoint usage, verify against upstream (WebFetch or the `find-docs` skill) or probe a live instance with `./bin/ha-agent-lab ha probe <path>`. Do not assume an endpoint exists.

- Automations have no bulk REST listing. Enumerate via `/api/states` (filter `domain=automation`), fetch each config via `/api/config/automation/config/{automation_id}`. YAML-packaged automations lack a numeric `id` and are not retrievable via REST (use WebSocket `config/automation/list` for full coverage).
- `POST /api/config/{automation|script}/config/{id}` — create/update (upsert). URL `id` is sufficient; body `id` field is ignored by HA. Returns `{"result":"ok"}` on success. Returns 403 if HA is in YAML config mode (REST config API unavailable).
- `DELETE /api/config/{automation|script}/config/{id}` — remove config. **A missing id returns 400** (not 404) with `{"message":"Resource not found"}` — do not special-case 404. All HA error responses carry `{"message":"..."}` — surface it verbatim.
- After `POST`, `GET` reflects the change synchronously (verified against HA 2026.x). No retry or delay needed for verify calls.
- `--reload {automation|script}` in `ha validate-apply` is overloaded: it controls both the REST push endpoint and the reload service call. There is no push-only mode; add `--no-reload` if that use case arises.

## Development constraints

- When aligning with a new hermit version, include `docs/` in terminology sweeps — `docs/knowledge-schema.md` and other doc files carry hermit-facing terms that go stale. Verification: `grep -rn "<old-term>" skills/ agents/ state-templates/ docs/ CLAUDE.md .claude-plugin/`
- Python deps (`PyYAML`, `python-dotenv`) are installed into a project-local `.venv` by `hatch`. Do not assume system Python has them.
- The safety hook fails closed — if an MCP call's target cannot be resolved to concrete entity IDs, it is blocked.
- The deny-pattern hook blocks Bash commands whose arguments contain the literal string `TOKEN`. Read credentials via the CLI (`bin/ha-agent-lab boot status`) or via `dotenv`, never `cat .env` / `echo $HOMEASSISTANT_TOKEN`.
- Agent references in skill instructions must use the full namespaced form (e.g., `claude-code-homeassistant-hermit:ha-safety-reviewer`). Bare names will fail at dispatch.

## Routines and Scheduled Checks

`hatch` registers entries in `.claude-code-hermit/config.json`:

- **Routines**: `daily-ha-context` (08:30 daily, enabled), `morning-brief` (09:00 daily, disabled until the operator confirms the house profile).
- **Scheduled checks** (driven by the core `scheduled-checks` routine via `reflect-scheduled-checks`, proposal-producing): `ha-patterns` (weekly), `ha-safety-audit` (weekly), `ha-integration-health` (daily).

In interactive sessions, run `/claude-code-hermit:hermit-routines load` once to activate scheduled routines. In always-on deployments they load automatically.

## Development

Test locally against a target project without installing:

```
cd /path/to/target-project
claude --plugin-dir /path/to/claude-code-homeassistant-hermit
```

Then run `/claude-code-homeassistant-hermit:hatch` in the target.
