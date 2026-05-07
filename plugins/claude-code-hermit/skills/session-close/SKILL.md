---
name: session-close
description: Closes the current work session with a structured handoff. Archives the session report and prepares for the next session. Activates on messages like "I'm done", "wrap it up", "that's it for now", "done for today", "close the session".
---
# Session Close

## Close Mode

`/session-close` is always a **Full Shutdown**. The operator explicitly invoked it — that's the confirmation. No close mode decision, no prompting.

Idle transitions happen automatically at task boundaries (handled by the `session` skill). By the time the operator runs `/session-close`, they want out.

If heartbeat is running, stop it before archiving.
If watches are registered (`state/monitors.runtime.json` has entries), stop all watches before archiving — invoke `/claude-code-hermit:watch stop --all`.

session-mgr handles updating both SHELL.md (cosmetic) and `state/runtime.json` (lifecycle truth) during archiving. For full shutdown, session-mgr sets `shutdown_completed_at` in runtime.json.

---

## Full Shutdown

Use this when the operator wants to end everything (via `hermit-stop` or explicit `--shutdown`).

1. Compile final session data **in context** — do NOT write to SHELL.md yet. session-mgr owns the final write. Gather:
   - `Status:` one of `completed` | `partial` | `blocked`
   - `Blockers:` one line each, enough context for a cold start
   - `Lessons:` only genuinely useful ones
   - `Changed:` list of files modified
   - `Artifacts:` if this session produced a durable output (research note, decision doc, audit summary), write it to `compiled/<type>-<slug>-<date>.md` with `session: S-NNN` in the frontmatter and list the wikilink here. Don't leave domain output wedged in SHELL.md Findings or a proposal body.
2. Ensure all native Tasks reflect their correct status (`completed`, `pending`)
3. Confirm the "Next Start Point" is clear enough for a fresh session to resume without questions
4. If any high-leverage improvements were discovered during work, create proposals via the `claude-code-hermit:proposal-create` skill
5. Invoke the `claude-code-hermit:reflect` skill to reflect on accumulated experience. Reflect no longer requires archived reports — it uses memory. This runs before archiving so any findings are included in the archived report.
6. If native Tasks exist: call `TaskList`, format as a markdown table. Then `TaskUpdate(status=deleted)` for completed tasks only — pending/in_progress tasks persist for next session.
7. Archive the session via `claude-code-hermit:session-mgr` (full close — finalize SHELL.md and replace with fresh template in one operation). Pass the following compact structured payload in the prompt — keep it brief, no freeform prose:
   ```
   Status: <completed|partial|blocked>
   Blockers: <one line each, or none>
   Lessons: <one line each, or none>
   Changed: <file list, or none>
   Artifacts: <wikilinks to compiled/ outputs produced this session, or none>
   Next Start Point: <one line>
   ```
   Also include the task table (if native Tasks were created).

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
