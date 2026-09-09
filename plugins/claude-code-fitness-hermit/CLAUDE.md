# claude-code-fitness-hermit

A fitness/training domain layer for `claude-code-hermit`: skills, a Strava data subagent, Strava MCP wiring, and routine prompt templates for an autonomous training assistant. A Claude Code plugin, not a standalone project: install from the marketplace (README), then run `/claude-code-fitness-hermit:hatch` in a project where core is already hatched; `hatch` checks the required core version from `.claude-plugin/hermit-meta.json`.

## Structure

- `skills/`: `hatch`, `fitness-brief` (`--morning|--evening|--slot <name>`; owns Strava connectivity, activity sync, RPE binding, and the Run deep-dive), `activity-deep-dive`, `capture-activity-rpe` (auto-triggered from channel replies), `set-rpe`, `weekly-coaching-patterns`, `domain-brainstorm` (operator-invoked only)
- `agents/strava-data-cruncher.md`: Haiku bulk-aggregation subagent; owns the per-invocation API-call cap
- `state-templates/compiled/routine-*.md`: routine prompt files `hatch` drops into the consumer's `compiled/`; `state-templates/CLAUDE-APPEND.md`: the Fitness Workflow block
- `settings.json`: pre-approved permissions for read-class Strava MCP tools and hermit state writes
- `docs/knowledge-schema.md`: work-product types, state-file owners and shapes, retention

## Rules

- Never commit real Strava OAuth credentials; `.env` and `.mcp.json` are gitignored. The hatch skill reads `.env` with the `Read` tool, never `cat`/`grep`/`echo` (`Bash(cat .env*)` is a seeded native deny, and credential values must not land in the transcript).
- The MCP server key is `strava` (written to `.mcp.json` by `hatch`, tool IDs `mcp__strava__*`); skill text and `settings.json` matchers depend on that name. Provided by `@r-huijts/strava-mcp-server` via `npx`, unpinned; operators can pin in their own `.mcp.json`.
- Every Strava workflow calls `mcp__strava__check-strava-connection` first. Write-class tools (`star-segment`, `connect-strava`, `disconnect-strava`) require Claude Code native permission before execution.
- No persona or agent name copy ships here; those come from the consumer's `config.json`.

## Routines and state

The `weekly-coaching-patterns` routine invokes `reflect --check-id weekly-coaching-patterns --check claude-code-fitness-hermit:weekly-coaching-patterns`. Hatch installs its pre-wake gate from `state-templates/bin/fitness-weekly-patterns-gate`.

- The routine prompt files in `state-templates/compiled/` are not invokable skills; `hatch` registers them as `prompt_file:` entries in `config.json.routines` and core's `hermit-routines load` activates them. Renaming a prompt file means updating the registered path.
- Routine entries use the no-leading-slash form `"claude-code-fitness-hermit:<skill>"`; `boot_skill` in `hermit-meta.json` uses the leading-slash form. This plugin ships no `boot_skill`.
- `raw/` holds ephemeral Strava pulls (aged out by `knowledge.raw_retention_days`), `compiled/` durable outputs (weekly plans and summaries, activity notes; injected at session start within `compiled_budget_chars`), `state/` machine files. Both `raw/` and `compiled/` are flat, per core's storage contract. Owners, shapes, and retention of `strava-last-activity-id.txt`, `strava-weekly-baselines.json`, `activity-notes.json` (durable, keyed by Strava activity ID), and `strava-pending-rpe.json` (written by the evening brief only after a confirmed channel send; consumed once by `capture-activity-rpe` within 24h) are in `docs/knowledge-schema.md`.
- `MEMORY.md` (auto-memory) carries the athlete profile, training preferences, and notes.

## Hatch target routing

Core's `scripts/domain-hatch.ts` owns target resolution and `hatch-options.json`. `/hatch` Step 1 runs `.claude-code-hermit/bin/hermit-run domain-hatch preflight claude-code-fitness-hermit`; Step 5 asks the Visibility question only when `needs_target_question` says so, records it with `domain-hatch ensure-target claude-code-fitness-hermit --target <choice>`, and writes the block with `domain-hatch sync-block claude-code-fitness-hermit`.

## Strava API

- Reference: https://developers.strava.com/docs/reference/ ; OAuth: https://developers.strava.com/docs/authentication/
- Rate limits are tight (per 15 minutes and per day; current numbers on the reference page). `strava-data-cruncher` caps calls per invocation for that reason, and `get-all-activities` is paginated, so large histories can hit the limit.
- `get-activity-streams` needs explicit `keys` (e.g. `heartrate,velocity_smooth,altitude,cadence`).
- HR zone boundaries come from `get-athlete-zones`, never hardcoded thresholds.

## Development

`claude --plugin-dir /path/to/claude-code-fitness-hermit` from a target project, then `/claude-code-fitness-hermit:hatch`. Tests: `bash tests/run-all.sh`.

Native approval is the execution checkpoint for existing guarded actions. Preserve previews and validation; do not add a second conversational yes/no step. Static rules live in project permissions.ask; dynamic hooks request permissionDecision: "ask". A denied request must not be retried through another tool or route.

The native-permissions installer owns `.claude-code-hermit/state/claude-code-fitness-hermit-native-permissions-v1.json`, a durable completion marker created after successful installation or migration. Preserve it across upgrades so later operator policy choices are not migrated again.
