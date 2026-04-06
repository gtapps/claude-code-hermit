# Upgrading

Hermit is backwards compatible — nothing breaks if you don't upgrade. But upgrading unlocks new features and refreshes templates.

---

## Core Plugin

### 1. Update the plugin

```bash
claude plugin marketplace add gtapps/claude-code-hermit
```

### 2. Run the upgrade skill

Inside Claude Code, in each project that uses the plugin:

```
/claude-code-hermit:hermit-upgrade
```

This detects the version gap, shows what changed, prompts for new settings, refreshes templates, and updates the CLAUDE.md session discipline block.

### 3. What if I don't upgrade?

`hermit-start.py` merges missing config keys from defaults at runtime. Session start shows a soft nudge: "A hermit upgrade is available."

---

## Hermit Plugins

Hermits (e.g., `claude-code-dev-hermit`) upgrade the same way:

```bash
claude plugin marketplace add your-org/claude-code-dev-hermit
```

Then `/claude-code-hermit:hermit-upgrade` — it detects hermit version gaps automatically and updates their CLAUDE-APPEND blocks.

Each hermit's version is tracked independently in `config.json`:

```json
{
  "_hermit_versions": {
    "claude-code-hermit": "0.0.4",
    "claude-code-dev-hermit": "0.0.1"
  }
}
```

### Manual config migrations

Some version upgrades require config.json changes the upgrade skill can't make automatically:

**0.0.2 -> 0.0.3**

`skip_permissions` (boolean) was replaced by `permission_mode` (string):
```json
// Before
"skip_permissions": false

// After
"permission_mode": "acceptEdits"
```

Heartbeat is now enabled by default — if you have `"heartbeat": { "enabled": false, ... }`, set it to `true` to get background monitoring on idle transitions.

**0.0.3 -> 0.0.4**

Pattern detection now reflects on auto-memory instead of scanning archived reports. The 3-report minimum prerequisite is removed — your hermit learns from day one. No manual config migration needed — the upgrade skill handles it.

New config keys (added automatically by upgrade):
- `heartbeat.morning_routine` — daily morning brief (default: `true`)
- `heartbeat.evening_routine` — daily evening summary (default: `true`)
- `heartbeat.idle_agency` — autonomous work during idle (default: `true`)

SHELL.md template changed (Plan section removed in v0.2.0 — plan steps now tracked via native Claude Code Tasks). Existing sessions are unaffected — the template is used for new sessions only.

HEARTBEAT.md template has a new grouped structure. Your custom checklist is preserved — see the new default at `templates/HEARTBEAT.md.template` if you want to adopt the grouping.

---

## Project Customizations

These aren't upgrades — just how your project evolves:

- **OPERATOR.md** — Edit directly or tell your hermit. Keep critical context in the first 50 lines.
- **Custom agents** — Add/modify/remove files in `.claude/agents/`. Live immediately.
- **Custom skills** — Add/modify in `.claude/skills/`. Live immediately.
- **Config** — `/claude-code-hermit:hermit-settings` or edit `config.json` directly.

---

## Upgrading to v0.0.9

### What changed

- **Routines system** — Morning/evening routines moved from LLM heartbeat evaluation to a shell-level watcher. Timing is now deterministic (exact HH:MM) instead of probabilistic (depends on tick landing).
- **Stale session detection** — Heartbeat alerts if an active session has no progress for longer than `stale_threshold` (default: 2h).
- **Skip receipts** — When heartbeat skips are followed by a resume, one summary line is logged instead of silence.
- **Checklist weight guidance** — Self-evaluation warns if HEARTBEAT.md exceeds 10 items.
- **Idle behavior config** — New `idle_behavior` setting (`wait` or `discover`) replaces `heartbeat.idle_agency` boolean. Controls whether the hermit runs idle tasks, reflection, and priority alignment during downtime.

### Automatic migration

Running `/claude-code-hermit:hermit-upgrade` handles:
- `heartbeat.morning_routine` → `routines[{id:"morning",...}]`
- `heartbeat.evening_routine` → `routines[{id:"evening",...}]`
- `heartbeat.idle_agency` → `idle_behavior` (`true` → `"discover"`, `false` → `"wait"`)
- `morning_brief` → `routines[{id:"morning",...}]` (if configured)
- Cleanup of `_last_morning`, `_last_evening` internal keys
- New defaults: `idle_budget`, `heartbeat.stale_threshold`, `routines`

### What you need to do

1. Run `/claude-code-hermit:hermit-upgrade` to migrate config and refresh templates
2. Review migrated routines: `/claude-code-hermit:hermit-settings routines`
3. Optionally set `idle_behavior` to `discover`: `/claude-code-hermit:hermit-settings idle`

---

## Upgrading to v0.3.0

### What changed

- **Alert deduplication** — Heartbeat alerts use semantic keys for dedup, suppress after 5 fires, daily digest, 2-tick resolution. Eliminates alert noise.
- **Self-eval evidence gating** — Items need 20 clean ticks across 3 sessions before a checklist removal proposal.
- **Micro-proposal tier system** — Three tiers: silent (tier 1, reversible/routine), micro-approval via channel (tier 2, meaningful/non-critical), full PROP-NNN (tier 3, safety-critical). Single-slot queue in `state/micro-proposals.json`.
- **Waiting state** — Third session status alongside `in_progress` and `idle`. Configurable `waiting_timeout`.
- **state/ directory** — New runtime observations layer with one-writer-per-file ownership model (alert-state.json, reflection-state.json, routine-queue.json, proposal-metrics.jsonl, micro-proposals.json, state-summary.md).
- **Three-condition proposal rule** — Proposals require: repeated pattern, meaningful consequence, operator-actionable change.
- **Heartbeat default frequency** — Changed from 30m to 2h.
- **Cost tracking moved** — From `## Cost` in SHELL.md to `.status.json`.
- **Routine-watcher queue-not-skip** — Routines during `in_progress` queue to `state/routine-queue.json` instead of silently skipping.
- **Heartbeat restart routine** — Daily 4am routine prevents silent `/loop` expiry in always-on deployments.
- **Evaluate-session nudges** — Detects zombie sessions (48h), stale progress (4h), monitoring bloat (40+ lines).
- **Reflect trigger at task completion** — 4h debounce via `reflection-state.json`.

