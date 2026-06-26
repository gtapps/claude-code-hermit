# claude-code-homeassistant-hermit

A Home Assistant domain layer for `claude-code-hermit`: skills, subagents, a safety hook, and a TypeScript CLI (run by bun) for bulk work.

## Plugin Structure

- `skills/ha-*/` — workflow skills namespaced as `/claude-code-homeassistant-hermit:ha-*`
- `skills/domain-brainstorm/` — on-demand capability-gap brainstorm: reads entity inventory, automation/script listing, and operator intent to surface at most 2 `[prefix]`-tagged improvement proposals. Operator-invoked only. Kill criteria: retire if triage-survival < 25% after ≥8 runs.
- `agents/` — `ha-safety-reviewer`, `ha-automation-builder`, `ha-pattern-analyst`
- `hooks/` — `mcp-safety-gate.ts` + `hooks.json` (PreToolUse on `mcp__homeassistant__.*` — all HA MCP tools, incl. script-derived; read-only `GetLiveContext`/`GetDateTime` allowlisted in-gate)
- `bin/ha-agent-lab` + `src/*.ts` — TypeScript CLI run by bun (REST client, policy engine, simulation, apply)
- `settings.json` — pre-approved permissions for safe CLI and read-only MCP tools
- `state-templates/CLAUDE-APPEND.md` — block injected into the target project's `CLAUDE.md` by `hatch`
- `.claude-plugin/plugin.json` — plugin manifest
- `.claude-plugin/hermit-meta.json` — hermit-internal fields (`required_core_version`, `requires`, `hermit.boot_skill`)

## Hatch target routing

`/hatch` Step 7 reads `.claude-code-hermit/state/hatch-options.json` (written by core hatch) to determine where to write the CLAUDE-APPEND block: `target = "local"` → `CLAUDE.local.md`; `target = "committed"` → `CLAUDE.md`. If core hatch hasn't run yet, the skill detects `core_install_scope` from `claude plugin list --json`, presents the scope-derived default at position 0 of the Visibility prompt, and stamps the full canonical schema (`target`, `core_install_scope`, `stamped_at`, `stamped_by`, `version`) into `hatch-options.json`.

