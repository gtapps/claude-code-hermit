# claude-code-homeassistant-hermit

A Home Assistant domain layer for `claude-code-hermit`: skills, subagents, a safety hook, and a TypeScript CLI (run by bun) for bulk work.

## Structure

- `skills/ha-*/`: workflow skills (`/claude-code-homeassistant-hermit:ha-*`); `ha-boot` is the single entry point (starts the hermit session, checks HA connectivity). `skills/domain-brainstorm/` is operator-invoked only.
- `agents/`: `ha-safety-reviewer`, `ha-automation-builder`, `ha-pattern-analyst`
- `hooks/mcp-safety-gate.ts` + `hooks.json`: PreToolUse on `mcp__homeassistant__.*`, the whole server namespace; read-only tools are allow-listed inside the gate
- `bin/ha-agent-lab` + `src/*.ts`: the CLI (REST client, WebSocket client, policy engine, simulation, apply). `src/policy.ts` is shared by the CLI and the hook.
- `settings.json`: pre-approved permissions for safe CLI and read-only MCP tools
- `state-templates/CLAUDE-APPEND.md`: block injected into the target project by `hatch`
- `.claude-plugin/hermit-meta.json`: `required_core_version`, `requires`, `hermit.boot_skill`
- `SAFETY.md`: the safety model; `docs/cli-reference.md`: command usage examples

## Rules

