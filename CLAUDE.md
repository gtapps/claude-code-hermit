# claude-code-hermit

A personal assistant that lives in your project — memory-driven learning, daily rhythm, idle agency, and operational hygiene for Claude Code.

## This Repo is a Plugin

This repo is structured as a Claude Code plugin. It is NOT a standalone project — it gets installed into other projects via:

```
claude plugin marketplace add gtapps/claude-code-hermit
claude plugin install claude-code-hermit@claude-code-hermit --scope project
```

After install, run `/claude-code-hermit:init` in the target project to create the state directory.

## Plugin Structure

- `agents/` — subagent definitions (session-mgr only; hermit plugins add more subagents)
- `skills/` — skill definitions (namespaced as `/claude-code-hermit:*`): session, session-start, session-close, status, brief, monitor, heartbeat, hermit-settings, proposal-create, proposal-list, proposal-act, reflect, channel-responder, init, upgrade, docker-setup, hermit-takeover, hermit-hand-back
- `hooks/hooks.json` — hook registrations
- `scripts/` — hook implementation scripts + boot scripts (hermit-start.py, hermit-stop.py)
- `state-templates/` — templates copied into target projects by the `init` skill
- `.claude-plugin/plugin.json` — plugin manifest

## Per-Project State

When installed in a target project, state lives in `.claude-code-hermit/`:
- `sessions/SHELL.md` — current session (with tags, budget, monitoring)
- `sessions/S-NNN-REPORT.md` — archived reports
- `proposals/PROP-NNN.md` — improvement proposals
- `templates/` — session and proposal templates
- `config.json` — project config (identity, channels, budget prefs, routines, idle agency)
- `OPERATOR.md` — human-curated project context and constraints

## Development

To test locally against a target project:
```
cd /path/to/target-project
claude --plugin-dir /path/to/this-repo
```

Then run `/claude-code-hermit:init` to set up the target project.

---

<!-- claude-code-hermit: Session Discipline — kept in sync with state-templates/CLAUDE-APPEND.md -->

## Session Discipline (claude-code-hermit)

- On startup, always check `.claude-code-hermit/sessions/SHELL.md`
- If a session is active: resume it — read the task, progress, and blockers
- If no session is active: ask what you should help with before starting work
- Use `/claude-code-hermit:session-start` to initialize and `/claude-code-hermit:session-close` to end sessions
- Never create session or proposal files by hand — use the skills

## Agent State Directory

All autonomous agent state lives in `.claude-code-hermit/`:
- `sessions/SHELL.md` — live working document for the current session
- `sessions/S-NNN-REPORT.md` — archived session reports
- `proposals/PROP-NNN.md` — improvement proposals
- `templates/` — templates for sessions and proposals
- `OPERATOR.md` — human-curated project context and constraints

## Subagent Usage

| Agent | When to use | Model |
|-------|------------|-------|
| `session-mgr` | Session start, close, progress tracking | Sonnet |

Additional agents may be available from installed hermits.

## Quick Reference

Common skills (full list: [Skills Reference](docs/SKILLS.md)):

- `/claude-code-hermit:session` — start or resume a session
- `/claude-code-hermit:session-close` — full shutdown with quality checks
- `/claude-code-hermit:status` — compact summary (auto-triggers on "status", "progress")
- `/claude-code-hermit:brief` — executive summary (auto-triggers on "brief", "what happened")
- `/claude-code-hermit:heartbeat` — background checklist (run/start/stop/status/edit)
- `/claude-code-hermit:hermit-settings` — view/change config
- `/claude-code-hermit:proposal-list` — view proposals (auto-triggers on "any proposals")
- `/claude-code-hermit:proposal-act` — accept, defer, or dismiss a proposal
- `/claude-code-hermit:upgrade` — update config and templates after plugin update
- `/claude-code-hermit:docker-setup` — generate Docker scaffolding for always-on
- `/claude-code-hermit:hermit-takeover` / `hermit-hand-back` — operator control
