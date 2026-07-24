# claude-code-fitness-hermit

A fitness/training domain layer for `claude-code-hermit`: skills, subagents, Strava MCP wiring, and routine prompt templates for an autonomous training assistant.

## This Repo is a Plugin

This repo is structured as a Claude Code plugin. It is NOT a standalone project — it gets installed into other projects via:

```
claude plugin marketplace add gtapps/claude-code-hermit
claude plugin install claude-code-fitness-hermit@claude-code-hermit --scope local
```

After install, run `/claude-code-fitness-hermit:hatch` in the target project. The core hermit (`claude-code-hermit` ≥1.0.26) must be installed and hatched first — `hatch` will prompt if it isn't.

## Plugin Structure

- `skills/hatch/` — one-time setup wizard namespaced as `/claude-code-fitness-hermit:hatch`
- `skills/activity-deep-dive/` — per-activity coaching analysis (`/claude-code-fitness-hermit:activity-deep-dive`)
- `skills/capture-activity-rpe/` — auto-triggered RPE capture from channel replies (`/claude-code-fitness-hermit:capture-activity-rpe`)
- `skills/set-rpe/` — manual RPE entry for any activity (`/claude-code-fitness-hermit:set-rpe`)
- `skills/weekly-coaching-patterns/` — scheduled cardiac-drift trend check (`/claude-code-fitness-hermit:weekly-coaching-patterns`)
- `skills/domain-brainstorm/` — on-demand codebase friction brainstorm: reads git churn, last test signal, and README coverage to surface at most 2 `[prefix]`-tagged improvement proposals. Operator-invoked only.
- `agents/strava-data-cruncher.md` — Haiku bulk-aggregation subagent (`@claude-code-fitness-hermit:strava-data-cruncher`)
- `state-templates/compiled/routine-*.md` — four routine prompt files dropped into the consumer's `.claude-code-hermit/compiled/` by `hatch`
- `state-templates/CLAUDE-APPEND.md` — Fitness Workflow block injected into the consumer's `CLAUDE.md` by `hatch`
- `settings.json` — pre-approved permissions for read-class Strava MCP tools and hermit state writes
- `docs/knowledge-schema.md` — fitness work-product types and retention rules
- `.claude-plugin/plugin.json` — plugin manifest
- `.claude-plugin/hermit-meta.json` — hermit-internal fields (`required_core_version`, `requires`)

## Hatch target routing

`/hatch` Step 6 reads `.claude-code-hermit/state/hatch-options.json` (written by core hatch) to determine where to write the CLAUDE-APPEND block: `target = "local"` → `CLAUDE.local.md`; `target = "committed"` → `CLAUDE.md`. If core hatch hasn't run yet, the skill detects `core_install_scope` from `claude plugin list --json`, presents the scope-derived default at position 0 of the Visibility prompt, and stamps the full canonical schema (`target`, `core_install_scope`, `stamped_at`, `stamped_by`, `version`) into `hatch-options.json`.

