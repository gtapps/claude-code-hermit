
---
<!-- claude-code-fitness-hermit: Fitness Workflow -->

## Fitness Workflow

### Core Rules

- Always call `mcp__strava__check-strava-connection` first. If disconnected, stop and alert the operator.
- Never commit Strava tokens or credentials, and never write tokens, credentials, or raw Strava user IDs to session files, proposals, or memory.
- Per-activity and weekly load analysis goes through `scripts/fitness-lab.ts`: it fetches and reduces the streams so raw time-series never enter context and metrics stay reproducible. The MCP stream/detail tools are for ad-hoc questions only, not the standard load pipeline.
- HR zone boundaries come from `mcp__strava__get-athlete-zones` — never hardcode numeric thresholds.
- Records, PBs, all-time totals, counts, and cross-block comparisons depend on older activities that context or compaction may drop. Ground them in a full-history query — `mcp__strava__get-athlete-stats` is the single authoritative call for all-time/YTD totals (don't sum `get-all-activities` client-side), `mcp__strava__get-all-activities` covers per-activity history — or flag the number as unverified and offer to check. Recent-activity questions are fine from live context.

Fitness skills and subagents self-advertise through their own SKILL.md / agent descriptions — no catalog is kept here. MCP server `strava`, tool IDs `mcp__strava__*`. Entry point: `/claude-code-fitness-hermit:hatch` for setup.

### Routines

Routines `morning-brief`, `evening-brief`, `weekly-load-review`, and `monday-planning` run on their cron schedules; their prompts live at `.claude-code-hermit/compiled/routine-*.md` and their schedules and `enabled` state in `config.json` (edit via `/claude-code-hermit:hermit-settings`). The `weekly-coaching-patterns` routine gates the wake on a reported trend and routes findings through reflection gates into the proposal pipeline.

### Conventions

State and artifact wiring — activity notes, the Strava cursor, weekly load baselines, subjective notes, and the pending-RPE record — is documented in `${CLAUDE_PLUGIN_ROOT}/docs/knowledge-schema.md`.

### Fitness Proposal Categories

Use these prefixes in proposal titles produced by `/claude-code-fitness-hermit:domain-brainstorm`:

- **[goal-gap]** — a stated or inferred goal with no recent supporting data (includes a discipline not logged in N weeks, and untracked sleep/macro dimensions)
- **[imbalance]** — training mix wrong vs stated or inferred goals (cardio/strength ratio skew, same workout repeated with no progression)

Brainstorm ideas are single-pass per the core proposal gate — the recurrence condition is waived.

<!-- /claude-code-fitness-hermit: Fitness Workflow -->
