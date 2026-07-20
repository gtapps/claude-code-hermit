---
name: session
description: Start or resume a work session with full context loading and work tracking. Use at the beginning of work.
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
- The session-start skill handles tags

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

**Completion notification is the final step of this flow, not a substitute for it.** Skipping the idle transition (step 6 below) leaves the session `in_progress`, which triggers stale-session heartbeat alerts and delays report archival until the time-based backstops kick in.

1. Compile final session data **in context** — do NOT write to SHELL.md at this point. `session-archive.ts` owns the final write. Gather:
   - `Status:` one of `completed` | `partial` | `blocked`
   - `Blockers:` one line each, enough context for a cold start
   - `Lessons:` only genuinely useful ones
   - `Changed:` list of files modified
2. Verify quality in-context before archiving:
   - Task status is one of `completed` | `partial` | `blocked`
   - Changed files are identified
   - Blockers have enough context for a cold start
3. Create proposals for any high-leverage improvements discovered during work
4. **Reflect (with debounce).** Read `state/reflection-state.json` for `last_reflection`. Only invoke the `claude-code-hermit:reflect` skill if `last_reflection` is null or older than 4 hours. For quick tasks (no tasks created, under 5 minutes), skip entirely — progress log is sufficient.
4b. **Session-triggered scheduled checks.** For each `scheduled_checks` entry (from config already loaded) with `trigger: "session"` and `enabled: true`, invoke the skill. If a skill is unavailable or errors, skip it and continue — never block session finalization on a scheduled check failure. For each check that completed successfully, run `bun ${CLAUDE_PLUGIN_ROOT}/scripts/update-reflection-state.ts .claude-code-hermit/state/reflection-state.json --scheduled-check-run <id>` (writes only that check's `last_run`; fail-open). Do not run it for failed checks.
5. If native Tasks exist: call `TaskList`, format as a markdown table. Then `TaskUpdate(status=deleted)` for all tasks (idle = clean slate).
6. Run `scripts/session-archive.ts` to perform an **idle transition** (finalize SHELL.md, archive report, reset task-scoped sections, set `session_state` to `idle`). It derives cost itself from the cost-log window — no `Cost:` line to compute or pass.
   Pipe the following compact structured payload on stdin — keep it brief, no freeform prose:
   ```
   bun ${CLAUDE_PLUGIN_ROOT}/scripts/session-archive.ts archive --mode=idle --state-dir=.claude-code-hermit <<'HERMIT_PAYLOAD'
   Status: <completed|partial|blocked>
   Blockers: <one line each, or none>
   Lessons: <one line each, or none>
   Changed: <file list, or none>
   ## Plan
   <task table, if native Tasks were created>
   HERMIT_PAYLOAD
   ```
   Parse the single line of JSON the script prints to stdout. **Gate every following step on the returned `ok` field.** `ok === true` → the transition succeeded, continue to step 7. `ok === false` → the archive did NOT happen — do not proceed as if it did. Append the returned `reason` to SHELL.md `## Findings` and retry once; if it fails again, notify the operator and leave the session `in_progress` rather than silently losing the report.
7. If `heartbeat.enabled` is true in config and heartbeat is not already running: start it (`/claude-code-hermit:heartbeat start`)
7b. **Compaction boundary marker** *(now automatic)*. The step-6 idle archive itself wrote `state/compact-requested.json` (see `markers.compact_requested` in its output) — the archived arc is fully on disk, so the watchdog's routine-hygiene compactor (`maybeContextCompact`) may waive its interval cooldown on the next tick. The marker is self-reaping: `maybeContextCompact` consumes it when the compaction fires and deletes it stale-on-read past `COMPACT_MARKER_TTL_SECS`, and `session-start` step 3 unconditionally deletes any survivor on boot as a backstop. Nothing to do here.
8. After the idle transition (step 6) succeeds (`ok === true`), check `.claude-code-hermit/sessions/NEXT-TASK.md` and read `escalation` from config:

   **Delivery-moment voice rule for both branches below:** compose the notification in owner language — no `S-NNN`, no internal IDs, no file paths, no slash commands. Lead with what was delivered. If this task produced a durable `compiled/` output (you already know this from your own context — it's whatever you just wrote this task, the same thing session-archive.ts is about to cite in `## Artifacts`), name it plainly in one clause (e.g. "Done — investigated the login bug. Prepared: a summary of what's causing it."). If the task produced no `compiled/` deliverable, state the one-line outcome instead (e.g. "Done — fixed the login redirect bug.").

   - **A task is queued AND `escalation` is `balanced` or `autonomous`:** notify the operator: "Done — [task]. [Prepared: <deliverable> | <one-line outcome>]. Starting on [NEXT-TASK.md summary] next." Then, as the terminal action of this flow, invoke `/claude-code-hermit:session-start` (no `--task` flag — it consumes `NEXT-TASK.md` itself via its own step 6). Do not perform any further steps of this invocation's flow after invoking it. Under `autonomous`, once that drained task completes, re-run this Work-done flow on it in turn (same as heartbeat's existing autonomous NEXT-TASK pickup) — never leave it silently `in_progress` with only a bare notification.
   - **Otherwise** (no task queued, or `escalation` is `conservative`): notify the operator: "Done — [task]. [Prepared: <deliverable> | <one-line outcome>]." Append "Ready for what's next." **only when no task is queued** — omit that tail under `conservative` with a task queued, since a task IS pending and the tail would falsely imply an empty queue. Under `conservative` with a task queued: leave `NEXT-TASK.md` in place — do not auto-start it, do not mention the queued task here, and do not write to `runtime.json` from this flow (session_state/waiting_reason writes belong to session-archive.ts/heartbeat/channel-responder, not this skill). The existing heartbeat Idle Agency drain owns the single operator-facing queue notice: on its next tick its conservative branch notifies about the queued task and sets `waiting`.
9. Once the operator says what's next (or, in the auto-start branch above, once the drained task's own plan is underway): go to step 4 (plan the work)

To close the session entirely, the operator runs `/claude-code-hermit:session-close` at any time.

## Notes

- This skill does NOT prescribe a specific quality workflow (no tests, no /claude-code-hermit:simplify). Those belong to domain-specific session skills.
- If you discover something worth operationalizing during work, use `/claude-code-hermit:proposal-create`.
- For watching recurring checks during a session, use `/claude-code-hermit:watch`.
- Check session status anytime with `/claude-code-hermit:brief`.
