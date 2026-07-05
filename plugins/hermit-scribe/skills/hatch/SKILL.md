---
name: hatch
description: One-time setup for hermit-scribe — appends the Issue Filing block to CLAUDE.md/CLAUDE.local.md and seeds an auto-mode environment entry naming api.github.com as a trusted, always operator-confirmed destination. Run once per project; re-run to refresh after an upgrade.
---

# Activate hermit-scribe

hermit-scribe is a maintainer utility with a single skill (`/hermit-scribe:hermit-scribe`) — this hatch only needs to make its GitHub App posting behavior visible to the operator's `CLAUDE.md` and to Claude Code's auto-mode classifier. There is no config, no routines, no channels.

## Plan

### 1. Check prerequisites

Check if `.claude-code-hermit/` exists in the current project.

- Missing: ask the operator (`AskUserQuestion`) "Core hermit isn't set up yet. Run `/claude-code-hermit:hatch` now?" with options `Yes — run now` / `No — I'll do it later`. If yes, invoke `/claude-code-hermit:hatch` via the Skill tool and stop. If no, stop.
- Present: proceed.

### 2. Update CLAUDE.md / CLAUDE.local.md

**Resolve target file:** read `.claude-code-hermit/state/hatch-options.json`. `"target": "local"` → `CLAUDE.local.md`; `"target": "committed"` or the file absent → `CLAUDE.md`.

Read `target_file` (a missing file is marker-absent — the append below will create it). Look for the marker `<!-- hermit-scribe: Issue Filing -->`.

- **Marker present:** skip — block is current. Do not re-read the template.
- **Marker absent:** append the full contents of `${CLAUDE_PLUGIN_ROOT}/state-templates/CLAUDE-APPEND.md` to `target_file` (create the file if it doesn't exist).

### 3. Auto-mode environment seed

Run `bun ${CLAUDE_PLUGIN_ROOT}/scripts/automode-env.ts .claude/settings.local.json` — **always `.claude/settings.local.json`, regardless of `hatch_target`**: Claude Code's auto-mode classifier reads `autoMode` config only from local/user scope, never a committed project `.claude/settings.json`. This names `api.github.com` (scoped to the configured `HERMIT_GH_REPO`, or the default `gtapps/claude-code-hermit`) as a service the hermit posts to only with the operator's in-session confirmation — context for the classifier, not a standing permission grant (filing still goes through the skill's own preview/confirm gate every time). Additive and idempotent; safe to re-run. No prompt needed.

### 4. Final report

Print: "hermit-scribe active. Issue filing goes through `/hermit-scribe:hermit-scribe`, always with an in-session preview before posting."
