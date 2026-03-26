---
name: session
description: Start or resume a work session with full context loading and task tracking. Use at the beginning of work.
disable-model-invocation: true
---
# Session

Start or resume a session with full context loading. This is the generic session workflow — hermits may provide specialized versions (e.g., `/claude-code-dev-hermit:dev-session` for software development with code review and testing).

## Workflow

### 1. Start or resume

Invoke `/claude-code-hermit:session-start` to check session state and load context.

### 2. If resuming an active session

- Show: task, progress (completed/remaining plan items), and blockers
- If the session status is `blocked`: suggest running `/debug` to diagnose tool/hook failures before re-attempting
- Ask: "Continue this task, or start a new one?"

### 3. If starting a new session

- Ask: "What's the task for this session?"
- The session-start skill handles tags and budget prompts

### 4. Plan the work

After the task is established:
- Propose an ordered plan to accomplish the task
- Confirm the plan with the operator before starting work

### 5. Execute

Work through plan items using whatever tools, skills, and agents are available:
- Use the tools best suited to each step
- Update `.claude/.claude-code-hermit/sessions/SHELL.md` after each significant step (mark plan items done, add progress log entries)
- If a step is blocked, document the blocker in SHELL.md and ask the operator how to proceed

### 6. Task complete

When the task is complete, or the operator decides to move on (even if partial or blocked):

1. Finalize SHELL.md — ensure all progress, blockers, and findings are recorded
2. Verify quality: task status is accurate (`completed` | `partial` | `blocked`), changed files listed, cost recorded
3. Create proposals for any high-leverage improvements discovered during work
4. Invoke the `pattern-detect` skill (skips if fewer than 3 prior reports)
5. Use `session-mgr` to perform an **idle transition** (archive report, reset task-scoped sections, set status to `idle`)
6. If `heartbeat.enabled` is true in config and heartbeat is not already running: start it (`/claude-code-hermit:heartbeat start`)
7. Report: "Task archived as S-NNN. What's next?"
8. Once the operator provides a new task: go to step 4 (plan the work)

To close the session entirely, the operator runs `/claude-code-hermit:session-close` at any time.

## Notes

- This skill does NOT prescribe a specific quality workflow (no tests, no code review, no /simplify). Those belong to domain-specific session skills.
- If you discover something worth operationalizing during work, use `/claude-code-hermit:proposal-create`.
- For monitoring recurring checks during a session, use `/claude-code-hermit:monitor`.
- Check session status anytime with `/claude-code-hermit:status`.
