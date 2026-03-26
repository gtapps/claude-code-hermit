# Changelog

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
- **15 skills**: session, session-start, session-close, status, brief, monitor, heartbeat, hermit-settings, proposal-create, proposal-list, proposal-act, pattern-detect, channel-responder, init, upgrade
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
