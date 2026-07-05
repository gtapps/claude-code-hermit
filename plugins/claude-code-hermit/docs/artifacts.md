# Artifacts

Home for the hermit's use of Claude Code's [Artifacts](https://code.claude.com/docs/en/artifacts)
feature — private `claude.ai/code/artifact/<uuid>` pages published from the main
session. Gated per artifact type under `config.artifacts.*` (default off — opt-in:
entitlement-gated + publishes session-derived content to claude.ai). Only reachable
from the interactive TUI session (`hermit-start`'s surface); absent under `claude -p`.
Runs in **main only, never a subagent** — publishing is a main-session-owned
notification action, same as `CLAUDE-APPEND.md` § Operator Notification, and subagent
`Artifact` tool availability is unverified.

## Dashboard

The Hermit Dashboard (`config.artifacts.dashboard`) is a single persistent page —
status, proposal queue, and weekly evolution — rendered by a deterministic script
(no model authorship) and republished to the same URL whenever a refresh trigger
fires. See `docs/config-reference.md#artifacts` for the config flag and
privacy/entitlement notes; see `scripts/lib/dashboard.ts` for the renderer.

### Refresh procedure

Triggered by `brief` (`--morning`/`--evening`), `weekly-review`, `proposal-create`,
and `proposal-act` (see each skill for exactly where the call sits in its flow):

1. Run `bun ${CLAUDE_PLUGIN_ROOT}/scripts/render-dashboard.ts .claude-code-hermit` and
   parse stdout JSON (`path`, `bytes`, `hash`).
2. Read `.claude-code-hermit/state/artifacts.json` (if present) and compare `hash` to
   `dashboard.hash`. **Unchanged → stop here**, no publish (avoids minting a no-op
   artifact version).
3. Changed or no prior record → call `Artifact` with `file_path` set to the rendered
   `path`, a stable `<title>` of `Hermit Dashboard`, a stable favicon (pick once, keep
   it across republishes), and `url` set to `dashboard.url` from `state/artifacts.json`
   when present (redeploys to the same address instead of minting a new one).
4. On success, write `.claude-code-hermit/state/artifacts.json`:
   `{"dashboard": {"url": "<returned url>", "hash": "<hash from step 1>", "updated": "<now, ISO>"}}`.
5. On any failure (tool absent, no entitlement, publish error) — skip silently, append
   one SHELL.md Findings line for the session (not one per attempt), and continue.
   Never block or degrade the calling skill's normal channel/markdown output.

`brief` and `weekly-review` append a `📎 <url>` line to their channel message when a
URL is returned. `proposal-create` and `proposal-act` refresh silently — no URL re-post.

Future artifact types (e.g. a standalone weekly narrative page, a proposal-queue
page) get their own `config.artifacts.<name>` flag, their own `state/artifacts.json`
key, and their own subsection here — the render/hash-gate/publish shape above is
common infrastructure, not dashboard-specific.
