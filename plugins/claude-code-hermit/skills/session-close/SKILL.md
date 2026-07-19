---
name: session-close
description: Closes the current work session with a structured handoff. Archives the session report and prepares for the next session. Activates on messages like "I'm done", "wrap it up", "that's it for now", "done for today", "close the session". Also runs the midnight `--scheduled` decision (close now, queue, or noop) fired by the `daily-auto-close` routine.
---
# Session Close

## Close Mode

`/session-close` is always a **Full Shutdown**. The operator explicitly invoked it — that's the confirmation. No close mode decision, no prompting.

When invoked with `--auto` by heartbeat (either after 12h SHELL.md inactivity, or via the `daily-auto-close` pending-flag drain after a 10-min lull), the operator did not invoke it. The auto-close path bypasses summary-gathering, skips reflect (step 5), skips the heartbeat-stop step (step below), stamps `closed_via: auto` in the archive frontmatter via the `session-archive.ts` payload, and clears `state/pending-close.json` after the archive succeeds.

Idle transitions happen automatically at task boundaries (handled by the `session` skill). By the time the operator runs `/session-close`, they want out.

If heartbeat is running, stop it before archiving. **Skip on `--auto`** — heartbeat is the caller; stopping its Monitor would prevent all future ticks.
If watches are registered (`state/monitors.runtime.json` has entries), stop all watches before archiving — invoke `/claude-code-hermit:watch stop --all`.

