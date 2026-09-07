---
name: session
description: Start or resume a work session with full context loading and work tracking. Use at the beginning of work.
---
# Session

Start or resume a session with full context loading. This is the generic session workflow — hermits may provide specialized versions.

## Workflow

### 1. Start or resume

Invoke `/claude-code-hermit:session-start` to check session state, load context, and select the task. If it stops for recovery, a collision, or operator input, stop here.

### 2. If resuming an active session

Use the task, progress, and blockers established by `session-start`. Do not repeat its resume question or reload the same context.

### 3. If starting a new session

- **Always-on** (`config.always_on` is `true`) with no task known: there is no operator to ask, so do **not** ask. Report readiness; the next task arrives from the channel, a routine, or a queued NEXT-TASK.md.
- `session-start` owns task selection and tags. Continue once it has established a task; do not ask for it again.

### 4. Plan the work

Once I know what to work on:
- State an ordered plan and proceed within the task's existing authorization. Ask only for missing information, a material scope change, or an explicit approval gate.
- For multi-step work: record the ordered steps in the SHELL.md Progress Log — it is the plan of record
- For quick single-step tasks: no plan entry needed

### 5. Execute

Work through tasks using whatever tools, skills, and agents are available:
- Use the tools best suited to each step
- Append a timestamped `.claude-code-hermit/sessions/SHELL.md` Progress Log entry as each step lands — one entry per significant step, so the plan and its progress stay legible after compaction or a restart
- If a step is blocked, try permitted alternatives and continue independent work. Document unresolved blockers in SHELL.md `## Blockers`; ask the operator only for the decision or access needed to proceed. When it clears, **prefix that line with `~ `, never delete it**: this stops current-blocker injection while retaining the resolved record in the archive.

### 6. Work done

When the work is done, or the operator decides to move on (even if partial or blocked):

**Completion notification is the final step of this flow, not a substitute for it.** Skipping the idle transition (step 5 below) leaves the session `in_progress`, which triggers stale-session heartbeat alerts and delays report archival until the time-based backstops kick in.

1. Finalize the factual record on disk, then compile judgment data **in context**. `session-archive.ts` owns the report write and reads the same factual baseline in every archive mode:
   - Ensure SHELL.md `## Blockers` reflects the final recorded state. It remains the factual floor. Payload Blockers can add missing facts or annotate a recorded blocker as resolved, but cannot erase recorded text.
   - `Status:` one of `completed` | `partial` | `blocked`
   - `Blockers:` optional additions, one line each. Use `~ <prefix>` to mark the first trimmed, case-insensitive prefix match in SHELL.md `## Blockers` resolved. The report keeps the full recorded text as `- [resolved] <recorded text>`; an unmatched `~` line becomes an ordinary addition with the tilde removed.
   - `Lessons:` only genuinely useful ones
   - `Changed:` list of files modified
   - `Artifacts:` optional `[[compiled/...]]` links not already recorded in SHELL.md or found by the session-stamped scan
2. Verify quality in-context before archiving:
   - Verify the requested result against current files, artifacts, or command results. Mark `completed` only when the task's completion criteria hold; record failed or skipped verification with a `partial` or `blocked` result.
   - Changed files are identified
   - SHELL.md `## Blockers` has enough context for a cold start