### Removed

- `.heartbeat-skips` file (replaced by simple "resumed" log line)
- `self_eval_interval` config key (now a constant: 20)
- `heartbeat._last_reflection` config key (migrated to `state/reflection-state.json`)
- `## Cost` section in SHELL.md template (cost data in `.status.json`)

### Automatic migration

Running `/claude-code-hermit:hermit-upgrade` handles:
1. Creates `state/` directory and initializes all state files
2. Migrates `_last_reflection` to state file, removes `self_eval_interval`
3. Updates heartbeat frequency (interactive prompt)
4. Adds `waiting_timeout` to config
5. Removes `## Cost` from SHELL.md (cost data preserved in `.status.json`)
6. Adds `state/` to .gitignore, removes `.heartbeat-skips`
7. Adds `run_during_waiting` to brief routines, adds `heartbeat-restart` routine
8. Backfills `responded` and `self_eval_key` on existing proposals
9. Refreshes templates and CLAUDE-APPEND

### What you need to do

1. Run `/claude-code-hermit:hermit-upgrade`
2. Review the heartbeat frequency prompt — consider accepting 2h (the new default)
3. If using Obsidian, add the Agent Health query from [Obsidian Setup](obsidian-setup.md) to your dashboard

---

## Upgrading to v0.3.1

### What changed

- **Operator notification routing** — Skills say "notify the operator" instead of channel-specific references. Routing is handled by CLAUDE-APPEND.md: conversation in interactive mode, channel `reply` tool in always-on mode.
- **Plugin checks** — Recommended plugins invoked automatically. Two triggers: `interval` (periodic during idle reflection) and `session` (at task completion). New `plugin_checks` config array.
- **Skill-creator integration in proposal-act** — Proposals with `## Skill Improvement` sections route through `/skill-creator` when available.
- **Plugin check interval proposals** — Auto-adjust intervals based on consecutive empty/actionable runs.
- **Heartbeat alert response** — Returns `HEARTBEAT_ALERT` instead of full alert content. Conservative NEXT-TASK.md pickup notifies operator and sets status to `waiting`.
- **Hatch wizard Phase 4** — Writes `plugin_checks` for accepted plugins.
- **Docker-setup** — Also writes `plugin_checks` entries.
- **Security: entrypoint no longer mutates config.json** — The `bypassPermissions` write was removed. `hermit-start.py` already handles this via `--dangerously-skip-permissions` CLI flag. Previously, one Docker boot silently changed the persisted project config on the host bind mount.
- **Security: bridge networking by default** — Docker compose template no longer hardcodes `network_mode: host`. Bridge is now the default; host networking requires explicit opt-in during `docker-setup`.
- **Security: no auto-updates on boot** — Plugin update calls removed from the entrypoint. Auto-updates pulled unreviewed code that ran with `bypassPermissions`. Update explicitly via `/claude-code-hermit:hermit-upgrade` or image rebuild.
- **Security: full deny pattern set** — `docker-setup` and `hatch` now generate the complete deny set from `docs/SECURITY.md` (25 patterns for Docker, 22 for hatch hardened, 17 for hatch minimal). Previously only 8 patterns were generated. New additions include `.env` file access, credential exposure (`sudo`, `env`, `printenv`, `ssh`, `cat ~/.ssh/*`), and hook bypass (`--no-verify`).
- **Security: Known Limitations** — New section in `SECURITY.md` documenting unaddressed surfaces: egress filtering, input sanitization, and blocklist nature of deny patterns.

### Automatic migration

Running `/claude-code-hermit:hermit-upgrade` handles:
1. Refreshes CLAUDE-APPEND.md (new Operator Notification section)
2. Adds `plugin_checks: []` to config if missing, auto-populates for installed recommended plugins
3. Initializes `plugin_checks` key in `state/reflection-state.json`

### What you need to do

1. Run `/claude-code-hermit:hermit-upgrade`
2. If you have recommended plugins installed, verify the auto-populated `plugin_checks` entries: `/hermit-settings plugin-checks`
3. **Docker users:** Re-run `/claude-code-hermit:docker-setup` to regenerate Docker files with security fixes, then rebuild (`hermit-docker up --build`)

### Verify after restart

```bash
cat docker-entrypoint.hermit.sh | grep "plugin update"       # should find nothing (Fix 3)
cat docker-entrypoint.hermit.sh | grep "bypassPermissions"   # should find nothing (Fix 1)
cat docker-compose.hermit.yml | grep "network_mode"          # absent for bridge, present only if host was chosen
```

Check deny patterns in `.claude/settings.json` inside the container — should show the full 25 patterns including the `.env` additions.

---

## For Hermit Authors

1. Keep `plugin.json` version updated
2. Maintain a `CHANGELOG.md`
3. Optionally provide `UPGRADE.md` with hermit-specific instructions
4. Keep `state-templates/CLAUDE-APPEND.md` current