`scripts/session-archive.ts` handles updating both SHELL.md (cosmetic) and `state/runtime.json` (lifecycle truth) during archiving. For full shutdown, it sets `shutdown_completed_at` in runtime.json — but only if `shutdown_requested_at` is already non-null (`hermit-stop.ts`'s signal), so an unattended auto-close reusing this same "Full Shutdown" framing never falsely marks the always-on process as stopping.

---

## Full Shutdown

Use this when the operator wants to end everything (via `hermit-stop` or explicit `--shutdown`).

### Auto-close path (`--auto`)

When invoked with `--auto` by heartbeat, skip steps 1–5 and jump directly to step 6 (shutdown_skill), step 7 (Tasks cleanup), step 8 (session-archive.ts archive), step 9 (pending-close cleanup), and step 10 (context-reset marker). Pipe this templated payload on stdin to `session-archive.ts archive --mode=auto`:

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

If step 8 returns `ok === false`, leave `pending-close.json` in place so the next heartbeat tick retries the drain — skip step 9.

### Scheduled decision path (`--scheduled`)

Invoked by the `daily-auto-close` routine at `0 0 * * *` (local) — the midnight decision layer that decides whether to close now, queue, or do nothing. The routine prompt is prefixed `[hermit-routine:daily-auto-close]` so `scripts/record-operator-action.ts` does not bump `state/last-operator-action.json` (load-bearing: this path reads that clock to decide whether to close now or queue).

1. Read `state/runtime.json` (`session_state`), `state/last-operator-action.json` (`at`), and whether `state/pending-close.json` exists.
2. Branch:
   - **a. `session_state` not in `{in_progress, idle}`** — nothing to close. If `pending-close.json` exists, delete it (`rm -f .claude-code-hermit/state/pending-close.json` — stale flag from a prior session that already closed). Stop: do not notify the operator, do not write to `routine-metrics.jsonl`.
   - **b. `session_state` in `{in_progress, idle}` AND `now - last_operator_action > 10min`** — safe lull; close directly by proceeding through the Auto-close path (`--auto`) above (steps 6–10, `Closed Via: auto`). Stop.
   - **c. `session_state` in `{in_progress, idle}` AND `now - last_operator_action ≤ 10min`** — operator is currently active; queue. Write `state/pending-close.json` with `{"queued_at":"<now ISO>","queued_by":"daily-auto-close"}` (singleton; overwrite unconditionally). Stop. The heartbeat-precheck drain block emits `AUTO_CLOSE` on the next tick where the operator has been idle >10 minutes.
3. If `last-operator-action.json` is absent, unreadable, or has no valid `at` timestamp: treat as "operator idle indefinitely" → take branch (b). Fail-open — better to close an arguably-active session than to leak the routine into perpetual noop.

This path is intentionally silent: no operator notification on queue or drain — the `Auto-closed S-NNN` signal from the `--auto` archive is the only operator-facing output. The 10-minute lull threshold is hardcoded here and in `scripts/heartbeat-precheck.ts`.

---

1. Compile final session data **in context** — do NOT write to SHELL.md yet. `session-archive.ts` owns the final write. Gather:
   - `Status:` one of `completed` | `partial` | `blocked`
   - `Blockers:` one line each, enough context for a cold start
   - `Lessons:` only genuinely useful ones. Before compiling, run the close debrief — answer three self-directed questions:
     1. *"What did I build ad-hoc this session (throwaway scripts, repeated manual procedures, long waits a tool would remove) that should persist?"*
     2. *"What did I have to re-derive or re-discover that a compiled note or memory entry should have told me?"*
     3. *"Did a skill produce output this session that was wrong, incomplete, or had to be reworked — and which skill + why? (Exclude preference, scope, or context changes — only genuine quality defects count.)"*
     One Lesson line per qualifying item, with quantified cost where known (e.g. `rebuilt wm pipeline in /tmp, 5 scripts, ~40 min/rerun`). Substantial re-derived knowledge goes to `compiled/` via the Artifacts bullet below instead of a Lesson line. If nothing qualifies, add nothing — no placeholder lines. These lines are the input procedure-capture recurs on (reflect reads `## Lessons` of archived reports).
     **For question 3** — on a positive answer, for each defective skill: (a) record the what/why as a `## Lessons` line above (the durable content channel reflect reads at graduation); (b) append one observations-ledger counter row using the **canonical bare skill name** (read the `name:` frontmatter from `.claude/skills/<name>/SKILL.md`; strip any `claude-code-hermit:`/`<plugin>:` prefix; lowercase) — fail-open so the close never aborts:
     ```
     bun ${CLAUDE_PLUGIN_ROOT}/scripts/append-metrics.ts .claude-code-hermit/state/observations.jsonl \
       '{"ts":"<now ISO>","pattern":"skill-correction:<canonical-name>","session_id":"<S-NNN>","source":"skill-correction","origin":"own-work"}' || true
     ```
     The row is a bare recurrence counter; the Lessons line carries the reason content. Gated to operator-close — `--auto` skips step 1 and writes no correction rows.
   - `Changed:` list of files modified
   - `Artifacts:` if this session produced a durable output, route it by shape:
     - **Evolving subject** the hermit will touch again (a monitored domain, a recurring decision area, accumulated know-how): **update or create** `compiled/topic-<slug>.md`. Merge new findings into the existing sections rather than appending a dated copy; bump `updated`, refresh the one-line `summary`, keep the page under 150 lines (compact older material when merging), and cross-link related pages with `[[wikilinks]]`.
     - **One-off output** (point-in-time research note, decision doc, audit summary): write `compiled/<type>-<slug>-<date>.md` as before.
     Either way include `session: S-NNN` in the frontmatter and list the wikilink here. Don't leave domain output wedged in SHELL.md Findings or a proposal body.
2. Ensure all native Tasks reflect their correct status (`completed`, `pending`)
3. Confirm the "Next Start Point" is clear enough for a fresh session to resume without questions
4. If any high-leverage improvements were discovered during work, create proposals via the `claude-code-hermit:proposal-create` skill
5. Invoke the `claude-code-hermit:reflect` skill to reflect on accumulated experience. Reflect no longer requires archived reports — it uses memory. This runs before archiving so any findings are included in the archived report. **Skip on `--auto`** — during auto-close, `session_state` is still `in_progress`, which forces reflect-precheck into compute phase before the `closed_via: auto` filter can run; there is no operator-curated session content to reflect on anyway.
   If reflect returns `reflect: no candidates`, scan this session's `## Findings` and `## Progress Log` for non-obvious discoveries not already in memory and issue the standard "remember it" reflection for any that clear the auto-memory threshold. Apply WHAT_NOT_TO_SAVE as normal.
6. **Stop always-on services (`shutdown_skill`).** Read `shutdown_skill` from `.claude-code-hermit/config.json`. If non-null, invoke it as a skill command (the value may include arguments, e.g. `/serve stop`) via the Skill tool. **Best-effort:** on error or if the skill does not return, log a Monitoring line and continue to archival — never abort the close. Runs on both operator and `--auto` paths.
7. If native Tasks exist: call `TaskList`, format as a markdown table. Then `TaskUpdate(status=deleted)` for completed tasks only — pending/in_progress tasks persist for next session.
8. Archive the session via `scripts/session-archive.ts archive --mode=close` (full close — finalize SHELL.md and replace with fresh template in one operation). `session-archive.ts` derives cost itself from the cost-log window — no `Cost:` line to compute or pass.
   Pipe the following compact structured payload on stdin — keep it brief, no freeform prose:
   ```
   bun ${CLAUDE_PLUGIN_ROOT}/scripts/session-archive.ts archive --mode=close --state-dir=.claude-code-hermit <<'HERMIT_PAYLOAD'
   Status: <completed|partial|blocked>
   Blockers: <one line each, or none>
   Lessons: <one line each, or none>
   Changed: <file list, or none>
   Artifacts: <wikilinks to compiled/ outputs produced this session, or none>
   Closed Via: <operator|auto>
   Next Start Point: <one line>
   ## Plan
   <task table, if native Tasks were created>
   HERMIT_PAYLOAD
   ```
   Parse the single line of JSON printed to stdout. **`ok === false`** means the archive did NOT happen — do not proceed to step 9/10 as if it did; surface the returned `reason` to the operator and retry once before giving up.
9. **Pending-close cleanup (both paths).** After step 8 returns `ok === true`, delete `.claude-code-hermit/state/pending-close.json` if it exists (`rm -f` — ignore if absent). Any pending midnight-drain flag is invalidated by a successful close, regardless of trigger; without this step a flag queued before an operator-invoked close would survive and the next session's first heartbeat tick could fire `AUTO_CLOSE` against it.
10. **Context-reset marker (`--auto` only, after step 9 success).** Write `.claude-code-hermit/state/clear-requested.json`:
    ```json
    { "requested_at": "<utc ISO>", "reason": "daily-auto-close" }
    ```
    Skip on archive failure (`ok === false` — step 9 is skipped too, the marker inherits the archive-success precondition). Skip on operator-invoked closes entirely — only the `--auto` path writes this. The watchdog reads it on the next tick and sends `/clear` when the session is still alive + idle + unattended, resetting the stale conversation context before the next scheduled wake incurs a cold cache-write. `/clear` preserves CronCreate routines and Monitor tasks; no re-arm is needed.

---

## Quality Check Before Closing

Verify these before proceeding with close (applies to both modes):

- [ ] Tags from SHELL.md are copied to the session report's Tags field
- [ ] Task status is accurate (`completed` | `partial` | `blocked`)
- [ ] All changed files are listed in the Changed section
- [ ] Blockers are described with enough context for a cold start
- [ ] Cost data is recorded (if available from the cost-tracker hook)
- [ ] If `## Completed` claims a deliverable that a skill persists to `compiled/` (e.g. a deep-dive, briefing, or decision doc), confirm it appears in `## Artifacts`. If it doesn't, verify whether the output actually reached `compiled/`: if it did, add it to `## Artifacts`; if it didn't, the deliverable was dropped, so record it in `## Blockers` rather than leaving `## Completed` asserting success.
- [ ] If status is `blocked`: have you run `/debug` to check for tool/hook failures? Include diagnosis in blockers if relevant

**Full shutdown only:**
- [ ] Next Start Point is actionable — a fresh session can begin work immediately

If any check fails, fix it before closing.