**Migration on target change.** When the operator flips `hatch_target` (e.g. via core 1.1.1's `hermit-evolve` Upgrade Instructions), the HA block can end up stranded in the old file. The most recent CHANGELOG entry's `### Upgrade Instructions` run a one-shot migration via `hermit-evolve` Step 7's sibling upgrade flow to strip the stranded block.

## Core Rules

- `/claude-code-homeassistant-hermit:ha-boot` is the single entry point — starts the hermit session and checks HA connectivity.
- Never commit real HA URLs, tokens, or device inventories.
- Actuation of sensitive domains (`lock`, `alarm_control_panel`, security-related `cover`/`button`/`switch`) is gated by `ha_safety_mode` in `.claude-code-hermit/config.json` (absent = `strict`). Under `strict` (default): never autonomously actuate — blocked work becomes a proposal. Under `ask`: the operator is prompted before any sensitive actuation (both YAML apply and direct MCP calls). When in doubt about a new domain, default to sensitive. See `SAFETY.md` for the full safety model.
- Uncertain entities default to sensitive. Blocked work becomes a proposal.
- Use the stored language from OPERATOR.md (`## HA hermit` section) for all user-facing output.
- Prefer the CLI over ad-hoc reasoning when a helper exists.
- Don't overengineer.

## Memory Conventions

- **Auto memory** (`~/.claude/projects/<key>/memory/`): Claude-derived knowledge — learned patterns, house profile observations, known issues, cross-session suppression signals. Platform-managed; loaded automatically at each session start.
- **`.claude-code-hermit/OPERATOR.md`** — operator-set config (locale today; future room defaults, alert preferences, etc.). Curated by the operator under a `## HA hermit` section. Read by the CLI and by skills/agents at session start.
- `.claude-code-hermit/raw/` — HA context snapshots, normalized data, audits, staged automation YAML (ephemeral; aged out by retention).
- `.claude-code-hermit/compiled/` — durable domain outputs (morning briefs, house profile) injected at session start.
- `.claude-code-hermit/state/` — machine state (runtime, reflection, micro-proposals, alert state).
- `.claude-code-hermit/proposals/` — PROP-NNN improvement proposals.
- `.claude-code-hermit/sessions/S-*-REPORT.md` — archived session reports.

## MCP vs CLI

- **Home Assistant MCP Server** (`homeassistant`): live ops — `GetLiveContext`, `GetDateTime`, light/cover/fan control. Gated by `hooks/mcp-safety-gate.ts`.
- **CLI** (`bin/ha-agent-lab`): bulk work — context refresh, YAML simulation, policy checks, apply, audits.

MCP tool IDs follow the pattern `mcp__homeassistant__*`. The `homeassistant` name is required — the safety hook matches on it.

## CLI Commands

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
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha automation-diff
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha snapshot-states [--name <label>] [--domains light,cover,climate,switch] [--entities <id> …]
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha restore-states <artifact> [--confirm]
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha integration-health
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha fetch-history [--window-days N] [--entities <glob> …] [--include-transitions]
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha probe <path>
# WebSocket-backed structural commands (helpers, areas, registries). Writes are gated by ha_safety_mode.
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
bun test
```

Run `--help` for current flags. Source of truth: `src/cli.ts`.

## HA API gotchas

- REST API docs: https://developers.home-assistant.io/docs/api/rest/
- WebSocket API docs: https://developers.home-assistant.io/docs/api/websocket/

Before changing HA endpoint usage, verify against upstream (WebFetch or the `find-docs` skill) or probe a live instance with `./bin/ha-agent-lab ha probe <path>`. Do not assume an endpoint exists.

- Automations have no bulk REST listing. Enumerate via `/api/states` (filter `domain=automation`), fetch each config via `/api/config/automation/config/{automation_id}`. YAML-packaged automations lack a numeric `id` and are not retrievable via REST (use WebSocket `config/automation/list` for full coverage).
- `POST /api/config/{automation|script}/config/{id}` — create/update (upsert). URL `id` is sufficient; body `id` field is ignored by HA. Returns `{"result":"ok"}` on success. Returns 403 if HA is in YAML config mode (REST config API unavailable).
- `DELETE /api/config/{automation|script}/config/{id}` — remove config. **A missing id returns 400** (not 404) with `{"message":"Resource not found"}` — do not special-case 404. All HA error responses carry `{"message":"..."}` — surface it verbatim.
- After `POST`, `GET` reflects the change synchronously (verified against HA 2026.x). No retry or delay needed for verify calls.
- `--reload {automation|script|scene}` in `ha validate-apply` is overloaded: it controls both the REST push endpoint and the reload service call. There is no push-only mode; add `--no-reload` if that use case arises. Scenes use the same REST config API (`/api/config/scene/config/{id}`) and `scene.reload` service as automation/script — no special path.

### WebSocket commands (`src/ha-ws.ts` + `src/structure.ts`)

- Helpers, areas, and entity/device registries have **no REST endpoint** — they are reachable only over `wss://<host>/api/websocket`. `HomeAssistantWsClient` opens a single-shot connection per CLI invocation (auth handshake → commands → close), reusing the same URL selection and token as the REST client.
- Command types: helpers `<type>/create|list|delete` (8 types: `input_boolean|input_number|input_text|input_select|input_datetime|timer|counter|schedule`); areas `config/area_registry/create|list|delete`; registries `config/entity_registry/list|update` and `config/device_registry/list|update`.
- **Confirm the exact command `type` and payload fields against a live instance before relying on them** (the docs index documents only the auth/result envelope). Probe pattern: run the new commands against a real HA and read the responses.
- **All WS mutations are gated by `ha_safety_mode`** (`gateStructuralMutation` in `policy.ts`). Reads are never gated. Under `strict` (default) a mutation is refused (`blocked: true`) — surface it as a proposal. Under `ask` it requires `--confirm`, which the main session passes after prompting the operator (the CLI is non-interactive). Every mutation writes an audit report to `.claude-code-hermit/raw/` (`audit-ha-ws-*`).

## Development constraints

- When aligning with a new hermit version, include `docs/` in terminology sweeps — `docs/knowledge-schema.md` and other doc files carry hermit-facing terms that go stale. Verification: `grep -rn "<old-term>" skills/ agents/ state-templates/ docs/ CLAUDE.md .claude-plugin/`
- The CLI and both hooks are TypeScript run directly by bun (`bun src/cli.ts`, `bun hooks/*.ts`) with zero runtime dependencies — bun is guaranteed by the core hermit requirement. No shipped code runs Python; the only Python in the test suite is a fixture (`tests/gate-corpus.test.ts` replays the retired Python hooks from git history at `42c0c8f~1`, `tests/yaml-parity.test.ts` compares against PyYAML).
- The safety hook fails closed — if an MCP call's target cannot be resolved to concrete entity IDs, it is blocked. Changes to `hooks/mcp-safety-gate.ts` or `src/policy.ts` must keep `tests/gate-corpus.test.ts` (golden byte-equivalence vs the retired Python gate) and `tests/gate-fuzz.test.ts` (fail-closed property) green.
- The deny-pattern hook blocks Bash commands whose arguments contain the literal string `TOKEN`. Read credentials via the CLI (`bin/ha-agent-lab boot status`), never `cat .env` / `echo $HOMEASSISTANT_TOKEN`.
- Agent references in skill instructions must use the full namespaced form (e.g., `claude-code-homeassistant-hermit:ha-safety-reviewer`). Bare names will fail at dispatch.

## Routines and Scheduled Checks

`hatch` registers entries in `.claude-code-hermit/config.json`:

- **Routines**: `daily-ha-context` (08:30 daily, enabled), `morning-brief` (unified mode: 08:30, enabled, replaces core `morning`; legacy mode: 09:00, disabled — determined at hatch time), `evening-brief` (22:30 daily, enabled, run_during_waiting; subsumes core `evening`).
- **Scheduled checks** (driven by the core `scheduled-checks` routine via `reflect-scheduled-checks`, proposal-producing): `ha-patterns` (weekly), `ha-safety-audit` (weekly), `ha-integration-health` (daily).

In interactive sessions, run `/claude-code-hermit:hermit-routines load` once to activate scheduled routines. In always-on deployments they load automatically.

## Development

Test locally against a target project without installing:

```
cd /path/to/target-project
claude --plugin-dir /path/to/claude-code-homeassistant-hermit
```

Then run `/claude-code-homeassistant-hermit:hatch` in the target.
