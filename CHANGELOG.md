# Changelog

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

### Breaking Changes

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

### Breaking Changes — Hermit Plugin Authors

| Contract | v0.0.3 | v0.0.4 |
|---|---|---|
| Learning trigger | session-close invokes reflect | Reflection fires independently (heartbeat, natural pause, end of day) |
| Reflect input | Last 5 archived reports | Memory + SHELL.md + cost-log |
| Session close | Mandatory for learning | Optional — still useful for audit trail |
| Idle behavior | Dormant | Active (gated by escalation) |
| Report prerequisite | 3+ archived reports | None |

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
Hermit is the scheduler and the policy layer. Claude is the intelligence. Hermit says *when* and *whether*. Claude figures out *how*. Never specify what Claude Code already handles natively.

---

## [0.0.3] - 2026-03-26

### Breaking Changes

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

### Changed (defaults)
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

### Breaking Changes — Hermit Authors Must Update

Core terminology and filenames have changed. Hermit plugins (e.g., `claude-code-dev-hermit`) must update their references to match.

**Filename renames:**

| Old | New |
|-----|-----|
| `sessions/ACTIVE.md` | `sessions/SHELL.md` |
| `ACTIVE.md.template` | `SHELL.md.template` |
| `NEXT-MISSION.md` | `NEXT-TASK.md` |
| `CREATING-DOMAIN-PACK.md` | `CREATING-YOUR-OWN-HERMIT.md` |
| `CREATING-PROJECT-AGENT.md` | _(merged into CREATING-YOUR-OWN-HERMIT.md)_ |

**Section renames in SHELL.md / session reports:**

| Old | New |
|-----|-----|
| `## Mission` | `## Task` |
| `## Steps` | `## Plan` |
| `\| Step \|` (column header) | `\| Plan Item \|` |
| `## Discoveries` | `## Findings` |
| `Missions Completed` | `Tasks Completed` |

**Terminology renames (docs, skills, agents):**

| Old | New |
|-----|-----|
| Domain pack | Hermit |
| Hermit agent | Hermit |
| Mission (session goal) | Task |
| Steps (ordered work items) | Plan |
| Discoveries | Findings |

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
