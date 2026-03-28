---
name: session-close
description: Closes the current work session with a structured handoff. Archives the session report and prepares for the next session. Activates on messages like "I'm done", "wrap it up", "that's it for now", "done for today", "close the session".
---
# Session Close

## Close Mode

`/session-close` is always a **Full Shutdown**. The operator explicitly invoked it — that's the confirmation. No close mode decision, no prompting.

Idle transitions happen automatically at task boundaries (handled by the `session` skill). By the time the operator runs `/session-close`, they want out.

If heartbeat is running, stop it before archiving.

---

## Full Shutdown

Use this when the operator wants to end everything (via `hermit-stop` or explicit `--shutdown`).

1. Use the `session-mgr` agent to finalize `.claude-code-hermit/sessions/SHELL.md`
2. Ensure all progress is recorded with plan-level status (`done`, `blocked`, `planned`)
3. Document any blockers with enough context for the next session to understand them without re-investigating
4. Record lessons learned — only genuinely useful ones, not obvious statements
5. If any high-leverage improvements were discovered during work, create proposals via the `proposal-create` skill
6. Confirm the "Next Start Point" is clear enough for a fresh session to resume without questions
7. Invoke the `reflect` skill to reflect on accumulated experience. Reflect no longer requires archived reports — it uses memory. This runs before archiving so any findings are included in the archived report.
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

If any check fails, fix it before closing.
