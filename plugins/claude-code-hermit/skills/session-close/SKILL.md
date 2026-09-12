---
name: session-close
description: Closes the current work session with a structured handoff. Archives the session report and prepares for the next session. Activates on messages like "I'm done", "wrap it up", "that's it for now", "done for today", "close the session". Also runs the midnight `--scheduled` decision (close now, queue, or noop) fired by the `daily-auto-close` routine.
---
# Session Close

## Close Mode

`/session-close` is always a **Full Shutdown**. The operator explicitly invoked it — that's the confirmation. No close mode decision, no prompting.

When invoked with `--auto` by heartbeat (either after 12h SHELL.md inactivity, or via the `daily-auto-close` pending-flag drain after a 10-min lull), the operator did not invoke it. The auto-close path bypasses summary-gathering, skips reflect (step 5), skips the heartbeat-stop step (step below), and stamps `closed_via: auto` in the archive frontmatter via the `session-archive.ts` payload; `session-archive.ts` itself clears `state/pending-close.json` and writes the context-reset marker after a successful archive.

Idle transitions happen automatically at task boundaries (handled by the `session` skill). By the time the operator runs `/session-close`, they want out.

If heartbeat is running, stop it before archiving. **Skip on `--auto`** — heartbeat is the caller; stopping its Monitor would prevent all future ticks.
If watches are registered (`state/monitors.runtime.json` has entries), stop all watches before archiving — invoke `/claude-code-hermit:watch stop --all`.

