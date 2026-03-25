---
name: session-start
description: Initializes or resumes a work session. Loads context from OPERATOR.md and ACTIVE.md, orients the agent, and establishes the mission. Use at the beginning of every work session.
---
# Session Start

When starting a new session:

All state lives under `.claude/.claude-code-hermit/` in the project root.

1. Read `.claude/.claude-code-hermit/config.json` for agent identity settings (`agent_name`, `language`)
2. If the SessionStart hook output above includes "---Upgrade Available---", mention it to the operator. Do NOT block session start.
3. Use the `session-mgr` agent to check session state
3b. If session-mgr reports ACTIVE.md exists with Status `idle`:
   - This is an always-on session between missions — do NOT create a new session or ACTIVE.md
   - Present: session start date, missions completed count, latest entry from Session Summary
   - Skip to step 5 (NEXT-MISSION.md check) to determine the mission source
   - When a mission is provided: use `session-mgr` to set Status back to `in_progress`, fill in Mission and Steps
   - The session ID remains unassigned until close (same as a fresh session)
   - Heartbeat continues running (was never stopped)
4. Read `.claude/.claude-code-hermit/OPERATOR.md` for project context and constraints
5. Check if `.claude/.claude-code-hermit/sessions/NEXT-MISSION.md` exists. If it does:
   - Present the prepared mission to the operator as the suggested mission for this session
   - If the operator accepts it: use it as the mission (skip asking "What's the mission?")
   - If the operator provides a different mission: delete `NEXT-MISSION.md` and proceed with their mission
   - Always delete `NEXT-MISSION.md` after it has been presented (whether accepted or not)
6. Scan `.claude/.claude-code-hermit/proposals/` for files with `Source: auto-detected` and `Status: proposed`. If any exist, mention: "There are N unreviewed auto-detected proposal(s). Review with `/proposal-list` when ready." Do NOT block the session — this is a one-line notification only.
7. If `agent_name` is set, use it in the greeting (e.g., "Atlas reporting in." or "{name} a reportar." if language is `pt`). If `language` is set, communicate with the operator in that language for the rest of the session.
8. If resuming an existing session (Status is `in_progress`):
   - Present the current mission, progress (completed/remaining steps), and blockers
   - If the session status is `blocked`: suggest running `/debug` to diagnose tool/hook failures before re-attempting the blocked work
   - Ask the operator if they want to continue the current mission or start a new one
8b. If resuming an idle session (Status is `idle`):
   - Show session continuity info: missions completed, session duration, cumulative cost
   - Ask: "What's the next mission?" (unless a NEXT-MISSION.md was accepted in step 5)
   - Once provided, use `session-mgr` to update ACTIVE.md: set Status to `in_progress`, fill Mission and Steps
9. If starting a new session:
   - Ask the operator: "What's the mission for this session?" (unless a NEXT-MISSION.md was accepted in step 5)
   - Once provided, use `session-mgr` to create the session with the mission and initial steps
10. After mission is established (new session only):
    - **Tags:** Ask "Any tags for this session? (e.g., refactor, frontend, urgent) Enter to skip." Write the answer to the `Tags:` field in ACTIVE.md. If skipped, leave blank.
    - **Budget:** Check `ask_budget` from the config read in step 1. If `ask_budget` is `true` (default if missing):
      - Ask: "Set a cost budget for this mission?"
        1. Set budget — enter a dollar amount → write `Budget: $X.XX` to ACTIVE.md
        2. No budget for this session — leave Budget field blank
        3. Never ask about budget — set `ask_budget` to `false` in config.json, leave Budget blank
    - If `ask_budget` is `false`: skip the budget prompt silently.
11. Identify the first actionable step and confirm with the operator before proceeding

## Context to Load

- `.claude/.claude-code-hermit/OPERATOR.md` (always)
- `.claude/.claude-code-hermit/sessions/ACTIVE.md` (if exists)
- Most recent `.claude/.claude-code-hermit/sessions/S-*-REPORT.md` (for continuity — only the latest one)

Do NOT load all session reports — only the most recent one.

## First Session on a Codebase

If this is the first session (no prior reports exist), explore the project structure using Glob and Read tools before proposing steps. If a pack provides a specialized orientation agent (e.g., repo-mapper from claude-code-dev-hermit), prefer that instead.
