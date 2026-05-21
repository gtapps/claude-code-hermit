# claude-code-hermit

A personal assistant that lives in your project — memory-driven learning, daily rhythm, idle agency, and operational hygiene for Claude Code.

## This Repo is a Plugin

This repo is structured as a Claude Code plugin. It is NOT a standalone project — it gets installed into other projects via:

```
claude plugin marketplace add gtapps/claude-code-hermit
claude plugin install claude-code-hermit@claude-code-hermit --scope project
```

After install, run `/claude-code-hermit:hatch` in the target project to create the state directory.

## Plugin Structure

- `agents/` — subagent definitions (session-mgr, hermit-config-validator, proposal-triage, reflection-judge, quality-gate-judge; hermit plugins add more subagents)
- `skills/` — skill definitions (namespaced as `/claude-code-hermit:*`): session, session-start, session-close, pulse, brief, watch, heartbeat, hermit-routines, hermit-settings, proposal-create, proposal-list, proposal-act, reflect, reflect-scheduled-checks, capability-brainstorm, channel-responder, channel-setup, hatch, hermit-evolve, docker-setup, docker-security, smoke-test, test-run, hermit-brain, hermit-evolution, hermit-health, weekly-review, migrate, knowledge, hermit-doctor
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
- `proposals/PROP-NNN-<slug>-HHMMSS.md` — improvement proposals
- `templates/` — session and proposal templates
- `state/` — runtime observations (alert-state.json, reflection-state.json, routine-metrics.jsonl, proposal-metrics.jsonl, micro-proposals.json, state-summary.md, monitors.runtime.json)
- `raw/` — domain inputs (fetched content, snapshots, logs); flat layout only (no subdirectories). `raw/.archive/` holds expired artifacts. See [plugin-hermit-storage](docs/plugin-hermit-storage.md).
- `compiled/` — durable domain outputs (briefings, decisions, assessments) injected at session start; flat layout only (no subdirectories)
- `knowledge-schema.md` — per-hermit behavioral schema (what it produces and when)
- `config.json` — project config (identity, channels, budget prefs, routines, idle agency, scheduled checks)
- `OPERATOR.md` — human-curated context (draft changes, confirm before writing; hard-blocked in always-on mode)

`hatch` also seeds `bin/` (lifecycle scripts), `docker/` (container scaffolding), `HEARTBEAT.md`, `IDLE-TASKS.md`, and `SESSION-REPORT.md` — see `state-templates/` for the full set.

## Hatch target routing

`hatch` routes operator-personal outputs based on the plugin's install scope (read from `claude plugin list --json`): `scope=local` → `CLAUDE.local.md` + `.claude/settings.local.json`; `scope=project` → `CLAUDE.md` + `.claude/settings.json`; `scope=user` or no detectable scope → `.local` files (safer default). Advanced mode lets the operator override the scope-derived default via the Visibility prompt. The chosen target is persisted to `.claude-code-hermit/state/hatch-options.json` and read by `hermit-evolve`, `docker-setup`, and `claude-code-dev-hermit:hatch`. `hermit-evolve` Steps 6, 7, 8 are target-aware and will not re-add committed files after a `.local` migration.

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
- Avoid overengineering.
- Hooks fail open — a hook must never block Claude Code. Catch all errors, `process.exit(0)`. Never exit non-zero on transient failures.
- Consume stdin — every hook must read stdin to completion even if unused (avoids broken pipe errors).
- Agent references in skill instructions must always use the full namespaced form `claude-code-hermit:<agent-name>` (e.g., `claude-code-hermit:session-mgr`). Bare names are auto-namespaced by the harness on load, so bare-name invocations from skill text will fail with "Agent type not found".
- **Hermit `state-templates/CLAUDE-APPEND.md` blocks must not restate `config.json` contents** (routine schedules, Discord/Telegram user IDs, morning-brief times, `permission_mode`, `agent_name`, `sign_off`, `escalation`, `idle_behavior`). Those are loaded structurally from `config.json` on every session start. CLAUDE-APPEND describes behaviors, conventions, and workflow shape — not the wiring. Restating config values leaks them into `CLAUDE.md`, which the hatch's OPERATOR.md scan reads, tempting the model to mirror them again into OPERATOR.md prose. Naming routines by `id` and referencing `enabled` state is fine — those are stable; schedules and flags drift.
- **Default `config.json` source of truth is `state-templates/config.json.template`.** Skills (especially `hatch`) must overlay operator choices onto the template — never re-declare a parallel inline default object in SKILL.md text. The `tests/test-template-skill-sync.sh` contract test catches drift between the template's top-level keys and `hatch/SKILL.md` references; if you add a field to the template, also reference it by name in hatch.
- **SKILL.md size: trim before splitting.** Sibling files (e.g., `skills/<name>/EXTRA.md`) are not auto-loaded — only `SKILL.md` is. The model must explicitly `Read` siblings, which is unreliable for branch-conditional flow. When a SKILL.md grows large, prefer trimming verbose prose, collapsing redundant tables, and removing duplicated sections over splitting into multiple files.

## Debugging gotchas

- `read_only: true` on the hermit container is incompatible with Claude Code's credential-refresh write path — Prompt 2 of `/docker-security` was removed in v1.0.30 for this reason. Hermits 401 with `Invalid authentication credentials` once the access token expires (~8h after `/login`) because the refresh write fails silently under the current tmpfs / named-volume layout. Do not reintroduce without verifying refresh writes survive whatever layout is added.
- The hermit Ubuntu image has **no `strace`** and `apt install` is blocked when `read_only: true` is on the container. For fs/network tracing inside hermit, use `NODE_DEBUG=fs,http,https,net,tls claude ...` instead.
- dnsmasq in `hermit-netguard` leaks unmatched queries to Docker's `127.0.0.11` resolver despite `no-resolv` in the allowlist — visible as `forwarded <host> to 127.0.0.11` in `docker logs <stack>-hermit-netguard-1`. Treat the allowlist as advisory until this is fixed.
- `grep` returning no matches breaks `&&` chains in diagnostic one-liners — silently truncates the rest of the pipeline. Use `; grep ... || true` if continuation matters.
- **`hermit-docker update` rebuilds with the on-disk entrypoint, not the template.** When writing `### Upgrade Instructions` for an entrypoint-template change, the operator's on-disk `docker-entrypoint.hermit.sh` must be refreshed first (re-run `/docker-setup` or surgically-patch via hermit-evolve), THEN `hermit-docker update`. Just bumping the plugin and running `update` rebuilds with the same stale entrypoint.
