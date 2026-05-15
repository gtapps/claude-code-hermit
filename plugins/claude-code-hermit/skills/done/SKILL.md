---
name: done
description: Clears the current focus and prepares the hermit for the next one. Appends a one-line entry to Recent Activity, clears Focus + Progress Log + Findings, compacts SHELL.md per config, marks idle-task complete if applicable. With `--shutdown`, signals the graceful-stop path. Replaces /session-close and /session. Activates on messages like "I'm done", "wrap it up", "that's it for now", "ready for next".
---
# Done

## Operator Notification
Notify the operator per the channel policy in CLAUDE.md (§ Operator Notification).

`/done` clears the current focus. The hermit stays running (it's a live focus dashboard — there is no "session" to end). To stop the daemon entirely, pass `--shutdown` or invoke `hermit-stop`.

## Workflow

1. **Compose summary line.** Take the optional summary string the operator passed inline. If absent, auto-generate from SHELL.md `## Focus` content + your assessment of completion:

   - Format: `[HH:MM] Done: <focus text, one line> (<success|partial|blocked>)`
   - Status rules: `success` = the focus achieved its stated goal; `partial` = some progress, more to do; `blocked` = unable to proceed and the blocker is documented in `## Findings`.

2. **Stop watches and heartbeat (only on `--shutdown`).** If `--shutdown` was passed AND `state/monitors.runtime.json` has entries, invoke `/claude-code-hermit:watch stop --all`. If the heartbeat is running, stop it.

3. **Create proposals.** If high-leverage improvements were discovered during the focus that aren't yet captured, invoke `/claude-code-hermit:proposal-create` per finding. Trivial fixes are exempt.

4. **Append to Recent Activity.** Use `claude-code-hermit:focus-mgr` to append the summary line from step 1 to SHELL.md `## Recent Activity`. focus-mgr handles compaction per `config.compact.recent_activity_threshold` / `recent_activity_keep`.

5. **Clear focus-scoped sections.** focus-mgr clears (or sets to placeholder):
   - `## Focus` → `<!-- Awaiting next focus -->`
   - `## Progress Log` → empty
   - `## Findings` → empty (including any `<!-- pending-recovery: ... -->` marker)
   - **Keep:** `## Monitoring`, `## Cost`, `## Artifacts`, `## Recent Activity`.

6. **Compact persistent sections.** focus-mgr compacts `## Monitoring` and `## Progress Log` per their thresholds. Recent Activity was already compacted in step 4.

7. **Idle-task checkoff.** If `runtime.idle_task` is set AND completion status is `success`:
   - Read `.claude-code-hermit/IDLE-TASKS.md`. Find the line matching `runtime.idle_task.text` (or by `line` index if text drifted).
   - Replace `- [ ]` with `- [x]` on that line.
   - Clear `runtime.idle_task` to `null`.

8. **Update runtime.json.** Set `session_state` to `idle`. Update `updated_at` to current UTC-Z ISO. Leave `last_shell_snapshot_at` untouched (separate subsystem).

9. **Native tasks.** If TaskList shows tasks: `TaskUpdate(status=deleted)` for all completed tasks. Pending/in_progress tasks remain for next focus.

10. **Shutdown flag.** If `--shutdown` was passed:
    - Set `runtime.shutdown_requested_at` to current UTC-Z ISO.
    - The hermit-stop.py path detects the request, completes the shutdown loop, sets `shutdown_completed_at`, and exits the tmux session.

11. **Confirm.** Tell the operator: "Focus cleared. Ready for next." (Or, on `--shutdown`: "Shutdown requested. Goodnight.")

## Non-Behaviors

`/done` does NOT:
- Generate an S-NNN report (historical artifact format, retired in PROP-031).
- Fire reflect (reflect runs as a daily routine — see `/reflect` or `config.routines`).
- Run session-triggered scheduled checks (those have their own routine cadence).
- Start heartbeat (heartbeat starts at boot via `hermit-start.py`).

## Quality Notes

- If the focus is `blocked`, the blocker description should already live in SHELL.md `## Findings`. The Recent Activity entry references the blocker context.
- For complex focus work, consider creating a proposal capturing the work via `/proposal-create` before invoking `/done` — the focus content disappears on clear.
- If the focus produced a durable artifact (research note, decision doc, audit), it should already be in `compiled/<type>-<slug>-<date>.md`. Reference it from `## Artifacts` before clearing.