3. Carry improvements outside the authorized task into reflect's tier gates; they do not block completion of the requested work.
4. **Reflect.** Invoke the `claude-code-hermit:reflect` skill; its precheck decides whether anything is due. For quick single-step tasks, skip entirely — progress log is sufficient.
4b. **Session-triggered scheduled checks.** For each `scheduled_checks` entry (from config already loaded) with `trigger: "session"` and `enabled: true`, invoke the skill. If a skill is unavailable or errors, skip it and continue — never block session finalization on a scheduled check failure. For each check that completed successfully, run `bun ${CLAUDE_PLUGIN_ROOT}/scripts/update-reflection-state.ts .claude-code-hermit/state/reflection-state.json --scheduled-check-run <id>` (writes only that check's `last_run`; fail-open). Do not run it for failed checks.
5. Run `scripts/session-archive.ts` to perform an **idle transition** (finalize SHELL.md, archive report, reset task-scoped sections, set `session_state` to `idle`). It derives cost itself from the cost-log window — no `Cost:` line to compute or pass.
   Pipe the following compact structured payload on stdin — keep it brief, no freeform prose:
   ```
   bun ${CLAUDE_PLUGIN_ROOT}/scripts/session-archive.ts archive --mode=idle --state-dir=.claude-code-hermit <<'HERMIT_PAYLOAD'
   Status: <completed|partial|blocked>
   Blockers: <optional additions, ~ <prefix> resolutions, or none>
   Lessons: <one line each, or none>
   Changed: <file list, or none>
   Artifacts: <optional [[compiled/...]] additions, or none>
   HERMIT_PAYLOAD
   ```
   Parse the single line of JSON the script prints to stdout. On success, `merged_payload_fields` lists which optional `Blockers` or `Artifacts` fields added report content; `[]` means SHELL.md and the stamped artifact scan already contained everything. **Gate every following step on the returned `ok` field.** `ok === true` → the transition succeeded, continue to step 6. `ok === false` → the archive did NOT happen, so do not proceed as if it did. Append the returned `reason` to SHELL.md `## Findings` and retry once; if it fails again, notify the operator and leave the session `in_progress` rather than silently losing the report. On success the idle archive has also written `state/compact-requested.json` (`markers.compact_requested` in its output), which lets the watchdog's routine-hygiene compactor waive its interval cooldown once; the marker self-reaps, and `session-start` step 3 deletes any survivor on boot.
6. If `heartbeat.enabled` is true in config and heartbeat is not already running: start it (`/claude-code-hermit:heartbeat start`)
7. After the idle transition (step 5) succeeds (`ok === true`), check `.claude-code-hermit/sessions/NEXT-TASK.md` and read `escalation` from config:

   **Delivery-moment voice rule for both branches below:** compose the notification in owner language — no `S-NNN`, no internal IDs, no file paths, no slash commands. Lead with what was delivered. If this task produced a durable `compiled/` output (you already know this from your own context — it's whatever you just wrote this task, the same thing session-archive.ts is about to cite in `## Artifacts`), name it plainly in one clause (e.g. "Done — investigated the login bug. Prepared: a summary of what's causing it."). If the task produced no `compiled/` deliverable, state the one-line outcome instead (e.g. "Done — fixed the login redirect bug.").

   - **A task is queued AND `escalation` is `balanced` or `autonomous`:** notify the operator: "Done — [task]. [Prepared: <deliverable> | <one-line outcome>]. Starting on [NEXT-TASK.md summary] next." Then, as the terminal action of this flow, invoke `/claude-code-hermit:session-start` (no `--task` flag — it consumes `NEXT-TASK.md` itself via its own step 6). Do not perform any further steps of this invocation's flow after invoking it. Under `autonomous`, once that drained task completes, re-run this Work-done flow on it in turn (same as the heartbeat's queued-task pickup) — never leave it silently `in_progress` with only a bare notification.
   - **Otherwise** (no task queued, or `escalation` is `conservative`): notify the operator: "Done — [task]. [Prepared: <deliverable> | <one-line outcome>]." Append "Ready for what's next." **only when no task is queued** — omit that tail under `conservative` with a task queued, since a task IS pending and the tail would falsely imply an empty queue. Under `conservative` with a task queued: leave `NEXT-TASK.md` in place — do not auto-start it, do not mention the queued task here, and do not write to `runtime.json` from this flow (session_state/waiting_reason writes belong to session-archive.ts/heartbeat/channel-responder, not this skill). The heartbeat owns the single operator-facing queue notice: its next tick notifies about the queued task and sets `waiting`.
8. Once the operator says what's next (or, in the auto-start branch above, once the drained task's own plan is underway): go to step 4 (plan the work)

To close the session entirely, the operator runs `/claude-code-hermit:session-close` at any time.

## Notes

- This skill does NOT prescribe a specific quality workflow (no tests, no /simplify). Those belong to domain-specific session skills.
- If you discover something worth operationalizing during work, use `/claude-code-hermit:proposal-create`.
- For watching recurring checks during a session, use `/claude-code-hermit:watch`.
- Check session status anytime with `/claude-code-hermit:brief`.
