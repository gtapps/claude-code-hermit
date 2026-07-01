# claude-code-homeassistant-hermit

A Home Assistant domain layer for `claude-code-hermit`: skills, subagents, a safety hook, and a TypeScript CLI (run by bun) for bulk work.

## Plugin Structure

- `skills/ha-*/` — workflow skills namespaced as `/claude-code-homeassistant-hermit:ha-*`
- `skills/domain-brainstorm/` — on-demand capability-gap brainstorm: reads entity inventory, automation/script listing, and operator intent to surface at most 2 `[prefix]`-tagged improvement proposals. Operator-invoked only. Kill criteria: retire if triage-survival < 25% after ≥8 runs.
- `agents/` — `ha-safety-reviewer`, `ha-automation-builder`, `ha-pattern-analyst`
- `hooks/` — `mcp-safety-gate.ts` + `hooks.json` (PreToolUse on `mcp__homeassistant__.*` — the whole server namespace; read-only tools are allow-listed inside the gate)
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

- **Home Assistant MCP Server** (`homeassistant`): read-only live ops by default — `GetLiveContext`, `GetDateTime`. `Hass*` intent tools (`HassTurnOn`, `HassLightSet`, `HassSetPosition`, `HassFanSetSpeed`, etc.) are hard-blocked unless `ha_assist_control_enabled: true` is set in `config.json` (set during hatch Step 7.55). When enabled, HA's own expose-to-Assist gate is the control boundary — the gate defers to it rather than blocking.
- **CLI** (`bin/ha-agent-lab`): build and analysis operations — context refresh, YAML simulation, policy checks, apply, audits, structural writes (helpers/areas/registries), and `ha trigger-automation`.

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
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha render-template <file|->
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha check-config
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha call-service <domain.service> [--data <json>] [--confirm]
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha set-core-config [--latitude N] [--longitude N] [--elevation N] [--unit-system metric|us_customary] [--currency CODE] [--time-zone TZ] [--country CODE] [--confirm]
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha error-log
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha logbook [--window-days N] [--entity <entity_id>]
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha system-log
# WebSocket-backed structural commands (helpers, areas, registries). Writes are gated by ha_safety_mode.
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha list-helpers [--type <helper_type>]
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha create-helper <type> <json> [--confirm]
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha delete-helper <type> <id> [--confirm]
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha list-areas
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha create-area <name> [--confirm]
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha delete-area <id> [--confirm]
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha rename-area <area_id> --name <name> [--confirm]
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha set-area-icon <area_id> --icon <icon> [--confirm]
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha set-area-floor <area_id> --floor <floor_id> [--confirm]
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha set-area-labels <area_id> --labels <label> [<label> ...] [--confirm]
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha list-floors
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha create-floor <name> [--confirm]
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha delete-floor <id> [--confirm]
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha list-labels
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha create-label <name> [--confirm]
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha delete-label <id> [--confirm]
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha list-entities --registry
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha rename-entity <entity_id> --name <name> [--confirm]
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha set-entity-area <entity_id> --area <area_id> [--confirm]
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha set-entity-enabled <entity_id> --enabled true|false [--confirm]
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha list-devices
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha set-device-area <device_id> --area <area_id> [--confirm]
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha rename-device <device_id> --name <name> [--confirm]
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha list-dashboards
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha get-dashboard [--url-path <url_path>]
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha apply-dashboard <artifact> [--url-path <url_path>] [--confirm]
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha create-dashboard <json> [--confirm]
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha delete-dashboard <dashboard_id> [--confirm]
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha trigger-automation <automation_id>
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab boot status [--probe]
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab boot store --language <locale> --url <url> [--token <token>]
bun test
```

Run `--help` for current flags. Source of truth: `src/cli.ts`.

## HA API gotchas

- REST API docs: https://developers.home-assistant.io/docs/api/rest/
- WebSocket API docs: https://developers.home-assistant.io/docs/api/websocket/

Before changing HA endpoint usage, verify against upstream (WebFetch or the `find-docs` skill) or probe a live instance with `./bin/ha-agent-lab ha probe <path>`. Do not assume an endpoint exists.

- Automations have no bulk REST listing. Enumerate via `/api/states` (filter `domain=automation`), fetch each config via `/api/config/automation/config/{automation_id}`. YAML-packaged automations with a slug `id` (e.g. `accao_boa_noite_via_notificacao`) carry an `id` in their state attributes and are REST-retrievable via that slug — the `/api/states`+id approach covers 100% in practice. `config/automation/list` WebSocket command returns "Unknown command" on real HA instances — do not rely on it.
- `POST /api/config/{automation|script}/config/{id}` — create/update (upsert). URL `id` is sufficient; body `id` field is ignored by HA. Returns `{"result":"ok"}` on success. Returns 403 if HA is in YAML config mode (REST config API unavailable).
- `DELETE /api/config/{automation|script}/config/{id}` — remove config. **A missing id returns 400** (not 404) with `{"message":"Resource not found"}` — do not special-case 404. All HA error responses carry `{"message":"..."}` — surface it verbatim.
- After `POST`, `GET` reflects the change synchronously (verified against HA 2026.x). No retry or delay needed for verify calls.
- `--reload {automation|script|scene}` in `ha validate-apply` is overloaded: it controls both the REST push endpoint and the reload service call. There is no push-only mode; add `--no-reload` if that use case arises. Scenes use the same REST config API (`/api/config/scene/config/{id}`) and `scene.reload` service as automation/script — no special path.
- `POST /api/template` returns the rendered template as a **raw plain-text body**, not JSON (confirmed against HA core source and live) — `client.post()`'s unconditional `JSON.parse` would throw `Malformed JSON` on any non-JSON-looking render (e.g. `idle`). `GET /api/error_log` is the same: HA serves the raw log file, not JSON. Use `client.postText()`/`client.getText()` (raw-response variants) for endpoints like these.
- **`ha call-service` is gated per-entity/service (`gateServiceCall` in `policy.ts`), not by the structural gate.** Sensitive domains (lock/alarm) or entity/device/target references block as a proposal under strict, need `--confirm` under ask; non-sensitive calls proceed in both modes since call-service exists for maintenance (reloads, `recorder.purge`, `notify.*`). Reuses the same fail-closed entity-extraction logic as the MCP safety hook (`extractEntityIds`/`hasUnresolvableTarget`/`isWellFormedEntityId`, relocated to `policy.ts`) plus a `call-service`-only `hasMalformedTargetShape` guard for wrong-shaped `--data` (target as an array, non-string entity_id) that the shared extractors can't see. When touching this gate, keep `tests/gate-corpus.test.ts`/`tests/gate-fuzz.test.ts` green — they pin the MCP hook's byte-identical output.
- **`GET /api/error_log` 404s unless HA registered `DATA_LOGGING`** (HA core only wires up the view `if DATA_LOGGING in hass.data`) — a deployment characteristic, not a bug; the command surfaces the 404 verbatim. Confirmed 404 on paulinho (2026.6.4); `ha logbook`/`ha system-log` don't have this dependency and work on the same instance.
- `GET /api/logbook/<timestamp>` only supports filtering by **one** entity via `?entity=<id>` (not comma-separated or glob, unlike `filter_entity_id` on `/api/history/period/`) — `ha logbook --entity` is singular for this reason.

### WebSocket commands (`src/ha-ws.ts` + `src/structure.ts`)

- Helpers, areas, and entity/device registries have **no REST endpoint** — they are reachable only over `wss://<host>/api/websocket`. `HomeAssistantWsClient` opens a single-shot connection per CLI invocation (auth handshake → commands → close), reusing the same URL selection and token as the REST client.
- Command types: helpers `<type>/create|list|delete` (8 types: `input_boolean|input_number|input_text|input_select|input_datetime|timer|counter|schedule`); areas `config/area_registry/create|list|delete`; registries `config/entity_registry/list|update` and `config/device_registry/list|update`; dashboards `lovelace/dashboards/list|create|delete`, `lovelace/config`, `lovelace/config/save` (shapes cross-checked against `home-assistant/core`'s `DictStorageCollectionWebsocket` generic collection handler — the same pattern as areas/helpers).
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