**Migration on target change.** When the operator flips `hatch_target` (e.g. via core 1.1.1's `hermit-evolve` Upgrade Instructions), the Fitness block can end up stranded in the old file. The most recent CHANGELOG entry's `### Upgrade Instructions` run a one-shot migration via `hermit-evolve` Step 7's sibling upgrade flow to strip the stranded block.

## Core Rules

- Never commit real Strava OAuth credentials — `.env` and `.mcp.json` are gitignored.
- Never call write-class Strava tools: `star-segment`, `connect-strava`, `disconnect-strava`. Blocked by `settings.json`.
- Always call `mcp__strava__check-strava-connection` first in any Strava workflow.
- No persona, no agent name, no sign-off copy. Those belong in the consumer project's `config.json`.
- Agent references in skill instructions must use the full namespaced form (`claude-code-fitness-hermit:strava-data-cruncher`). Bare names will fail at dispatch.

## MCP Server `strava`

The Strava MCP server is registered under the key `strava` in `.mcp.json` (written by `hatch`). Tool IDs follow `mcp__strava__*`. The name `strava` is required — skill instructions and settings matchers use it.

Provided by: `@r-huijts/strava-mcp-server` (via `npx`). No version is pinned; operators can pin in their own `.mcp.json` post-hatch.

## Routines

The four routine prompt files in `state-templates/compiled/` are **not invokable skills** — they are cron-driven prompt files injected via `prompt_file:` entries in `config.json.routines`. The base hermit's `hermit-routines load` command activates them each session.

If you add or modify routine prompts, the corresponding `config.json.routines` entry (registered by `hatch`) must keep the `prompt_file:` path pointing to the right `compiled/routine-*.md` filename.

## Memory Conventions

- `MEMORY.md` (auto-loaded at session start): athlete profile, training preferences, notes.
- `.claude-code-hermit/raw/` — ephemeral Strava data pulls (activity-fetch, activity-streams). Aged out per `knowledge.raw_retention_days`.
- `.claude-code-hermit/compiled/` — durable outputs (weekly plans, weekly summaries, activity notes). Injected at session start within `compiled_budget_chars`.
- `.claude-code-hermit/state/strava-last-activity-id.txt` — rolling cursor written by `strava-sync` routine (also `fitness-brief` evening).
- `.claude-code-hermit/state/strava-weekly-baselines.json` — rolling load baselines written by `weekly-load-review` and read by `monday-planning`.
- `.claude-code-hermit/state/activity-notes.json` — subjective RPE and notes keyed by Strava activity ID. Written by `capture-activity-rpe` and `set-rpe`; read by `activity-deep-dive` and `weekly-load-review`. Retained indefinitely (covers multi-year lookback).
- `.claude-code-hermit/state/strava-pending-rpe.json` — single-record file written by `strava-sync` (or `fitness-brief` evening) after a successful channel send. Holds the latest synced activity for RPE binding. Deleted by `capture-activity-rpe` on capture; freshness-gated (24h) not pruned.

Do NOT create subdirectories inside `.claude-code-hermit/raw/` or `.claude-code-hermit/compiled/`. All artifacts are flat per the base hermit's storage contract (`docs/plugin-hermit-storage.md`).

## Development

Test locally against a target project without publishing:

```
cd /path/to/target-project
claude --plugin-dir /path/to/claude-code-fitness-hermit
```

Then run `/claude-code-fitness-hermit:hatch` in the target.

**Development constraints:**

- The base hermit's deny-patterns hook blocks any Bash command whose argument contains the literal string `TOKEN`. The hatch skill reads `.env` via the `Read` tool — never `cat`/`grep`/`echo`.
- When aligning with a new base hermit version, sweep `skills/`, `agents/`, `state-templates/`, and `docs/` for stale hermit-facing terms. Grep: `grep -rn "stale_term" skills/ agents/ state-templates/ docs/ CLAUDE.md .claude-plugin/`
- Routine entries in `config.json.routines` use the no-leading-slash form: `"claude-code-fitness-hermit:<skill>"`. `boot_skill` in `hermit-meta.json` uses the leading-slash form: `"/claude-code-fitness-hermit:<skill>"`. This plugin currently ships no `boot_skill`.

## Strava API References

- API reference: https://developers.strava.com/docs/reference/
- Rate limits: 100 requests / 15 min, 1000 requests / day. The `strava-data-cruncher` agent caps at 30 calls per invocation.
- OAuth flow: https://developers.strava.com/docs/authentication/

Known gotchas:
- `get-all-activities` is paginated; the MCP server handles this but large histories may hit rate limits.
- `get-activity-streams` requires explicit `keys` (e.g. `heartrate,velocity_smooth,altitude,cadence`). Always specify them.
- HR zone boundaries come from `get-athlete-zones`, not hardcoded thresholds.
