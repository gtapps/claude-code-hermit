# Changelog

## [0.2.1] - 2026-03-31

### Fixed

- **Mandatory proposal pipeline** — Hermits could bypass the proposal workflow by presenting improvements as informal numbered lists in channel messages and implementing them after verbal approval. Now enforced: every improvement must have a PROP-NNN file before implementation. CLAUDE-APPEND.md includes a hard "Proposal Pipeline (mandatory)" rule loaded into every session.

- **Channel-responder now recognizes proposal approvals** — New "Proposal approval" message classification catches messages like "accept PROP-", "go ahead with PROP-012", or informal references (#1, #2). Routes through `/proposal-act` instead of treating them as new task assignments. Classification is ordered before "New instruction" to prevent misrouting.

- **Heartbeat "no action" rule clarified** — The heartbeat instruction "Do NOT take action on findings" conflicted with creating proposals for discovered improvements. Reworded to "Do NOT implement fixes — only report." Creating proposals is explicitly called out as documentation, not action.

- **Reflect skill uses formal proposal references** — The reflect skill now uses backtick-formatted `/claude-code-hermit:proposal-create` references (was plain text).

### Files affected

| File | Change |
|------|--------|
| `state-templates/CLAUDE-APPEND.md` | Added "Proposal Pipeline (mandatory)" section |
| `skills/channel-responder/SKILL.md` | Added "Proposal approval" classification before "New instruction" |
| `skills/heartbeat/SKILL.md` | Clarified "no action" rule, proposal creation is documentation |
| `skills/reflect/SKILL.md` | Formatted proposal-create reference |

### Upgrade Instructions

Run `/claude-code-hermit:upgrade`. The upgrade skill handles:

1. **CLAUDE-APPEND block update** — The session discipline block in your project's CLAUDE.md is refreshed to include the new "Proposal Pipeline (mandatory)" section. This is the primary fix — it prevents hermits from skipping the proposal workflow.

2. **Template refresh** — No template changes in this version.

**No config.json changes required.** This is a behavioral fix via updated instructions only.

---

## [0.2.0] - 2026-03-31

### Changed

- **Plan tracking delegated to native Claude Code Tasks** — The `## Plan` table in SHELL.md has been removed. Plan items are now tracked as native Claude Code Tasks (`TaskCreate`, `TaskUpdate`, `TaskList`). This aligns with hermit's principle: "If overlap exists with Claude Code native features, delegate — don't build." SHELL.md retains everything Tasks doesn't cover: progress log, blockers, findings, changed files, cost, monitoring, session summary, and session metadata.

- **New: `tasks-snapshot.md` for Obsidian** — The cost-tracker hook now writes `.claude-code-hermit/tasks-snapshot.md`, a read-only projection of the native task list with YAML frontmatter (`progress`, `updated`). Enables Dataview queries, dashboard embeds, and fleet progress tracking across multi-hermit observatories. Auto-generated every turn with change detection (skips write when content is unchanged).

- **New: `scripts/lib/tasks.js` shared helper** — Centralizes native Task file reading (`~/.claude/tasks/{list-id}/*.json`) in one module. Both `cost-tracker.js` and `evaluate-session.js` import from here. If Claude Code changes the task file format, only this file needs updating.

- **`CLAUDE_CODE_TASK_LIST_ID` set by init** — The `init` skill now writes `CLAUDE_CODE_TASK_LIST_ID` to `.claude/settings.local.json`, making the task list persistent across sessions. Claude Code exports this env var to all subprocesses (hooks, MCP servers, Bash), so hooks can read task files directly.

- **Session workflow updated** — The main session agent now creates Tasks after plan confirmation (`TaskCreate` per step), updates them during work (`TaskUpdate`), and cleans up before idle/close transitions. Session-mgr no longer manages plan items — it receives the serialized task table via prompt and includes it in archived reports.

- **Idle transition: all tasks deleted (clean slate)** — On idle transition, the main agent serializes the task table, deletes all tasks, then invokes session-mgr. The report preserves the full task table.

- **Full session close: only completed tasks deleted** — Pending/in_progress tasks persist in the native task list for the next session. The "Next Start Point" in fresh SHELL.md notes: "Unfinished tasks remain in the task list."

- **Quick tasks skip TaskCreate** — For single-step work (typo fixes, one-liner changes), the agent skips `TaskCreate`. Tasks are for multi-step work decomposition only. Same policy as before ("skip for quick asks"), now explicitly stated.

### Fixed

- **evaluate-session.js hash cache now includes task state** — The MD5 short-circuit hash previously only covered SHELL.md content. Since plan tracking moved to external task files, the hash now includes the task count. Task changes correctly invalidate the cache.

- **Pipe characters in task subjects no longer break snapshot table** — `writeTaskSnapshot` now escapes `|` in subject and status fields.

### Files affected

| File | Change |
|------|--------|
| `state-templates/SHELL.md.template` | Removed `## Plan` section |
| `agents/session-mgr.md` | Removed plan table ops, accepts task table from prompt |
| `skills/session/SKILL.md` | TaskCreate/TaskUpdate workflow, task cleanup before idle |
| `skills/session-start/SKILL.md` | Create Tasks instead of plan table |
| `skills/session-close/SKILL.md` | Task cleanup on close, pass table to session-mgr |
| `skills/status/SKILL.md` | TaskList for progress counts |
| `skills/brief/SKILL.md` | TaskList for progress counts |
| `skills/channel-responder/SKILL.md` | Removed Plan reference |
| `skills/hermit-takeover/SKILL.md` | Updated example output |
| `state-templates/CLAUDE-APPEND.md` | Added task discipline, removed plan table refs |
| `scripts/lib/tasks.js` | **New** — shared task file reading helper |
| `scripts/cost-tracker.js` | Task reading + snapshot write (replaces plan parsing) |
| `scripts/evaluate-session.js` | Task-aware plan check + hash fix |
| `skills/init/SKILL.md` | Writes `CLAUDE_CODE_TASK_LIST_ID` to settings.local.json |
| `skills/upgrade/SKILL.md` | v0.2.0 migration: task list ID + legacy plan strip |
| `tests/fixtures/shell-session.md` | Removed plan table from fixture |
| `docs/ARCHITECTURE.md` | Updated plan lifecycle |
| `docs/HOW-TO-USE.md` | Updated progress display |
| `docs/OBSIDIAN-SETUP.md` | Snapshot embed, progress queries, fleet progress |

### Upgrade Instructions

Run `/claude-code-hermit:upgrade`. The upgrade skill handles:

1. **Task list ID setup** — Writes `CLAUDE_CODE_TASK_LIST_ID` to `.claude/settings.local.json` (derived from project basename). This makes native Tasks persistent and lets hooks read task files.

2. **SHELL.md template update** — The new template has no `## Plan` section. Existing templates in `.claude-code-hermit/templates/` are auto-replaced.

3. **CLAUDE-APPEND block update** — Session discipline instructions are refreshed to reference native Tasks.

4. **Legacy plan table cleanup** — If an active SHELL.md has a `## Plan` section, the upgrade warns you to close the session first. If confirmed, it strips the orphaned section.

**No config.json changes required.** The task list ID lives in `settings.local.json`, not config.

**Obsidian users:** Add `![[.claude-code-hermit/tasks-snapshot]]` above your SHELL.md embed in your dashboard. See updated `docs/OBSIDIAN-SETUP.md` for Dataview queries and layout recommendations.

---

## [0.1.3] - 2026-03-30

### Changed

- **Docker: OAuth via `claude login` instead of token injection** — The `CLAUDE_CODE_OAUTH_TOKEN` env var approach has been removed entirely. It caused the container to run in organization/API mode instead of personal Max/Pro mode, breaking `--remote-control` and subscription features. OAuth users now run `claude login` directly inside the container on first boot. Credentials are saved to the named volume and persist across restarts. API key auth via `ANTHROPIC_API_KEY` in `.env` continues to work as before.

### Upgrade Instructions

**Option A — Re-run docker-setup (recommended):**

1. Back up your `.env` file
2. Run `/claude-code-hermit:docker-setup` — it will offer to regenerate all Docker files
3. Rebuild and restart the container: `docker compose -f docker-compose.hermit.yml up -d --build`
4. The container will wait for you to log in. From another terminal:
   ```
   docker compose -f docker-compose.hermit.yml exec hermit claude login
   ```
5. Remove `CLAUDE_CODE_OAUTH_TOKEN` and `CLAUDE_REFRESH_TOKEN` from your `.env` file (no longer used)

**Option B — Manual patch:**

1. In `docker-entrypoint.hermit.sh`, replace the "Auth mode" section (the `if` block that unsets `ANTHROPIC_API_KEY`) with:
   ```bash
   # Wait for auth credentials
   CRED_FILE="${CLAUDE_CONFIG_DIR}/.credentials.json"
   if [ -z "${ANTHROPIC_API_KEY:-}" ] && [ ! -f "$CRED_FILE" ]; then
     echo "[docker-entrypoint] No auth credentials found."
     echo "[docker-entrypoint] Run: docker compose -f docker-compose.hermit.yml exec hermit claude login"
     echo "[docker-entrypoint] Waiting for credentials (timeout: 10 minutes)..."
     WAIT_SECS=0
     while [ ! -f "$CRED_FILE" ]; do
       sleep 5
       WAIT_SECS=$((WAIT_SECS + 5))
       if [ "$WAIT_SECS" -ge 600 ]; then
         echo "[docker-entrypoint] Timed out. Run claude login, then restart."
         exit 1
       fi
     done
     echo "[docker-entrypoint] Credentials detected! Continuing startup..."
   fi
   ```
2. In `docker-compose.hermit.yml`, remove the `CLAUDE_CODE_OAUTH_TOKEN` and `CLAUDE_REFRESH_TOKEN` environment lines
3. Remove `CLAUDE_CODE_OAUTH_TOKEN` and `CLAUDE_REFRESH_TOKEN` from your `.env` file
4. Rebuild: `docker compose -f docker-compose.hermit.yml up -d --build`
5. Login: `docker compose -f docker-compose.hermit.yml exec hermit claude login`

**Important:** Both options require a container rebuild (`--build`) since the entrypoint script is baked into the Docker image. A simple restart will not pick up the changes.

---

## [0.1.2] - 2026-03-30

### Fixed

- **Docker: OAuth token no longer overridden by API key** — When both `CLAUDE_CODE_OAUTH_TOKEN` and `ANTHROPIC_API_KEY` are present in the container environment (e.g. via `env_file: .env`), Claude Code silently picks API mode — no Max/Pro shown, `--remote-control` fails. Fixed in three layers: the entrypoint now `unset`s `ANTHROPIC_API_KEY` early when the OAuth token is set; `hermit-start.py` skips forwarding `ANTHROPIC_API_KEY` into the tmux session when the OAuth token is present; and the `docker-setup` skill now detects the conflict in `.env` during setup and offers to clean it up.

### Upgrade Instructions

If you have an existing Docker deployment using OAuth auth, apply the following change:

- Add the following block near the top of your `docker-entrypoint.hermit.sh`, before the onboarding section:

```bash
# Auth mode: OAuth token wins over API key if both are present
if [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ] && [ -n "${ANTHROPIC_API_KEY:-}" ]; then
  echo "[docker-entrypoint] OAuth token present — unsetting ANTHROPIC_API_KEY to prevent API mode override."
  unset ANTHROPIC_API_KEY
fi
```

Then rebuild the container: `hermit-run docker-up --build`

---

## [0.1.1] - 2026-03-30

### Fixed

- **Cost tracker now captures real token data** — The Stop hook payload never included token fields; `cost-tracker.js` was silently writing zero-cost entries (or on newer installs, not writing at all). It now reads the last assistant turn's `usage` from `transcript_path` in the hook payload, which is where Claude Code actually exposes token counts.
- **Cache token pricing** — Added separate pricing rates for `cache_creation_input_tokens` (write) and `cache_read_input_tokens` (read) for all models. Previously cache tokens were ignored entirely, understating cost for heavily-cached sessions.
- **Efficient transcript tail-read** — Instead of loading the full transcript file, reads only the last 128KB using a positioned `fs.readSync` call. Avoids unnecessary memory use on long sessions.

### No manual upgrade steps required.

---

## [0.1.0] - 2026-03-30

### Added

- **`hermit-run docker-up`** — Start the Docker container and print the tmux attach command. Passes extra args to `docker compose up` (e.g., `hermit-run docker-up --build` to force rebuild).
- **`hermit-run docker-down`** — Graceful shutdown: sends `/session-close --shutdown` via tmux, waits up to 60s for the session to close, then stops the container. Use `--force` to skip the graceful close. Timeout is logged if graceful close doesn't complete.
- **`hermit-status` attach hint** — When Docker container is running, status output now includes the tmux attach command.
- **Docker entrypoint SIGTERM trap** — Container now handles `docker compose down` gracefully. SIGTERM triggers a session close attempt (30s timeout) before the container exits, so sessions are archived even without `hermit-run docker-down`.

### Changed

- **`hermit-run` is the single dispatcher** — Docker subcommands (`docker-up`, `docker-down`) are handled as subcommands in `hermit-run`, using the same config resolution as `hermit-start`/`hermit-stop`. No separate wrapper scripts needed.
- **Upgrade skill bin copy** — Step 5b now copies all files from `state-templates/bin/` instead of naming specific scripts. New bin scripts are automatically picked up on upgrade.
- **Docker-down polls host filesystem** — Status polling reads `.claude-code-hermit/.status` directly from the host (bind-mounted) instead of spawning `docker compose exec` on every poll iteration.
- **Compose service name from `docker compose config --services`** — Replaces fragile YAML line-scanning with the authoritative Docker Compose command.

### Fixed

- **Docker: add missing `jq` dependency** — `routine-watcher.sh` requires `jq` to parse `config.json` for timezone and routines. Without it, the routine watcher silently fails and no scheduled routines fire inside the container.

### Upgrade Instructions

If you have an existing `Dockerfile.hermit` generated by `/claude-code-hermit:docker-setup`, add `jq` to the `apt-get install` line:

```diff
 RUN apt-get update && apt-get install -y --no-install-recommends \
-      tmux python3 python3-venv python3-pip git curl unzip ca-certificates && \
+      tmux python3 python3-venv python3-pip git curl unzip jq ca-certificates && \
```

If you have an existing `docker-entrypoint.hermit.sh`, regenerate it with `/claude-code-hermit:docker-setup` or manually add the SIGTERM trap from the updated template.

Then rebuild: `docker compose -f docker-compose.hermit.yml build`

---

## [0.0.10] - 2026-03-30

### Added

- **YAML frontmatter on session reports** — S-NNN-REPORT.md files now include structured YAML frontmatter (`id`, `status`, `date`, `duration`, `cost_usd`, `tags`, `proposals_created`). Enables querying by any tool that reads YAML: Obsidian Dataview, datasette, jq, Grafana. The old `## Summary` bullet list is replaced by `## Overview` (task description only) — no metadata duplication.
- **YAML frontmatter on proposals** — PROP-NNN.md files now include frontmatter (`id`, `status`, `source`, `session`, `created`, `related_sessions`, `category`). The 5 bullet metadata lines are removed. New `category` field (improvement/routine/capability/constraint) is LLM-classified at creation time for filtering.
- **Cost summary** — `cost-tracker.js` generates `.claude-code-hermit/cost-summary.md` with frontmatter aggregates (`total_cost_usd`, `total_sessions`, `avg_session_cost_usd`) and human-readable Today/This Week/All Time sections with a 7-day trend table. Regenerates once per day.
- **Brief cost integration** — `--morning` brief includes "Yesterday: $X.XX across N sessions" from cost-summary.md. `--evening` and daily summary briefs reference cost-summary.md for aggregated data.
- **Obsidian Quick Start** — OBSIDIAN-SETUP.md restructured: leads with a 4-step paste-and-go setup. New sections: Cost Dashboard, Proposal Pipeline, Canvas Planning (manual), Multi-Hermit Setup (symlinks).
- **Cost summary guard** — uses `statSync` on cost-summary.md file mtime to skip regeneration if already generated today. No config.json dependency on the hot path.

### Changed

- **Session report template** — `## Summary` (6 bullet lines) replaced by YAML frontmatter + `## Overview` (one-line task description). All structured metadata lives in frontmatter only.
- **Proposal template** — Bullet metadata (`- **Status:**`, etc.) replaced by YAML frontmatter. Body starts at `## Context`.
- **session-mgr agent** — On Session Close and On Task Complete now generate YAML frontmatter when archiving. Includes explicit extraction instructions and example output.
- **proposal-create** — Writes YAML frontmatter instead of bullet metadata. Classifies proposal category.
- **proposal-act** — Updates frontmatter `status` field and adds action date (`accepted_date`, `deferred_date`, `dismissed_date`). Falls back to bullet metadata for pre-Observatory proposals.
- **proposal-list** — Reads YAML frontmatter first, falls back to bullet format. Table now includes `Category` column.
- **reflect** — Parses frontmatter when scanning proposals, falls back to bullets.
- **brief** — Reads cost-summary.md for cost data. Proposal scanning uses frontmatter with bullet fallback.

### Upgrade Instructions

Run `/claude-code-hermit:upgrade` to refresh templates and migrate existing files.

**Migration: Session reports to YAML frontmatter**

For each `.claude-code-hermit/sessions/S-*-REPORT.md`:

1. Skip files already starting with `---` (already migrated)
2. Parse the `## Summary` bullet metadata (format: `- **Field:** value`):
   - `id`: from filename (e.g., `S-001-REPORT.md` -> `S-001`)
   - `status`: from `- **Status:**` line (default `completed` if missing)
   - `date`: from `- **Date:**` line
   - `duration`: from `- **Duration:**` line
   - `cost_usd`: from `- **Cost:**` line — strip the `$` prefix, parse the number before `(`. E.g., `$1.2345 (138K tokens)` -> `1.2345`. Use `0.00` if missing.
   - `tags`: from `- **Tags:**` line — split on `,`, trim whitespace, format as YAML array. E.g., `refactor, frontend` -> `[refactor, frontend]`. Use `[]` if empty.
   - `proposals_created`: scan `## Proposals Created` section for `PROP-NNN` patterns, format as YAML array. Use `[]` if none.
3. Prepend the generated YAML frontmatter block (between `---` delimiters)
4. Replace the `## Summary` section (heading + bullet lines) with `## Overview` containing only the `- **Task:**` value as prose
5. Validate: re-read the file, verify frontmatter starts with `---` and ends with `---`, verify `id` and `status` fields are present. If parsing fails, warn: "Could not migrate S-NNN-REPORT.md — manual review needed." and leave the file unchanged.

Report: "Migrated N session reports with YAML frontmatter."

**Migration: Proposals to YAML frontmatter**

For each `.claude-code-hermit/proposals/PROP-*.md`:

1. Skip files already starting with `---` (already migrated)
2. Parse the bullet metadata lines (format: `- **Field:** value`):
   - `id`: from filename (e.g., `PROP-001.md` -> `PROP-001`)
   - `status`: from `- **Status:**` line
   - `source`: from `- **Source:**` line (default `manual` if missing)
   - `session`: from `- **Session:**` line
   - `created`: from `- **Created:**` line
   - `related_sessions`: from `- **Related Sessions:**` line — split into YAML array. Use `[]` if empty.
   - `category`: classify based on body content — `routine` if mentions schedule/cron/recurring, `capability` if mentions agent/skill/heartbeat, `constraint` if mentions OPERATOR.md, else `improvement`
3. Prepend the generated YAML frontmatter block
4. Remove the 5 bullet metadata lines from the body (everything between the H1 heading and `## Context`)
5. Validate: same as session reports. If parsing fails, warn and leave unchanged.

Report: "Migrated N proposals with YAML frontmatter."

---

## [0.0.9] - 2026-03-29

### Added

- **Routines system** — Shell-level routine watcher (`scripts/routine-watcher.sh`) fires skills at exact scheduled times. Runs as a tmux window, reads `config.json` routines every 60 seconds. No LLM tokens spent on clock-checking. Manage with `/hermit-settings routines`.
- **Stale session detection** — Heartbeat alerts when an active session shows no progress for longer than `stale_threshold` (default: `"2h"`). Catches silent crashes and rate limit stalls.
- **Skip receipts** — When heartbeat resumes after skipped ticks (outside active hours, empty checklist), logs one summary line instead of silence. Eliminates ambiguous monitoring gaps.
- **Checklist weight guidance** — HEARTBEAT.md template includes `<!-- Keep under 10 items -->` comment. Self-evaluation warns if checklist exceeds 10 items and suggests moving periodic checks to routines.
- **`idle_behavior` config** — Top-level setting: `"wait"` (default, check tasks/channels only) or `"discover"` (also run OPERATOR.md maintenance tasks and periodic reflection). Replaces `heartbeat.idle_agency` boolean.
- **When Idle tasks** — OPERATOR.md supports a `## When Idle` section listing low-priority maintenance tasks. Heartbeat picks items sequentially during idle (when `idle_behavior` is `"discover"`), capped by `idle_budget`.
- **`.status` file** — `.claude-code-hermit/.status` contains a single word (`idle`, `in_progress`, `shutdown`) for shell consumers. Maintained by session-start, session-close, heartbeat, and hermit-stop.
- **Routine proposals** — `reflect` can suggest new routines when it detects repeating operator request patterns. `proposal-act` handles `Type: routine` proposals by adding config entries directly.
- **Brief `--morning`/`--evening` flags** — Routine-optimized variants: morning emphasizes forward-looking content (priorities, proposals), evening emphasizes backward-looking (completed work, cost, findings). Framing adapts to `always_on` setting.
- **New config keys** — `idle_behavior` (default `"wait"`), `idle_budget` (default `"$0.50"`), `heartbeat.stale_threshold` (default `"2h"`), `routines` (default `[]`).

### Changed

- **Morning/evening routines** — Moved from LLM heartbeat evaluation to shell-level routine watcher. Timing is now deterministic (exact HH:MM) instead of probabilistic. Existing config is migrated automatically on upgrade.
- **Idle agency** — `heartbeat.idle_agency` boolean replaced by `idle_behavior` string for clearer semantics. `true` migrates to `"discover"`, `false` to `"wait"`.
- **Heartbeat edit subcommand** — Now shows item count and offers to migrate overgrown items to routines.
- **Self-evaluation** — Added checklist weight check (warns if > 10 items).

### Deprecated

- `heartbeat.morning_routine` — migrated to `routines[]` on upgrade
- `heartbeat.evening_routine` — migrated to `routines[]` on upgrade
- `heartbeat.idle_agency` — migrated to `idle_behavior` on upgrade
- `heartbeat._last_morning`, `heartbeat._last_evening` — replaced by routine watcher dedup
- `morning_brief` — migrated to `routines[]` on upgrade (if configured)

**What you need to do:**

1. Run `/claude-code-hermit:upgrade` to migrate config and refresh templates
2. Review migrated routines: `/claude-code-hermit:hermit-settings routines`
3. Optionally add `## When Idle` to OPERATOR.md and set `idle_behavior` to `discover`

---

## [0.0.8] - 2026-03-29

### Added

- **Deny pattern generation in `/init`** — new step 9 asks whether you're planning always-on operation and generates appropriate deny rules in `.claude/settings.json`, including OPERATOR.md write protection with `**/` prefix. Always-on set adds `git push --force`, `git reset --hard`, `chmod 777`.
- **Deny patterns in `/docker-setup`** — Docker means always-on, so the full hardened deny set is included by default (no wizard).
- **Channel access control** — new `allowed_users` config (per-channel user ID allowlist). Absent field = accept all (backwards compatible). Empty array = accept none (explicit lockdown). Non-allowlisted users are silently ignored for all message types.
- **`AGENT_HOOK_PROFILE` protection** — boot script validates profile values and enforces a hardcoded `standard` floor in always-on mode. Agent cannot downgrade from `strict` to `minimal` by writing to config.json. `hermit-settings env` blocks modification of this key.
- **Evaluate-session hash optimization** — Stop hook now caches an MD5 hash of SHELL.md content. Skips evaluation when nothing changed since last run. SessionStart hook clears the hash for a clean slate each session.
- **Capability-gap awareness in reflect** — when idle, the hermit now thinks broader: missing heartbeat checks, OPERATOR.md gaps, sub-agents for recurring work, skills for repeated workflows. Only fires when SHELL.md status is `idle`.
- **Dismissed/deferred proposal awareness** — reflect reviews past dismissed and deferred proposals to avoid re-suggesting recently rejected ideas. Revisits if significantly more evidence has accumulated.
- **Self-contained capability proposals** — proposal-create now includes implementation templates for sub-agents, skills, heartbeat checks, and OPERATOR.md refinements. Each template is self-contained so the implementer can act without referencing external docs.
- **Security impact notes in proposals** — proposals that affect security boundaries (permissions, network access, credential handling) must clearly note the impact so the operator can make an informed decision.

### Changed

- **Docker config isolation** — container now uses a Docker named volume (`claude-config`) instead of bind-mounting `~/.claude`. Prevents container state from leaking into host interactive sessions. Volume persists across restarts.
- **Docker npm permissions** — npm globals installed as `claude` user via `NPM_CONFIG_PREFIX`, enabling Claude Code self-update without sudo.
- **Docker plugin installation** — entrypoint registers marketplaces and installs plugins on first boot using filesystem checks (not `claude plugin list`, which false-positives on project-scoped plugins).
- **Docker plugin root resolution** — `HERMIT_PLUGIN_ROOT` env var bridges the host-path `_plugin_root` in config.json to the container's actual plugin path. `hermit-run` checks the env var first.
- **Docker auto-memory seeding** — copies host `~/.claude/projects/<path-key>/memory/MEMORY.md` into the container on first boot so the hermit starts with full context.
- **Docker channel pairing** — entrypoint symlinks channel state dirs, pair command includes inline scope hint and fallback mv for plugins that hardcode `~/.claude/channels/`.
- **Docker git identity** — read-only bind-mount of `~/.gitconfig` (conditional on existence).
- **Docker `NODE_OPTIONS`** — sets `--max-old-space-size=4096` per official devcontainer recommendations.

**What you need to do:**

1. Run `/claude-code-hermit:upgrade` to refresh templates
2. **Deny patterns (recommended):** Add safety deny rules to `.claude/settings.json` — run `/claude-code-hermit:init` step 9 or add manually:
   ```json
   "permissions": {
     "deny": [
       "Bash(rm -rf *)",
       "Bash(git push --force*)",
       "Bash(git reset --hard*)",
       "Bash(chmod 777*)",
       "Bash(curl * | bash*)",
       "Bash(wget * | bash*)",
       "Edit(**/.claude-code-hermit/OPERATOR.md)",
       "Write(**/.claude-code-hermit/OPERATOR.md)"
     ]
   }
   ```
3. **Channel access control (optional):** Add `"allowed_users": {"discord": ["your-user-id"]}` to config.json to restrict who can send commands via channels
4. If using Docker: rebuild (`docker compose -f docker-compose.hermit.yml build`) to pick up the deny patterns

---

## [0.0.7] - 2026-03-28

### Changed

**Environment variable system redesigned**

Env vars are now managed in `config.json` `env` and written to `.claude/settings.local.json` at boot by `hermit-start`. This is the canonical Claude Code approach — settings.json `env` values are exported to all subprocesses (hooks, MCP servers, Bash tool calls).

**What changed:**

- `config.json` gains an `env` key with defaults: `AGENT_HOOK_PROFILE`, `COMPACT_THRESHOLD`, `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`, `MAX_THINKING_TOKENS`
- `hermit-start` writes `config.json` `env` into `.claude/settings.local.json` on every boot
- Only auth vars (`CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`) remain as shell env — everything else goes through settings.local.json
- Docker compose `environment:` section reduced to auth vars only
- Channel state dirs (`DISCORD_STATE_DIR`, `TELEGRAM_STATE_DIR`) move from compose env to `config.json` `env`

**What you need to do:**

1. Run `/claude-code-hermit:upgrade` — it adds the `env` key to your config.json with defaults
2. If you have channels configured, the upgrade also adds `DISCORD_STATE_DIR` / `TELEGRAM_STATE_DIR` to `env`
3. If you use Docker: rebuild (`docker compose -f docker-compose.hermit.yml build`) and regenerate compose with `/claude-code-hermit:docker-setup` to get the slimmed-down `environment:` section — or just remove the 5 non-auth env vars from your existing compose file manually

### Added

- **`docker.packages` in config.json** — project-specific apt packages for Docker containers. During `/docker-setup`, Claude analyzes the project (package.json, requirements.txt, Makefile, database configs, OPERATOR.md) and suggests system packages with reasoning. The operator approves/edits, and packages are included as a separate Dockerfile layer. Hermit plugins can also append packages in their init skill.
- **`/hermit-settings docker`** — view and edit Docker packages in config.json
- **`/hermit-settings env`** — view and edit env vars in config.json
- **Deep merge in `load_config()`** — partial config.json overrides of `env`, `heartbeat`, and `docker` no longer drop sibling defaults

### Fixed

- `load_config()` shallow merge bug — if config.json had `"env": {"AGENT_HOOK_PROFILE": "strict"}`, the other 3 default env vars were silently lost. Now deep-merges nested dicts.
- `load_config()` crash when `active_hours: null` in config.json — deep merge tried to unpack `None` as dict. Now guards with `or {}`.
- **Channel state dirs kept as OS env vars** — `DISCORD_STATE_DIR` / `TELEGRAM_STATE_DIR` are forwarded via tmux temp file and Docker compose `environment:`, not just `settings.local.json`. MCP servers (which channel plugins run as) inherit shell env but don't read `settings.local.json`.
- **Stale channel tokens cleaned from settings.local.json** — `hermit-start` now removes `*_BOT_TOKEN` vars from `.claude/settings.local.json` on every boot. If a bot token exists in both settings.local.json and `.claude.local/channels/<plugin>/.env`, the settings.local.json value overrides the file (via `process.env`) and goes stale silently when the token is rotated. The token should only live in the channel's `.env` file. Docker setup also cleans stale tokens when configuring channels.
- **Docker channel plugin workaround documented** — channel plugins v0.0.4 hardcode `~/.claude/channels/` in both MCP servers and skill files (`/discord:access`, `/discord:configure`). Docker setup now documents the `*_STATE_DIR` override and skill patching needed until Anthropic fixes this upstream.

---

## [0.0.6] - 2026-03-28

### Breaking

**State directory moved out of `.claude/`**

The hermit state directory has moved from `.claude/.claude-code-hermit/` to `.claude-code-hermit/` at the project root.

**Why:** Claude Code's `bypassPermissions` mode still prompts for writes to `.claude/` (except `.claude/commands`, `.claude/agents`, `.claude/skills`). The old path caused permission prompts on every SHELL.md update, heartbeat tick, and proposal write — defeating autonomous operation.

**What you need to do:**

1. Move your state directory:

   ```
   mv .claude/.claude-code-hermit .claude-code-hermit
   ```

2. Update `.gitignore` — find the `# claude-code-hermit` block and update the paths:

   ```
   # Before
   .claude/.claude-code-hermit/config.json
   .claude/.claude-code-hermit/sessions/
   .claude/.claude-code-hermit/proposals/
   .claude/.claude-code-hermit/templates/

   # After
   .claude/cost-log.jsonl
   .claude-code-hermit/config.json
   .claude-code-hermit/sessions/
   .claude-code-hermit/proposals/
   .claude-code-hermit/templates/
   ```

3. Update `.claude/settings.json` permissions — in `permissions.allow`, replace:
   - `"Edit(.claude/.claude-code-hermit/**)"` → `"Edit(.claude-code-hermit/**)"`
   - `"Write(.claude/.claude-code-hermit/**)"` → `"Write(.claude-code-hermit/**)"`

4. **If you have a custom hermit** with skills, agents, or scripts that reference `.claude/.claude-code-hermit/` — update those references to `.claude-code-hermit/` before running `/claude-code-hermit:upgrade`

Then run `/claude-code-hermit:upgrade` — it will refresh templates and clean up any remaining stale permissions.

---

## [0.0.5] - 2026-03-28

### Added

- **Docker as default always-on path** — new `docs/ALWAYS-ON.md` guide frames Docker as the recommended way to run autonomous. Container isolation enables safe `bypassPermissions`.
- **`/docker-setup` skill** — generates project-adapted Dockerfile, docker-entrypoint.sh, docker-compose.yml, and .env. Checks prerequisites, refuses if Docker files already exist.
- **`/hermit-takeover` skill** — stops Docker container, marks session as `operator_takeover`, loads full hermit context, presents summary. For driving interactively with full continuity.
- **`/hermit-hand-back` skill** — summarizes operator activity via `git log` since takeover, optionally queues instructions in NEXT-TASK.md, restarts container.
- **`hermit-status` script** — pure bash, zero tokens. Reads `.status.json` sidecar and prints a one-liner: agent, project, status, task, progress, cost, blockers, Docker state.
- **`.status.json` sidecar** — cost-tracker hook now writes structured session data for the `hermit-status` script.
- **Conversational auto-triggers** — `session-close`, `proposal-list`, and `proposal-act` now activate from natural language ("I'm done", "any proposals", "accept PROP-003"). Slash commands remain as precision fallback.
- **`pattern-detect` → `reflect`** — renamed to match what it actually does: a reflection prompt, not algorithmic pattern detection.

### Changed

- **`docs/ALWAYS-ON-OPS.md`** — Docker section removed (now in ALWAYS-ON.md). Retained as operational reference: lifecycle, security, channels, cost management. Renumbered sections.
- **`README.md`** — Quick Start step 4 is now "Go always-on (recommended)" with `/docker-setup`. Bare tmux demoted to fallback note. Documentation table updated.
- **`docs/HOW-TO-USE.md`** — "Going Always-On" section rewritten: Docker recommended, bare tmux as fallback.
- **`docs/SKILLS.md`** — added Docker & Takeover category with 3 new skills (18 total).
- **`init` skill** — now copies `hermit-status` to `bin/` alongside existing scripts.

---

## [0.0.4] - 2026-03-27

### Breaking

**Hermit plugin authors:** the following contracts changed.

| Contract            | v0.0.3                        | v0.0.4                                                                |
| ------------------- | ----------------------------- | --------------------------------------------------------------------- |
| Learning trigger    | session-close invokes reflect | Reflection fires independently (heartbeat, natural pause, end of day) |
| Reflect input       | Last 5 archived reports       | Memory + SHELL.md + cost-log                                          |
| Session close       | Mandatory for learning        | Optional — still useful for audit trail                               |
| Idle behavior       | Dormant                       | Active (gated by escalation)                                          |
| Report prerequisite | 3+ archived reports           | None                                                                  |

### Added

- **Memory-driven learning** — reflect (formerly pattern-detect) rewritten as a reflection prompt. Uses auto-memory as primary input instead of scanning archived reports. No report prerequisite — learns from day one.
- **Idle agency** — heartbeat checks for autonomous work during idle: NEXT-TASK.md pickup, reflection (every 4+ hours), priority alignment check, maintenance. Gated by escalation level (conservative=alert, balanced=auto-start, autonomous=full auto).
- **Daily rhythm** — morning routine (first heartbeat tick of active hours: brief, proposal review, priority check) and evening routine (last tick: daily journal archived as S-NNN, reflection, tomorrow prep). Both fire once per day.
- **Self-awareness** — behavioral instruction in CLAUDE-APPEND giving the agent permission to stop when stuck. Three triggers: repeated failures, approach reversals, disproportionate cost. Escalation-gated response.
- **Daily summary reports** — evening routine creates S-NNN reports directly (bypasses session-mgr) for mixed days. `## Task` reads "Daily summary — [date]", Plan section omitted.
- **New config keys** — `heartbeat.morning_routine`, `heartbeat.evening_routine`, `heartbeat.idle_agency` (all default `true`), plus internal tracking keys `_last_morning`, `_last_evening`, `_last_reflection`.
- **New hermit-settings subcommands** — `routines` (morning/evening toggle), `idle-agency` (autonomous idle toggle).
- **New init wizard questions** — daily routines and idle agency (both default yes).

### Changed

- **reflect** (formerly pattern-detect) — full rewrite from 125-line report-scanning algorithm to ~20-line reflection prompt. Drops 4 deterministic categories, 3-report minimum, and report reading. Keeps proposal pipeline, dedup, feedback loop, stale flags.
- **heartbeat** — gains idle agency and daily routines. Old "NEXT-TASK.md auto-pickup" section subsumed by idle agency.
- **SHELL.md template** — Plan table is now optional (commented out). Progress Log is the primary record.
- **HEARTBEAT.md template** — grouped structure (Task Checks, Idle Checks, Standing Checks).
- **CLAUDE-APPEND** — gains Self-Awareness, Idle Behavior, Daily Rhythm, and Learning Model sections.
- **session-close** — reflect wording updated (reflects on experience, not reports).
- **session** — reflect reference updated, quick-task skip note added.
- **session-start** — runs morning routine inline for interactive mode.
- **brief** — gains daily summary format variant.

### Design Principle

Hermit is the scheduler and the policy layer. Claude is the intelligence. Hermit says _when_ and _whether_. Claude figures out _how_. Never specify what Claude Code already handles natively.

---

## [0.0.3] - 2026-03-26

### Breaking

`skip_permissions` (boolean) in `config.json` has been replaced by `permission_mode` (string). Update any existing `config.json` manually:

```json
// Before
"skip_permissions": false

// After
"permission_mode": "acceptEdits"
```

Valid values: `"default"`, `"acceptEdits"`, `"dontAsk"`, `"bypassPermissions"`. See [Permission Modes](https://code.claude.com/docs/en/permission-modes).

### Added

- **Unified session lifecycle** — idle transitions happen at every task boundary, regardless of how the session was started. Agent archives the report, says "What's next?", and waits. No prompt, no binary choice.
- **Best-effort heartbeat in interactive idle** — heartbeat starts on idle transition if enabled in config. Runs while terminal is open; always-on mode retains guaranteed heartbeat via tmux.

### Changed

- **`permission_mode` config key** — replaces `skip_permissions: bool` with a string enum matching Claude Code's permission mode flags. Default is `"acceptEdits"` (auto-approves file edits, still prompts for shell commands). Use `"bypassPermissions"` for fully isolated containers/VMs.
- **session skill** — step 6 performs idle transition directly (no longer defers to `/session-close`). Identical path for interactive and always-on.
- **session-close skill** — full shutdown only. No close mode decision tree, no confirmation prompt, no `--idle` path.
- **session-start, status, brief skills** — idle state no longer described as "always-on only"
- **heartbeat skill** — persistence section updated; interactive best-effort note added
- **CLAUDE-APPEND** — unified lifecycle section replaces separate interactive/always-on blocks
- **SHELL.md template** — "always-on mode" qualifiers removed from comments
- **SKILLS.md, ALWAYS-ON-OPS.md** — descriptions updated to reflect unified lifecycle
- **`heartbeat.enabled`** defaults to `true` (was `false`) — heartbeat is locally valuable during idle regardless of channels. **Highly advised for existing projects:** if your `config.json` has `"heartbeat": { "enabled": false, ... }`, set it to `true`. Without this, the agent will not start the heartbeat on idle transitions and you'll lose background monitoring between tasks.
- **`always_on`** template default fixed to `false` (was incorrectly `true`; it's a runtime flag set by hermit-start.py)
- **init wizard** — heartbeat step (4h) removed entirely; heartbeat starts automatically on first idle transition
- **hermit-settings** — heartbeat subcommand no longer gated on channels

### Removed

- Close mode decision tree in `session-close` (idle/shutdown branching, confirmation prompt)
- `--idle` flag on `/session-close` (idle transitions are automatic)
- "always-on only" qualifier on idle transitions throughout

---

## [0.0.2] - 2026-03-25

### Breaking

**Hermit authors must update.** Core terminology and filenames have changed. Hermit plugins (e.g., `claude-code-dev-hermit`) must update their references to match.

**Filename renames:**

| Old                         | New                                         |
| --------------------------- | ------------------------------------------- |
| `sessions/ACTIVE.md`        | `sessions/SHELL.md`                         |
| `ACTIVE.md.template`        | `SHELL.md.template`                         |
| `NEXT-MISSION.md`           | `NEXT-TASK.md`                              |
| `CREATING-DOMAIN-PACK.md`   | `CREATING-YOUR-OWN-HERMIT.md`               |
| `CREATING-PROJECT-AGENT.md` | _(merged into CREATING-YOUR-OWN-HERMIT.md)_ |

**Section renames in SHELL.md / session reports:**

| Old                          | New               |
| ---------------------------- | ----------------- |
| `## Mission`                 | `## Task`         |
| `## Steps`                   | `## Plan`         |
| `\| Step \|` (column header) | `\| Plan Item \|` |
| `## Discoveries`             | `## Findings`     |
| `Missions Completed`         | `Tasks Completed` |

**Terminology renames (docs, skills, agents):**

| Old                        | New      |
| -------------------------- | -------- |
| Domain pack                | Hermit   |
| Hermit agent               | Hermit   |
| Mission (session goal)     | Task     |
| Steps (ordered work items) | Plan     |
| Discoveries                | Findings |

**What hermit authors need to do:**

1. Update all file path references: `sessions/ACTIVE.md` → `sessions/SHELL.md`
2. Update section references: `## Mission` → `## Task`, `## Steps` → `## Plan`, `## Discoveries` → `## Findings`
3. Update `NEXT-MISSION.md` → `NEXT-TASK.md` in any skill that reads/writes it
4. Update `CLAUDE-APPEND.md` to use new section names
5. Replace "domain pack" or "hermit agent" with "hermit" in docs and skill descriptions
6. Run `/claude-code-hermit:upgrade` in target projects to refresh templates

### Added

- **Session lifecycle docs** — Close Mode Decision Tree, Always-On Task Loop, When Self-Learning Fires (ALWAYS-ON-OPS.md sections 1b-1d)
- **Cross-references** — ARCHITECTURE.md and HOW-TO-USE.md link to the new lifecycle sections

### Changed

- **README rewrite** — new intro, Quick Start with channels step, "What It Does" / "What Makes It Different" / "Hermits" sections
- **Consolidated docs** — CREATING-PROJECT-AGENT.md and CREATING-DOMAIN-PACK.md merged into CREATING-YOUR-OWN-HERMIT.md ("Create Your Own Hermit")
- **Trimmed generic content** — CREATING-YOUR-OWN-HERMIT.md now references official Claude Code plugin docs instead of duplicating frontmatter/hook/skill field tables
- **Terminology cleanup** — "hermit agent" replaced with "hermit" across all files (~57 occurrences in 17 files). A hermit is a domain-specific plugin (e.g., dev hermit, infra hermit), not an "agent"

---

## [0.0.1] - 2026-03-25

### Added

- Initial release
- **Session discipline** — task-driven sessions with tracked plans, cost logging, and archived reports
- **15 skills**: session, session-start, session-close, status, brief, monitor, heartbeat, hermit-settings, proposal-create, proposal-list, proposal-act, reflect, channel-responder, init, upgrade
- **session-mgr agent** for session lifecycle management
- **Boot scripts** (`hermit-start.py`, `hermit-stop.py`) for tmux-based headless operation
- **Hook infrastructure** — cost tracking, compact suggestions, session evaluation, session-diff
- **Learning loop** — cross-session pattern detection with auto-generated proposals
- **Proposal system** — numbered proposals with accept/defer/dismiss workflow
- **Heartbeat** — background checklist with self-evaluation and channel alerts
- **Monitoring** — session-aware condition watching
- **Channel support** — Telegram, Discord, iMessage integration
- **Remote control** — browser/phone access via claude.ai/code (enabled by default)
- **Agent identity settings** — name, language, timezone, escalation, sign-off
- **Upgrade skill** with version tracking in config.json
- **OPERATOR.md onboarding** — agent-driven project context generation
- **Documentation** — HOW-TO-USE, ARCHITECTURE, SKILLS, ALWAYS-ON-OPS, UPGRADING, TROUBLESHOOTING, CREATING-YOUR-OWN-HERMIT, OBSIDIAN-SETUP
