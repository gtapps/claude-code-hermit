---
name: session-start
description: Initializes or resumes a work session. Loads context from OPERATOR.md and SHELL.md, orients the agent, and establishes what to work on. Use at the beginning of every work session.
---
# Session Start

When starting a new session:

All state lives under `.claude-code-hermit/` in the project root.

1. Read `.claude-code-hermit/config.json` for agent identity settings (`agent_name`, `language`)
2. If the SessionStart hook output above includes "---Upgrade Available---", mention it to the operator. Do NOT block session start.
3. **Read `state/runtime.json`** for lifecycle state. This is the single source of truth — never parse SHELL.md `Status:` for decisions.
   - **Advisory lock check:** Try to acquire `state/.lifecycle.lock` non-blocking. If held by another process (hermit-start.py, hermit-stop.py, routine-watcher), tell the operator "A lifecycle operation is in progress — wait for it to complete" and abort.
   - **If runtime.json is missing:** This is either a first run or a pre-runtime.json installation. If SHELL.md exists, treat as a first session and proceed normally. If neither exists, this is a fresh installation — proceed to step 5.
   - **Interrupted transition recovery (P3):** If `transition` is not null, use `session-mgr` to resume the interrupted operation:
     - `transition == "archiving"` + target file missing → re-run archive
     - `transition == "archiving"` + target file exists → skip to SHELL.md cleanup
     - `transition == "cleaning"` → re-run SHELL.md cleanup
     - Notify the operator: "Recovered from interrupted [transition]. Session is now idle."
   - **Unclean shutdown detection:** If `last_error == "unclean_shutdown"`:
     - If `runtime_mode` is `tmux` or `docker`: "Previous session crashed without closing. SHELL.md may contain stale work."
     - If `runtime_mode` is `interactive`: "Previous interactive session was not closed cleanly."
     - Offer: (a) Archive the stale session as `partial` and start fresh, (b) Resume the stale session as-is
     - Clear `last_error` after the operator decides.
   - **Dead process detection:** If `session_state == "dead_process"`: treat the same as unclean shutdown — offer archive-and-restart or resume.
   - **Normal state:** If `session_state` is `idle` → ready for new task. If `in_progress` or `waiting` → existing session, offer resume.
4. Use the `session-mgr` agent to check session state and handle SHELL.md
4b. If session-mgr reports SHELL.md exists with Status `idle` (or runtime.json `session_state` is `idle`):
   - This is a session between tasks — do NOT create a new session or SHELL.md
   - Present: session start date, tasks completed count, latest entry from Session Summary
   - Skip to step 5 (NEXT-TASK.md check) to determine the task source
   - When a task is provided: use `session-mgr` to set Status back to `in_progress` (cosmetic in SHELL.md) and update runtime.json `session_state` to `in_progress`. Fill in Task. After confirming the plan with the operator, create native Tasks (`TaskCreate`) for each step.
   - The session ID is pre-computed in runtime.json (set by session-mgr on previous idle transition)
   - If heartbeat is running, it continues
5. Read `.claude-code-hermit/OPERATOR.md` for project context and constraints
6. Check if `.claude-code-hermit/sessions/NEXT-TASK.md` exists. If it does:
   - Present the prepared task to the operator as the suggested task for this session
   - If the operator accepts it: use it as the task (skip asking "What should I help with?")
   - If the operator provides a different task: delete `NEXT-TASK.md` and proceed with their task
   - Always delete `NEXT-TASK.md` after it has been presented (whether accepted or not)
7. Scan `.claude-code-hermit/proposals/` for files with `Source: auto-detected` and `Status: proposed`. If any exist, mention: "There are N unreviewed auto-detected proposal(s). Review with `/proposal-list` when ready." Do NOT block the session — this is a one-line notification only.
7b. **Interactive morning brief.** If `config.always_on` is `false` AND `config.routines` contains an enabled entry with skill containing `brief --morning`: run the morning brief inline — generate a brief emphasizing where things stand, pending proposals, and what's on deck. No dedup needed — interactive sessions are short-lived.
8. If `agent_name` is set, use it in the greeting (e.g., "Atlas reporting in." or "{name} a reportar." if language is `pt`). If `language` is set, communicate with the operator in that language for the rest of the session.
9. If resuming an existing session (runtime.json `session_state` is `in_progress` or `waiting`):
   - Call `TaskList` to see current plan steps. Present the current task, progress (completed/remaining tasks), and blockers.
   - If the session status is `blocked`: suggest running `/debug` to diagnose tool/hook failures before re-attempting the blocked work
   - Ask the operator if they want to continue the current task or start a new one
9b. If resuming an idle session (runtime.json `session_state` is `idle`):
   - Show session continuity info: tasks completed, session duration, cumulative cost
   - Ask: "What should I work on next?" (unless a NEXT-TASK.md was accepted in step 6)
   - Once provided, use `session-mgr` to update SHELL.md: set Status to `in_progress` (cosmetic), fill Task. Update runtime.json `session_state` to `in_progress`. After confirming the plan, create native Tasks for each step.
10. If starting a new session:
   - Ask the operator: "What should I help with?" (unless a NEXT-TASK.md was accepted in step 6)
   - Once provided, use `session-mgr` to create the session with the task. After confirming the plan, create native Tasks (`TaskCreate`) for each step.
11. Once I know what to work on (new session only):
    - **Tags:** Ask "Any tags for this session? (e.g., refactor, frontend, urgent) Enter to skip." Write the answer to the `Tags:` field in SHELL.md. If skipped, leave blank.
    - **Budget:** Check `ask_budget` from the config read in step 1. If `ask_budget` is `true`:
      - Ask: "Set a cost budget for this work?"
        1. Set budget — enter a dollar amount → write `Budget: $X.XX` to SHELL.md
        2. No budget for this session — leave Budget field blank
        3. Never ask about budget — set `ask_budget` to `false` in config.json, leave Budget blank
    - If `ask_budget` is `false`: skip the budget prompt silently.
12. Identify the first actionable step and confirm with the operator before proceeding

## Context to Load

- `.claude-code-hermit/OPERATOR.md` (always)
- `.claude-code-hermit/sessions/SHELL.md` (if exists)
- Most recent `.claude-code-hermit/sessions/S-*-REPORT.md` (for continuity — only the latest one)
- `.claude-code-hermit/state/runtime.json` (always — for lifecycle state)

Do NOT load all session reports — only the most recent one.

## First Session on a Codebase

If this is the first session (no prior reports exist), explore the project structure using Glob and Read tools before proposing a plan. If a hermit provides a specialized orientation agent, prefer that instead.
