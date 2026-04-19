# claude-code-hermit

A personal assistant that lives in your project — memory-driven learning, daily rhythm, idle agency, and operational hygiene for Claude Code.

## This Repo is a Plugin

This repo is structured as a Claude Code plugin. It is NOT a standalone project — it gets installed into other projects via:

```
claude plugin marketplace add gtapps/claude-code-hermit
claude plugin install claude-code-hermit@claude-code-hermit --scope project
```

After install, run `/claude-code-hermit:hatch` in the target project to create the state directory.

**Git scope:** Set `scope: "project"` in `config.json` to version hermit state in git. Default is `"local"` (state gitignored).

## Plugin Structure

- `agents/` — subagent definitions (session-mgr, hermit-config-validator, proposal-triage, reflection-judge; hermit plugins add more subagents)
- `skills/` — skill definitions (namespaced as `/claude-code-hermit:*`): session, session-start, session-close, pulse, brief, watch, heartbeat, hermit-routines, hermit-settings, proposal-create, proposal-list, proposal-act, reflect, channel-responder, channel-setup, hatch, hermit-evolve, docker-setup, hermit-takeover, hermit-hand-back, smoke-test, test-run, obsidian-setup, cortex-refresh, cortex-sync, weekly-review, migrate, knowledge
- `hooks/hooks.json` — hook registrations
- `scripts/` — hook implementation scripts + boot scripts (hermit-start.py, hermit-stop.py)
- `state-templates/` — templates copied into target projects by the `hatch` skill
- `.claude-plugin/plugin.json` — plugin manifest

## Constraints

- Before implementing any new capability, check Claude Code docs (https://code.claude.com/docs)
  and plugins (https://claude.com/plugins) for native features that already cover it.
  If overlap exists, delegate — don't build.

## Per-Project State

When installed in a target project, state lives in `.claude-code-hermit/`:

- `sessions/SHELL.md` — current session (with tags, budget, monitoring)
- `sessions/S-NNN-REPORT.md` — archived reports
- `proposals/PROP-NNN.md` — improvement proposals
- `templates/` — session and proposal templates
- `state/` — runtime observations (alert-state.json, reflection-state.json, routine-metrics.jsonl, proposal-metrics.jsonl, micro-proposals.json, state-summary.md, monitors.runtime.json)
- `raw/` — domain inputs (fetched content, snapshots, logs); flat layout only (no subdirectories). `raw/.archive/` holds expired artifacts. See [plugin-hermit-storage](docs/plugin-hermit-storage.md).
- `compiled/` — durable domain outputs (briefings, decisions, assessments) injected at session start; flat layout only (no subdirectories)
- `knowledge-schema.md` — per-hermit behavioral schema (what it produces and when)
- `config.json` — project config (identity, channels, budget prefs, routines, idle agency, plugin checks)
- `OPERATOR.md` — human-curated context (draft changes, confirm before writing; hard-blocked in always-on mode)

`hatch` also seeds `bin/` (lifecycle scripts), `docker/` (container scaffolding), `obsidian/` (Cortex vault templates), `HEARTBEAT.md`, `IDLE-TASKS.md`, and `SESSION-REPORT.md` — see `state-templates/` for the full set.

## Migrations

When a change needs to be applied to existing hermits (not just the template for new ones), document it in `CHANGELOG.md` under the relevant version's `### Upgrade Instructions` section. The `hermit-evolve` skill reads and **executes** those instructions — write them as imperative steps the skill will follow, not passive notes.

Example: removing a line from an operator-editable file (like `HEARTBEAT.md`) that `hermit-evolve` would otherwise skip.

## Development

To test locally against a target project:

```
cd /path/to/target-project
claude --plugin-dir /path/to/this-repo
```

Then run `/claude-code-hermit:hatch` to set up the target project.

Run tests:

```
bash tests/run-all.sh
```

**Development constraints (non-negotiable):**

- No dependencies — no `package.json`, no `node_modules`. Hook scripts use Node.js stdlib only.
- No build step — skills are plain markdown, hooks are standalone `.js`/`.sh` scripts.
- Hooks fail open — a hook must never block Claude Code. Catch all errors, `process.exit(0)`. Never exit non-zero on transient failures.
- Consume stdin — every hook must read stdin to completion even if unused (avoids broken pipe errors).
- Agent references in skill instructions must always use the full namespaced form `claude-code-hermit:<agent-name>` (e.g., `claude-code-hermit:session-mgr`). Bare names are auto-namespaced by the harness on load, so bare-name invocations from skill text will fail with "Agent type not found".
