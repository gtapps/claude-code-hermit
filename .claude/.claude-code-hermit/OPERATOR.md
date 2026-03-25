# Operator Context

## Project

Claude-code-hermit is a Claude Code plugin providing session discipline, subagent delegation, and operational hygiene for autonomous agent workflows. It is distributed via the Claude Code plugin marketplace (`gtapps/claude-code-hermit`).

This repo IS the plugin source. When developing here, the plugin is loaded from the local directory (not the marketplace cache). All changes take effect immediately on next session start.

Operator: gtapps. Goal: keep the plugin lean, composable, and useful for teams running Claude Code autonomously.

## Constraints

- Plugin must remain zero-dependency (no npm packages, no build step)
- No new files without clear purpose — the current ~30-file footprint is a feature
- Never modify `.claude-plugin/plugin.json` version field without a release decision
- All scripts must handle missing SHELL.md gracefully (exit 0, no crash)
- Hooks must be profile-gated or safe to run on any project

## Sensitive Areas

- `state-templates/` — changes here affect every new project that installs the plugin; treat with care
- `hooks/hooks.json` — changes affect all plugin users immediately; test locally first
- `scripts/` — all scripts are executed as hooks; must not have side effects on non-hermit projects

## Naming Conventions

- Branches: `feature/SHORT-DESCRIPTION` or `fix/SHORT-DESCRIPTION`
- Commits: conventional commits (`feat:`, `fix:`, `docs:`, `chore:`)
- Session reports: `S-001-REPORT.md`, `S-002-REPORT.md` (sequential, never reused)
- Proposals: `PROP-001.md`, `PROP-002.md` (sequential)

## External Dependencies

- Claude Code plugin system (no version pinned — tracks latest stable)
- Marketplace: `github.com/gtapps/claude-code-hermit` (public repo)
- No external APIs or credentials required

## Operator Preferences

- Keep responses concise — this is a dev tool, not a chat assistant
- Always confirm before touching `state-templates/` or `hooks/hooks.json`
- Prefer editing existing files over creating new ones
- Review all changes before commit — no auto-push
- When in doubt, create a proposal rather than making the change
