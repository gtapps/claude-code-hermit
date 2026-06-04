---
name: session-close
description: Closes the current work session with a structured handoff. Archives the session report and prepares for the next session. Activates on messages like "I'm done", "wrap it up", "that's it for now", "done for today", "close the session".
---
# Session Close

## Close Mode

`/session-close` is always a **Full Shutdown**. The operator explicitly invoked it — that's the confirmation. No close mode decision, no prompting.

When invoked with `--auto` by heartbeat (either after 12h SHELL.md inactivity, or via the `daily-auto-close` pending-flag drain after a 10-min lull), the operator did not invoke it. The auto-close path bypasses summary-gathering, skips reflect (step 5), skips the heartbeat-stop step (step below), stamps `closed_via: auto` in the archive frontmatter via the session-mgr payload, and clears `state/pending-close.json` after the archive succeeds.

Idle transitions happen automatically at task boundaries (handled by the `session` skill). By the time the operator runs `/session-close`, they want out.

If heartbeat is running, stop it before archiving. **Skip on `--auto`** — heartbeat is the caller; stopping its Monitor would prevent all future ticks.
If watches are registered (`state/monitors.runtime.json` has entries), stop all watches before archiving — invoke `/claude-code-hermit:watch stop --all`.

session-mgr handles updating both SHELL.md (cosmetic) and `state/runtime.json` (lifecycle truth) during archiving. For full shutdown, session-mgr sets `shutdown_completed_at` in runtime.json.

---

## Full Shutdown

Use this when the operator wants to end everything (via `hermit-stop` or explicit `--shutdown`).

### Auto-close path (`--auto`)

When invoked with `--auto` by heartbeat, skip steps 1–5 and jump directly to step 6 (shutdown_skill), step 7 (Tasks cleanup), step 8 (session-mgr archive), and step 9 (pending-close cleanup). Pass this templated payload to session-mgr:

```
Status: completed
Blockers: none
Lessons: none
Changed: <from session-diff.json if available, else none>
Artifacts: none
Closed Via: auto
Next Start Point: Fresh start.
```

Write `Auto-closed by heartbeat.` as the first line of `## Overview` in the session report.

If the archive in step 8 fails, leave `pending-close.json` in place so the next heartbeat tick retries the drain — skip step 9.

---

1. Compile final session data **in context** — do NOT write to SHELL.md yet. session-mgr owns the final write. Gather:
   - `Status:` one of `completed` | `partial` | `blocked`
   - `Blockers:` one line each, enough context for a cold start
   - `Lessons:` only genuinely useful ones
   - `Changed:` list of files modified
   - `Artifacts:` if this session produced a durable output (research note, decision doc, audit summary), write it to `compiled/<type>-<slug>-<date>.md` with `session: S-NNN` in the frontmatter and list the wikilink here. Don't leave domain output wedged in SHELL.md Findings or a proposal body.
2. Ensure all native Tasks reflect their correct status (`completed`, `pending`)
3. Confirm the "Next Start Point" is clear enough for a fresh session to resume without questions
4. If any high-leverage improvements were discovered during work, create proposals via the `claude-code-hermit:proposal-create` skill
5. Invoke the `claude-code-hermit:reflect` skill to reflect on accumulated experience. Reflect no longer requires archived reports — it uses memory. This runs before archiving so any findings are included in the archived report. **Skip on `--auto`** — during auto-close, `session_state` is still `in_progress`, which forces reflect-precheck into compute phase before the `closed_via: auto` filter can run; there is no operator-curated session content to reflect on anyway.
   If reflect returns `reflect: no candidates`, scan this session's `## Findings` and `## Progress Log` for non-obvious discoveries not already in memory and issue the standard "remember it" reflection for any that clear the auto-memory threshold. Apply WHAT_NOT_TO_SAVE as normal.
6. **Stop always-on services (`shutdown_skill`).** Read `shutdown_skill` from `.claude-code-hermit/config.json`. If non-null, invoke it as a skill command (the value may include arguments, e.g. `/serve stop`) via the Skill tool. **Best-effort:** on error or if the skill does not return, log a Monitoring line and continue to archival — never abort the close. Runs on both operator and `--auto` paths.
7. If native Tasks exist: call `TaskList`, format as a markdown table. Then `TaskUpdate(status=deleted)` for completed tasks only — pending/in_progress tasks persist for next session.
8. Archive the session via `claude-code-hermit:session-mgr` (full close — finalize SHELL.md and replace with fresh template in one operation). Pass the following compact structured payload in the prompt — keep it brief, no freeform prose:
   ```
   Status: <completed|partial|blocked>
   Blockers: <one line each, or none>
   Lessons: <one line each, or none>
   Changed: <file list, or none>
   Artifacts: <wikilinks to compiled/ outputs produced this session, or none>
   Closed Via: <operator|auto>
   Next Start Point: <one line>
   ```
   Also include the task table (if native Tasks were created).
9. **Pending-close cleanup (both paths).** After the session-mgr archive returns success, delete `.claude-code-hermit/state/pending-close.json` if it exists (`rm -f` — ignore if absent). Any pending midnight-drain flag is invalidated by a successful close, regardless of trigger; without this step a flag queued before an operator-invoked close would survive and the next session's first heartbeat tick could fire `AUTO_CLOSE` against it.

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