`scripts/session-archive.ts` handles updating both SHELL.md (cosmetic) and `state/runtime.json` (lifecycle truth) during archiving. For full shutdown, it sets `shutdown_completed_at` in runtime.json — but only if `shutdown_requested_at` is already non-null (`hermit-stop.ts`'s signal), so an unattended auto-close reusing this same "Full Shutdown" framing never falsely marks the always-on process as stopping.

---

## Full Shutdown

Use this when the operator wants to end everything (via `hermit-stop` or explicit `--shutdown`).

A pre-existing `shutdown_requested_at` is the caller's stamp — `hermit-stop` sets it and then sends this command (`hermit-stop.ts`). It is never evidence of a competing close; proceed with the close. Do not send a second `--shutdown` after one has completed: each archive run creates a new report (`session-archive` is not idempotent).

### Auto-close path (`--auto`)

When invoked with `--auto` by heartbeat, skip steps 1–5 and jump directly to step 6 (shutdown_skill) and step 7 (session-archive.ts archive — the script itself performs the marker bookkeeping on success). Pipe this templated payload on stdin to `session-archive.ts archive --mode=auto`:

```
Status: completed
Blockers: <optional additions, ~ <prefix> to mark a recorded blocker resolved, or none>
Lessons: none
Changed: <from session-diff.json if available, else none>
Artifacts: <optional [[compiled/...]] additions, or none>
Closed Via: auto
Next Start Point: Fresh start.
```

SHELL.md remains the factual floor. `Blockers:` can add facts but cannot erase its `## Blockers`; a `~ <prefix>` line marks the first trimmed, case-insensitive SHELL blocker prefix as `- [resolved] <recorded text>` in the report, and the next session does not inherit it. A blocker already marked `~ ` in SHELL.md is read the same way with no payload line at all — which is how an unattended close resolves one. An unmatched `~` line is kept as an ordinary blocker with the tilde removed. `Artifacts:` accepts only `[[compiled/...]]` links not already recorded in SHELL.md or found by the session-stamped scan.

If step 7 returns `ok === false`, no markers were written and `pending-close.json` is left in place automatically, so a later tick retries the drain. Both drainers share a backoff marker (`state/pending-close-drain.json`) and defer while an operator turn is open, so the retry is the first eligible heartbeat tick or routine poll after that window. The backoff is 30 minutes for the 60-second routine poll; the heartbeat drainer halves it once `heartbeat.every` reaches 30 minutes, so a slow heartbeat retries on its next tick rather than the one after it.

### Scheduled decision path (`--scheduled`)

Invoked by the `daily-auto-close` routine at `0 0 * * *` (local) — the midnight decision layer that decides whether to close now, queue, or do nothing. The routine prompt is prefixed `[hermit-routine:daily-auto-close]` so `scripts/record-operator-action.ts` does not bump `state/last-operator-action.json` (load-bearing: the decision verb reads that clock to decide whether to close now or queue).

1. Run the decision verb and parse its single JSON line:
   ```
   bun ${CLAUDE_PLUGIN_ROOT}/scripts/session-archive.ts auto-close-decision --state-dir=.claude-code-hermit
   ```
   The verb owns the whole branch table: it reads `session_state` and the operator-action clock, deletes a stale `pending-close.json` itself when there is nothing to close, writes a fresh queue flag itself when the operator is active, and fails open to close-now when the clock is missing or invalid (operator idle indefinitely). A corrupt or unreadable `runtime.json` maps to `noop`, not close-now — closing a session whose state is unknowable would be fail-destructive.
2. Branch on the returned `decision`:
   - **`noop`** — stop: do not notify the operator, do not write to `routine-metrics.jsonl`.
   - **`queued`** — stop. The `heartbeat.ts precheck` drain block emits `AUTO_CLOSE` on the next tick where the operator has been idle >10 minutes.
   - **`close-now`** — close directly by proceeding through the Auto-close path (`--auto`) above (steps 6–7, `Closed Via: auto`). Stop.
   - **`ok === false`** — append the returned `reason` to SHELL.md `## Findings` and stop; the routine retries next midnight.

This path is intentionally silent: no operator notification on queue or drain — the `Auto-closed S-NNN` signal from the `--auto` archive is the only operator-facing output. The 10-minute lull threshold lives in `scripts/lib/auto-close.ts`, shared by the decision verb, the heartbeat-precheck drain, and the watchdog post-close-clear backoff.

---

1. Finalize the factual record on disk, then compile judgment and handoff data **in context**. `session-archive.ts` owns the report write and reads the same factual baseline in every archive mode:
   - Ensure SHELL.md `## Task`, `## Findings`, and `## Blockers` reflect the final recorded state. These sections remain the factual floor. Payload Blockers can add missing facts or annotate a recorded blocker as resolved, but cannot erase recorded text. A blocker already marked `~ ` in SHELL.md needs no payload line — the archive reads the mark.
   - `Status:` one of `completed` | `partial` | `blocked`
   - `Blockers:` optional additions, one line each. Use `~ <prefix>` to mark the first trimmed, case-insensitive prefix match in SHELL.md `## Blockers` resolved. The report keeps the full recorded text as `- [resolved] <recorded text>` and the next session does not inherit it; an unmatched `~` line becomes an ordinary addition with the tilde removed. Additions are report-only — an ended session does not hand itself a new blocker.
   - `Task:` optional. It fills an empty recorded `## Task` (and is reported in `merged_payload_fields` when it does); a recorded Task always wins.
   - `Lessons:` only genuinely useful ones. Before compiling, run the close debrief — answer three self-directed questions:
     1. *"What did I build ad-hoc this session (throwaway scripts, repeated manual procedures, long waits a tool would remove) that should persist?"*
     2. *"What did I have to re-derive or re-discover that a compiled note or memory entry should have told me?"*
     3. *"Did a skill produce output this session that was wrong, incomplete, or had to be reworked — and which skill + why? (Exclude preference, scope, or context changes — only genuine quality defects count. Settled-endpoint calibrations are recorded at settlement via `skill-preference:<skill>` per the placement rule, not here.)"*
     One Lesson line per qualifying item, with quantified cost where known (e.g. `rebuilt wm pipeline in /tmp, 5 scripts, ~40 min/rerun`). If nothing qualifies, add nothing — no placeholder lines. These lines are the input procedure-capture recurs on (reflect reads `## Lessons` of archived reports).
     **For question 1** — on a positive answer that names a repeated manual procedure, also append one observations-ledger row. Name the slug for the capability the procedure provides (reflect § Procedure capture naming rule — no issue/PR numbers, error strings, dates, or `fix-<X>` phrasings):
     ```
     bun ${CLAUDE_PLUGIN_ROOT}/scripts/observations.ts observe .claude-code-hermit procedure-noticed --origin=own-work <<'HERMIT_OBSERVATION'
     procedure-noticed:<slug>
     HERMIT_OBSERVATION
     ```
     The row is a bare recurrence counter; the Lessons line carries the procedure content. Same fail-open / operator-close gate as question 3.
     **For question 2**: on a positive answer, write each item to its home now, before compiling the report:
     - **Harness fact or session-wide preference:** issue the standard "remember it" reflection named in step 5. The native flow updates an existing memory file when one covers the fact; an update rather than a create means the home already held it.
     - **Durable domain fact:** merge into the subject's `compiled/topic-<slug>.md` through the **Evolving subject** routing below. Put the fact in the body; `summary` stays a one-line subject description (the startup catalog prints only its first 100 characters). An already-present fact means the home already held it.
     Record what was re-derived, its cost where known, and the destination (`[[compiled/topic-<slug>]]` or the memory file slug) in the Lessons line, with the destination early and the line under 150 characters (the frontmatter digest clips there). If the home already held it, say so instead.
     ```
     now in [[compiled/topic-deploys]]: deploy needs a cache clear first, ~20 min
     ```
     **For question 3** — on a positive answer, for each defective skill: (a) record the what/why as a `## Lessons` line above (the durable content channel reflect reads at graduation); (b) append one observations-ledger counter row using the **canonical bare skill name** (read the `name:` frontmatter from `.claude/skills/<name>/SKILL.md`; strip any `claude-code-hermit:`/`<plugin>:` prefix; lowercase) — fail-open so the close never aborts:
     ```
     bun ${CLAUDE_PLUGIN_ROOT}/scripts/observations.ts observe .claude-code-hermit skill-correction --origin=own-work <<'HERMIT_OBSERVATION'
     skill-correction:<canonical-name>
     HERMIT_OBSERVATION
     ```
     The row is a bare recurrence counter; the Lessons line carries the reason content. Gated to operator-close — `--auto` skips step 1 and writes no correction rows. No `|| true` needed: a *rejected* row answers `ERROR|<reason>` on stdout at exit 0. (A *mis-invocation* — wrong verb, or a missing state dir or source — exits 1 on purpose so a broken call site is loud; read the usage line, fix the call, and carry on. Neither outcome aborts the close.)
   - `Changed:` list of files modified. Derive `Status:` and `Changed:` from this session's tool results (the diff, the files you wrote), not from what you intended to do.
   - `Artifacts:` if this session produced a durable output, route it by shape:
     - **Evolving subject** the hermit will touch again (a monitored domain, a recurring decision area, accumulated know-how): **update or create** `compiled/topic-<slug>.md`. Merge new findings into the existing sections rather than appending a dated copy; bump `updated`, refresh the one-line `summary`, keep the page under 150 lines (compact older material when merging), and cross-link related pages with `[[wikilinks]]`.
     - **One-off output** (point-in-time research note, decision doc, audit summary): write `compiled/<type>-<slug>-<date>.md` as before.
     Either way include `session: S-NNN` in the frontmatter. The archive discovers that exact session stamp, plus any `[[compiled/...]]` links already recorded in SHELL.md, and deduplicates them. The optional payload field accepts only `[[compiled/...]]` additions. Don't leave domain output wedged in SHELL.md Findings or a proposal body.
   - If this session shipped a fix or made a prediction whose outcome is only observable later, arm it with `/claude-code-hermit:later add` (hermit origin) and name it in the report.
2. Ensure the Progress Log reflects each step's final state (done, partial, blocked)
3. Confirm the "Next Start Point" is clear enough for a fresh session to resume without questions
4. If any high-leverage improvements were discovered during work, create proposals via the `claude-code-hermit:proposal-create` skill
5. Invoke the `claude-code-hermit:reflect` skill to reflect on accumulated experience. This runs before archiving so any findings are included in the archived report. **Skip on `--auto`** — during auto-close, `session_state` is still `in_progress`, which forces reflect-precheck into compute phase before the `closed_via: auto` filter can run; there is no operator-curated session content to reflect on anyway.
   If reflect returns `reflect: no candidates`, scan this session's `## Findings` and `## Progress Log` for non-obvious discoveries not already in memory and issue the standard "remember it" reflection for any that clear the auto-memory threshold. Apply WHAT_NOT_TO_SAVE as normal.
6. **Stop always-on services (`shutdown_skill`).** Read `shutdown_skill` from `.claude-code-hermit/config.json`. If non-null, invoke it as a skill command (the value may include arguments, e.g. `/serve stop`) via the Skill tool. **Best-effort:** on error or if the skill does not return, log a Monitoring line and continue to archival — never abort the close. Runs on both operator and `--auto` paths.
7. Archive the session via `scripts/session-archive.ts archive --mode=close` (full close — finalize SHELL.md and replace with fresh template in one operation). `session-archive.ts` derives cost itself from the cost-log window — no `Cost:` line to compute or pass.
   Pipe the following compact structured payload on stdin — keep it brief, no freeform prose:
   ```
   bun ${CLAUDE_PLUGIN_ROOT}/scripts/session-archive.ts archive --mode=close --state-dir=.claude-code-hermit <<'HERMIT_PAYLOAD'
   Status: <completed|partial|blocked>
   Blockers: <optional additions, ~ <prefix> resolutions, or none>
   Lessons: <one line each, or none>
   Changed: <file list, or none>
   Artifacts: <optional [[compiled/...]] additions, or none>
   Closed Via: <operator|auto>
   Next Start Point: <one line>
   HERMIT_PAYLOAD
   ```
   Parse the single line of JSON printed to stdout. On success, `merged_payload_fields` lists which optional `Blockers` or `Artifacts` fields added report content; `[]` means SHELL.md and the stamped artifact scan already contained everything. **`ok === false`** means the archive did NOT happen: no markers were written. Surface the returned `reason` to the operator and retry once before giving up. On success the script has also deleted `state/pending-close.json` (a successful close invalidates any pending midnight-drain flag, regardless of trigger) and, on `--auto`, written `state/clear-requested.json`, which the watchdog reads on its next tick to send `/clear` while the session is still alive, idle, and unattended (`/clear` preserves CronCreate routines and Monitor tasks); both are reported in its `markers` output field.

---

## Quality Check Before Closing

Verify these before proceeding with close (applies to both modes):

- [ ] If `## Completed` claims a deliverable that a skill persists to `compiled/` (e.g. a deep-dive, briefing, or decision doc), confirm the file exists with `session: S-NNN` frontmatter or is linked from SHELL.md. If it does not exist, the deliverable was dropped, so record that in `## Blockers` rather than leaving `## Completed` asserting success.
- [ ] If status is `blocked`: have you run `/debug` to check for tool/hook failures? Include diagnosis in blockers if relevant

**Full shutdown only:**
- [ ] Next Start Point is actionable — a fresh session can begin work immediately

If any check fails, fix it before closing.