- Never commit real HA URLs, tokens, or device inventories. Check credential state with `bin/ha-agent-lab boot status`, never `cat .env` or `echo $HOMEASSISTANT_TOKEN` (core's seeded rules deny `cat .env*`, and expanding a credential var puts the value in the transcript).
- Actuation of sensitive domains (`lock`, `alarm_control_panel`, security-related `cover`/`button`/`switch`) is gated by `ha_safety_mode` in `.claude-code-hermit/config.json` (absent = `strict`). Under `strict`, never actuate autonomously; blocked work becomes a proposal. Under `ask`, the operator is prompted before any sensitive actuation, YAML apply or direct MCP call alike. Uncertain entities and new domains default to sensitive. Full model: `SAFETY.md`.
- Use the language stored in OPERATOR.md's `## HA hermit` section for all user-facing output. That section is operator-curated config (locale today); auto-memory holds Claude-derived house knowledge.
- Prefer the CLI over ad-hoc reasoning when a helper exists.

## MCP vs CLI

- **MCP server `homeassistant`**: read-only live ops by default (`GetLiveContext`, `GetDateTime`). `Hass*` intent tools (`HassTurnOn`, `HassLightSet`, ...) are hard-blocked unless `ha_assist_control_enabled: true` in `config.json` (set during hatch); when enabled, HA's own expose-to-Assist gate is the control boundary and the hook defers to it. The server name `homeassistant` is required: the hook matches on it.
- **CLI `bin/ha-agent-lab`**: build and analysis operations: context refresh, YAML simulation, policy checks, apply, audits, structural writes (helpers, areas, registries, dashboards), `ha trigger-automation`. Invoke as `${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha <command>`; `--help` and `src/cli.ts` are the command surface, `docs/cli-reference.md` has examples. Writes take `--confirm` and are gated by `ha_safety_mode`.

## HA API gotchas

REST docs: https://developers.home-assistant.io/docs/api/rest/ ; WebSocket docs: https://developers.home-assistant.io/docs/api/websocket/ . Before changing endpoint usage, verify against upstream or probe a live instance with `./bin/ha-agent-lab ha probe <path>`; do not assume an endpoint exists.

- Automations have no bulk REST listing: enumerate via `/api/states` (filter `domain=automation`), then fetch each config from `/api/config/automation/config/{automation_id}`. YAML-packaged automations with a slug `id` carry it in state attributes and are retrievable the same way. The `config/automation/list` WebSocket command returns "Unknown command" on real instances.
- `POST /api/config/{automation|script}/config/{id}` upserts; the URL `id` is what counts, the body `id` is ignored. Returns `{"result":"ok"}`, or 403 when HA is in YAML config mode. `GET` reflects the change synchronously; no retry needed.
- `DELETE .../config/{id}` on a missing id returns 400 (not 404) with `{"message":"Resource not found"}`. All HA error responses carry `{"message":"..."}`; surface it verbatim.
- `--reload {automation|script|scene}` in `ha validate-apply` controls both the REST push endpoint and the reload service call; there is no push-only mode. Scenes use the same REST config API and `scene.reload`.
- `POST /api/template` and `GET /api/error_log` return raw text, not JSON; use `client.postText()`/`client.getText()` in `src/ha-api.ts`. `GET /api/error_log` 404s on deployments where HA never registered `DATA_LOGGING` (a deployment characteristic; the command surfaces the 404 verbatim); `ha logbook`/`ha system-log` have no such dependency.
- `GET /api/logbook/<timestamp>` filters by one entity only (`?entity=<id>`), unlike `filter_entity_id` on `/api/history/period/`; hence `ha logbook --entity` is singular.
- `ha call-service` is gated per entity/service by `gateServiceCall` in `policy.ts`, not by the structural gate: concrete sensitive targets block as a proposal under `strict` and need `--confirm` under `ask`; unresolvable selectors and malformed target shapes hard-block in both modes; non-sensitive maintenance calls (reloads, `recorder.purge`, `notify.*`) proceed. It reuses the hook's fail-closed entity extraction (`extractEntityIds`/`hasUnresolvableTarget`/`isWellFormedEntityId`) plus a `hasMalformedTargetShape` guard for wrong-shaped `--data`.
- The `update` domain has its own carve-out in `gateServiceCall`, independent of `ha_safety_mode` and `SENSITIVE_DOMAINS`: with `ha_update_auto_apply` unset, any `update.*` call is blocked (surface as a proposal); with it `true`, every call still needs `--confirm`. The flag authorizes the class, `--confirm` each instance. A call that also touches a lock/alarm entity still hard-blocks under strict. The Core/OS/Supervisor tier rule lives in `skills/ha-apply-update/SKILL.md`.

### WebSocket commands (`src/ha-ws.ts` + `src/structure.ts`)

- Helpers, areas, and entity/device registries have no REST endpoint; they are reachable only over `wss://<host>/api/websocket`. `HomeAssistantWsClient` opens one connection per CLI invocation (auth handshake, commands, close), reusing the REST client's URL selection and token.
- Command types: helpers `<type>/create|list|delete` (`input_boolean|input_number|input_text|input_select|input_datetime|timer|counter|schedule`); areas `config/area_registry/*`; registries `config/entity_registry/list|update`, `config/device_registry/list|update`; dashboards `lovelace/dashboards/list|create|delete`, `lovelace/config`, `lovelace/config/save`. The docs index documents only the auth/result envelope, so confirm a new command's exact `type` and payload against a live instance.
- All WS mutations are gated by `ha_safety_mode` via `gateStructuralMutation` in `policy.ts`; reads never are. Under `strict` a mutation is refused (`blocked: true`) and surfaced as a proposal; under `ask` it needs `--confirm`, which the main session passes after prompting the operator (the CLI is non-interactive). Every mutation writes an `audit-ha-ws-*` report to `.claude-code-hermit/raw/`.

## Routines

`hatch` registers routines (`daily-ha-context`, `morning-brief`, `evening-brief`; unified vs legacy brief mode is decided at hatch time) and proposal-producing routines (`ha-patterns`, `ha-safety-audit`, `ha-integration-health`, `ha-update-check`, each invoking `reflect --check-id <id> --check <namespaced skill>`) in `.claude-code-hermit/config.json`. Schedules live there, not here. Core's `hermit-routines load` activates them.

## Hatch target routing

Core's `scripts/domain-hatch.ts` owns target resolution and `hatch-options.json`. `/hatch` Step 1 runs `.claude-code-hermit/bin/hermit-run domain-hatch preflight claude-code-homeassistant-hermit`; Step 6 asks the Visibility question only when `needs_target_question` says so, records it with `domain-hatch ensure-target claude-code-homeassistant-hermit --target <choice>`, and writes the block with `domain-hatch sync-block claude-code-homeassistant-hermit`. Hatch appends when the marker is absent and skips otherwise; refreshing the block on a version bump is `hermit-evolve`'s job.

## Development

`claude --plugin-dir /path/to/claude-code-homeassistant-hermit` from a target project, then `/claude-code-homeassistant-hermit:hatch`. Tests: `bun test` from this directory.

- The CLI and both hooks are TypeScript run directly by bun with zero runtime dependencies. Python is test-only: `tests/gate-corpus.test.ts` replays the retired Python hooks from git history and `tests/yaml-parity.test.ts` compares against PyYAML. The suite needs full git history and Python with `python-dotenv` and `PyYAML`; set `GATE_PARITY_PYTHON` when that interpreter is outside PATH.
- The safety hook fails closed: an MCP call whose target cannot be resolved to concrete entity IDs is blocked. Changes to `hooks/mcp-safety-gate.ts` or `src/policy.ts` must keep `tests/gate-corpus.test.ts` (golden byte-equivalence with the retired gate) and `tests/gate-fuzz.test.ts` (fail-closed property) green.
