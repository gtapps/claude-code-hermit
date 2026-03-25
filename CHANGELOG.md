# Changelog

## [0.0.2] - 2026-03-25

### Breaking Changes — Hermit Agent Authors Must Update

Core terminology and filenames have changed. Hermit agent plugins (e.g., `claude-code-dev-hermit`) must update their references to match.

**Filename renames:**

| Old | New |
|-----|-----|
| `sessions/ACTIVE.md` | `sessions/SHELL.md` |
| `ACTIVE.md.template` | `SHELL.md.template` |
| `NEXT-MISSION.md` | `NEXT-TASK.md` |
| `CREATING-DOMAIN-PACK.md` | `CREATING-HERMIT-AGENT.md` |
| `CREATING-PROJECT-AGENT.md` | _(merged into CREATING-HERMIT-AGENT.md)_ |

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
| Domain pack | Hermit agent |
| Mission (session goal) | Task |
| Steps (ordered work items) | Plan |
| Discoveries | Findings |

**What hermit agent authors need to do:**

1. Update all file path references: `sessions/ACTIVE.md` → `sessions/SHELL.md`
2. Update section references: `## Mission` → `## Task`, `## Steps` → `## Plan`, `## Discoveries` → `## Findings`
3. Update `NEXT-MISSION.md` → `NEXT-TASK.md` in any skill that reads/writes it
4. Update `CLAUDE-APPEND.md` to use new section names
5. Replace "domain pack" with "hermit agent" in docs and skill descriptions
6. Run `/claude-code-hermit:upgrade` in target projects to refresh templates

### Added
- **Session lifecycle docs** — Close Mode Decision Tree, Always-On Task Loop, When Self-Learning Fires (ALWAYS-ON-OPS.md sections 1b-1d)
- **Cross-references** — ARCHITECTURE.md and HOW-TO-USE.md link to the new lifecycle sections

### Changed
- **README rewrite** — new intro, Quick Start with channels step, "What It Does" / "What Makes It Different" / "Hermit Agents" sections
- **Consolidated docs** — CREATING-PROJECT-AGENT.md and CREATING-DOMAIN-PACK.md merged into CREATING-HERMIT-AGENT.md ("Build Your Own Hermit")
- **Trimmed generic content** — CREATING-HERMIT-AGENT.md now references official Claude Code plugin docs instead of duplicating frontmatter/hook/skill field tables

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
- **Documentation** — HOW-TO-USE, ARCHITECTURE, SKILLS, ALWAYS-ON-OPS, UPGRADING, TROUBLESHOOTING, CREATING-HERMIT-AGENT, OBSIDIAN-SETUP
