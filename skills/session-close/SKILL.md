---
name: session-close
description: Closes the current work session with a structured handoff. Archives the session report and prepares for the next session. Use at the end of every work session.
---
# Session Close

When closing a session, first determine the close mode, then follow the appropriate path.

## Determine Close Mode

1. Read `.claude/.claude-code-hermit/config.json` and check `always_on`
2. Check if the operator provided an explicit intent:
   - `--shutdown`, "full close", or "shutdown" → **Full Shutdown**
   - `--idle`, "task complete", or "idle" → **Idle Transition**
3. If no explicit intent:
   - If `always_on` is `true`: default to **Idle Transition**
   - If `always_on` is `false` or missing: default to **Full Shutdown**
4. Confirm with the operator, showing the default: "Task complete. [Idle transition / Full shutdown]?" In unattended mode (no operator response within context), use the default.

---

## Idle Transition (task complete, session stays open)

Use this when the task is done but the session should remain open for the next task. Heartbeat, monitors, and channels continue running.

1. Use the `session-mgr` agent to finalize `.claude/.claude-code-hermit/sessions/SHELL.md`
2. Ensure all progress is recorded with plan-level status (`done`, `blocked`, `planned`)
3. Document any blockers with enough context for the next task to understand them
4. Record lessons learned — only genuinely useful ones, not obvious statements
5. If any high-leverage improvements were discovered during work, create proposals via the `proposal-create` skill
6. Invoke the `pattern-detect` skill to analyze recent session reports for recurring patterns. If pattern-detect skips (fewer than 3 prior reports), proceed to the next step.
7. Use `session-mgr` to perform the **idle transition** (see "On Task Complete" in session-mgr):
   - Archive the task report as S-NNN-REPORT.md
   - Reset task-specific sections in SHELL.md (Task, Plan, Progress Log, Blockers, Findings, Changed)
   - Preserve session-scoped sections (Monitoring, Cost, Session Summary)
   - Set Status to `idle`, increment Tasks Completed
   - Append one-line summary to Session Summary
8. Report to the operator: "Task archived as S-NNN. Session idle — send a new task via channel or type it here."

---

## Full Shutdown

Use this when the operator wants to end everything (via `hermit-stop` or explicit `--shutdown`).

1. Use the `session-mgr` agent to finalize `.claude/.claude-code-hermit/sessions/SHELL.md`
2. Ensure all progress is recorded with plan-level status (`done`, `blocked`, `planned`)
3. Document any blockers with enough context for the next session to understand them without re-investigating
4. Record lessons learned — only genuinely useful ones, not obvious statements
5. If any high-leverage improvements were discovered during work, create proposals via the `proposal-create` skill
6. Confirm the "Next Start Point" is clear enough for a fresh session to resume without questions
7. Invoke the `pattern-detect` skill to analyze recent session reports for recurring patterns. This runs before archiving so the `## Patterns Detected` section is included in the archived report. If pattern-detect skips (fewer than 3 prior reports), proceed to the next step.
8. Archive the session via `session-mgr` (full close — replace SHELL.md with fresh template)

---

## Quality Check Before Closing

Verify these before proceeding with close (applies to both modes):

- [ ] Tags from SHELL.md are copied to the session report's Tags field
- [ ] Task status is accurate (`completed` | `partial` | `blocked`)
- [ ] All changed files are listed in the Changed section
- [ ] Blockers are described with enough context for a cold start
- [ ] Cost data is recorded (if available from the cost-tracker hook)
- [ ] If status is `blocked`: have you run `/debug` to check for tool/hook failures? Include diagnosis in blockers if relevant

**Full shutdown only:**
- [ ] Next Start Point is actionable — a fresh session can begin work immediately

**Idle transition:** skip the Next Start Point check — the session stays open and Session Summary captures the task outcome.

If any check fails, fix it before closing.
