
---
<!-- claude-code-fitness-hermit: Fitness Workflow -->

## Fitness Workflow

This project has the `claude-code-fitness-hermit` plugin installed. The rules below apply whenever fitness or training work is in scope.

### Core Rules

- Always call `mcp__strava__check-strava-connection` first. If disconnected, stop and alert the operator.
- Never commit real Strava tokens or credentials.
- Never write tokens, credentials, or raw Strava user IDs to session files, proposals, or memory.
- Never call `star-segment`, `connect-strava`, or `disconnect-strava` without explicit operator instruction.
- Use `get-activity-streams` for load/intensity analysis — it's the richest data source.
- HR zone boundaries come from `mcp__strava__get-athlete-zones` — never hardcode numeric thresholds.
- Records, PBs, all-time totals, counts, and cross-block comparisons depend on older activities that context or compaction may drop. Ground them in a full-history Strava query (see the Strava MCP Tools table), or flag the number as unverified and offer to check. Recent-activity questions are fine from live context.

### Skills

| Skill | Purpose |
|-------|---------|
| `/claude-code-fitness-hermit:hatch` | One-time setup — Strava MCP, routines, CLAUDE.md injection |
| `/claude-code-fitness-hermit:activity-deep-dive` | Per-activity coaching analysis (zone breakdown, cardiac drift, recovery estimate) |
| `/claude-code-fitness-hermit:capture-activity-rpe` | Auto-captures RPE from channel replies to strava-sync notifications |
| `/claude-code-fitness-hermit:set-rpe` | Manually record RPE for any activity (backfill, correction, non-latest activities) |
| `/claude-code-fitness-hermit:weekly-coaching-patterns` | Scheduled check — detects upward cardiac-drift trends across recent steady-session activity notes |
| `/claude-code-fitness-hermit:domain-brainstorm` | On-demand brainstorm — surfaces goal-coverage gaps and training imbalances as proposals |

### Subagents

| Agent | Purpose |
|-------|---------|
| `@claude-code-fitness-hermit:strava-data-cruncher` | Bulk Strava data aggregation — weekly load tables, zone distributions (Haiku, cheap) |

### Strava MCP Tools

MCP server `strava` is configured in `.mcp.json` (written by `hatch`). Tool IDs follow `mcp__strava__*`.

| Tool | Use for |
|------|---------|
| `check-strava-connection` | Connectivity check — always call first |
| `get-athlete-profile` | Identity, location, weight, FTP |
| `get-athlete-stats` | Totals: YTD, recent, all-time distance/time/elevation |
| `get-athlete-zones` | HR zones, power zones |
| `get-recent-activities` | Last N activities (default 30) |
| `get-all-activities` | Full history with pagination |
| `get-activity-details` | Full detail on a single activity |
| `get-activity-streams` | Raw time-series: watts, HR, cadence, pace, altitude |
| `get-activity-laps` | Lap splits |
| `list-athlete-routes` | Saved routes |
| `explore-segments` | Find segments near a location |
| `list-starred-segments` | Favourite segments |

### Routines

These run automatically on their cron schedule. Schedules and `enabled` state live in `config.json` → `routines[]` (edit via `/claude-code-hermit:hermit-settings`).

| Routine | Purpose |
|---------|---------|
| `strava-sync` | Detect new activities, log them, flag anomalies |
| `strava-health-check` | Check Strava connectivity; alert if lost |
| `weekly-load-review` | Week-over-week load summary + trend flag |
| `monday-planning` | Weekly training structure suggestion |

Routine prompts are at `.claude-code-hermit/compiled/routine-*.md`.

### Scheduled Checks

These run via the core `scheduled-checks` routine (daily) and fire at most once per `interval_days`. Findings are routed through the proposal pipeline automatically.

| Check | Interval | Purpose |
|-------|----------|---------|
| `weekly-coaching-patterns` | 7 days | Detects upward cardiac-drift trends across recent steady sessions |

### Conventions

- Activity notes: `compiled/activity-<id>-<YYYY-MM-DD>.md` (written by activity-deep-dive)
- Strava state cursor: `state/strava-last-activity-id.txt` (written by strava-sync)
- Weekly load baselines: `state/strava-weekly-baselines.json` (written by weekly-load-review, read by monday-planning)
- Subjective notes: `state/activity-notes.json` (written by capture-activity-rpe + set-rpe, read by activity-deep-dive + weekly-load-review)
- Pending RPE: `state/strava-pending-rpe.json` (written by strava-sync after a successful channel send, read and deleted by capture-activity-rpe)

### Fitness Proposal Categories

Use these prefixes in proposal titles produced by `/claude-code-fitness-hermit:domain-brainstorm`:

- **[goal-gap]** — a stated or inferred goal with no recent supporting data (includes a discipline not logged in N weeks, and untracked sleep/macro dimensions)
- **[imbalance]** — training mix wrong vs stated or inferred goals (cardio/strength ratio skew, same workout repeated with no progression)

Per the core three-condition proposal gate, ideas surfaced by `/claude-code-fitness-hermit:domain-brainstorm` are single-pass — the brainstorm establishes the candidate, so condition (1) (repeated pattern) is waived; conditions 2 and 3 still apply.

<!-- /claude-code-fitness-hermit: Fitness Workflow -->
