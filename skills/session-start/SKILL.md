---
name: session-start
description: Initializes or resumes a work session. Loads context from OPERATOR.md and SHELL.md, orients the agent, and establishes the task. Use at the beginning of every work session.
---
# Session Start

When starting a new session:

All state lives under `.claude/.claude-code-hermit/` in the project root.

1. Read `.claude/.claude-code-hermit/config.json` for agent identity settings (`agent_name`, `language`)
2. If the SessionStart hook output above includes "---Upgrade Available---", mention it to the operator. Do NOT block session start.
3. Use the `session-mgr` agent to check session state
3b. If session-mgr reports SHELL.md exists with Status `idle`:
   - This is a session between tasks — do NOT create a new session or SHELL.md
   - Present: session start date, tasks completed count, latest entry from Session Summary
   - Skip to step 5 (NEXT-TASK.md check) to determine the task source
   - When a task is provided: use `session-mgr` to set Status back to `in_progress`, fill in Task and Plan
   - The session ID remains unassigned until close (same as a fresh session)
   - If heartbeat is running, it continues
4. Read `.claude/.claude-code-hermit/OPERATOR.md` for project context and constraints
5. Check if `.claude/.claude-code-hermit/sessions/NEXT-TASK.md` exists. If it does:
   - Present the prepared task to the operator as the suggested task for this session
   - If the operator accepts it: use it as the task (skip asking "What's the task?")
   - If the operator provides a different task: delete `NEXT-TASK.md` and proceed with their task
   - Always delete `NEXT-TASK.md` after it has been presented (whether accepted or not)
6. Scan `.claude/.claude-code-hermit/proposals/` for files with `Source: auto-detected` and `Status: proposed`. If any exist, mention: "There are N unreviewed auto-detected proposal(s). Review with `/proposal-list` when ready." Do NOT block the session — this is a one-line notification only.
7. If `agent_name` is set, use it in the greeting (e.g., "Atlas reporting in." or "{name} a reportar." if language is `pt`). If `language` is set, communicate with the operator in that language for the rest of the session.
8. If resuming an existing session (Status is `in_progress`):
   - Present the current task, progress (completed/remaining plan items), and blockers
   - If the session status is `blocked`: suggest running `/debug` to diagnose tool/hook failures before re-attempting the blocked work
   - Ask the operator if they want to continue the current task or start a new one
8b. If resuming an idle session (Status is `idle`):
   - Show session continuity info: tasks completed, session duration, cumulative cost
   - Ask: "What's the next task?" (unless a NEXT-TASK.md was accepted in step 5)
   - Once provided, use `session-mgr` to update SHELL.md: set Status to `in_progress`, fill Task and Plan
9. If starting a new session:
   - Ask the operator: "What's the task for this session?" (unless a NEXT-TASK.md was accepted in step 5)
   - Once provided, use `session-mgr` to create the session with the task and initial plan
10. After task is established (new session only):
    - **Tags:** Ask "Any tags for this session? (e.g., refactor, frontend, urgent) Enter to skip." Write the answer to the `Tags:` field in SHELL.md. If skipped, leave blank.
    - **Budget:** Check `ask_budget` from the config read in step 1. If `ask_budget` is `true`:
      - Ask: "Set a cost budget for this task?"
        1. Set budget — enter a dollar amount → write `Budget: $X.XX` to SHELL.md
        2. No budget for this session — leave Budget field blank
        3. Never ask about budget — set `ask_budget` to `false` in config.json, leave Budget blank
    - If `ask_budget` is `false`: skip the budget prompt silently.
11. Identify the first actionable step and confirm with the operator before proceeding

## Context to Load

- `.claude/.claude-code-hermit/OPERATOR.md` (always)
- `.claude/.claude-code-hermit/sessions/SHELL.md` (if exists)
- Most recent `.claude/.claude-code-hermit/sessions/S-*-REPORT.md` (for continuity — only the latest one)

Do NOT load all session reports — only the most recent one.

## First Session on a Codebase

If this is the first session (no prior reports exist), explore the project structure using Glob and Read tools before proposing a plan. If a hermit provides a specialized orientation agent, prefer that instead.
