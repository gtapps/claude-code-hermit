---
name: session
description: Start or resume a work session with full context loading and work tracking. Use at the beginning of work.
disable-model-invocation: true
---
# Session

Start or resume a session with full context loading. This is the generic session workflow — hermits may provide specialized versions.

## Workflow

### 1. Start or resume

Invoke `/claude-code-hermit:session-start` to check session state and load context.

### 2. If resuming an active session

- Call `TaskList` to see current plan steps
- Show: task, progress (completed/remaining tasks), and blockers
- If the session status is `blocked`: suggest running `/debug` to diagnose tool/hook failures before re-attempting
- Ask: "Continue this, or start something new?"

### 3. If starting a new session

- Ask: "What should I help with?"
- The session-start skill handles tags and budget prompts

### 4. Plan the work

Once I know what to work on:
- Propose an ordered plan to get it done
- Confirm the plan with the operator before starting work
- For multi-step work: create a native Task (`TaskCreate`) for each step
- For quick single-step tasks: skip `TaskCreate`

### 5. Execute

Work through tasks using whatever tools, skills, and agents are available:
- Use the tools best suited to each step
- Mark tasks in progress (`TaskUpdate`) when starting each step, completed when done
- Update `.claude-code-hermit/sessions/SHELL.md` Progress Log after each significant step
- If a step is blocked, document the blocker in SHELL.md and ask the operator how to proceed

### 6. Work done

When the work is done, or the operator decides to move on (even if partial or blocked):

1. Finalize SHELL.md — ensure all progress, blockers, and findings are recorded
2. Verify quality: task status is accurate (`completed` | `partial` | `blocked`), changed files listed, cost recorded
3. Create proposals for any high-leverage improvements discovered during work
4. **Reflect (with debounce).** Read `state/reflection-state.json` for `last_reflection`. Only invoke the `claude-code-hermit:reflect` skill if `last_reflection` is null or older than 4 hours. For quick tasks (no tasks created, under 5 minutes), skip entirely — progress log is sufficient.
4b. **Session-triggered plugin checks.** For each `plugin_checks` entry (from config already loaded) with `trigger: "session"` and `enabled: true`, invoke the skill. Skip for quick tasks (no tasks created, under 5 minutes). If a skill is unavailable or errors, skip it and continue — never block session finalization on a plugin check failure. For each check that completed successfully, read-modify-write `state/reflection-state.json`: update only `plugin_checks.<id>.last_run` to today's ISO date, preserving all other keys. Do not update `last_run` for failed checks.
5. If native Tasks exist: call `TaskList`, format as a markdown table. Then `TaskUpdate(status=deleted)` for all tasks (idle = clean slate).
6. Use `claude-code-hermit:session-mgr` to perform an **idle transition** (archive report, reset task-scoped sections, set status to `idle`). session-mgr handles updating both SHELL.md (cosmetic) and `state/runtime.json` (lifecycle truth). Pass the task table in the prompt for the archived report.
7. If `heartbeat.enabled` is true in config and heartbeat is not already running: start it (`/claude-code-hermit:heartbeat start`)
8. Notify the operator: "Archived as S-NNN. Task: [summary]. Status: [outcome]. Ready for what's next."
9. Once the operator says what's next: go to step 4 (plan the work)

To close the session entirely, the operator runs `/claude-code-hermit:session-close` at any time.

## Notes

- This skill does NOT prescribe a specific quality workflow (no tests, no code review, no /simplify). Those belong to domain-specific session skills.
- If you discover something worth operationalizing during work, use `/claude-code-hermit:proposal-create`.
- For watching recurring checks during a session, use `/claude-code-hermit:watch`.
- Check session status anytime with `/claude-code-hermit:pulse`.
