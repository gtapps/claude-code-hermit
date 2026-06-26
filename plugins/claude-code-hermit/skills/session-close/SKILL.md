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

> **Tool note:** `claude-code-hermit:session-mgr` is a **subagent** — invoke it via the Agent tool, never the Skill tool. The `plugin:name` form it shares with skills does not imply the Skill tool.

---

## Full Shutdown

Use this when the operator wants to end everything (via `hermit-stop` or explicit `--shutdown`).

### Auto-close path (`--auto`)

When invoked with `--auto` by heartbeat, skip steps 1–5 and jump directly to step 6 (shutdown_skill), step 7 (Tasks cleanup), step 8 (session-mgr archive), step 9 (pending-close cleanup), and step 10 (context-reset marker). Pass this templated payload to session-mgr:

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
8. Archive the session via `claude-code-hermit:session-mgr` (full close — finalize SHELL.md and replace with fresh template in one operation).
   Before invoking session-mgr: read `session_id` from `.claude-code-hermit/state/runtime.json`. Run `bun ${CLAUDE_PLUGIN_ROOT}/scripts/session-cost.ts <session_id>` via Bash and parse the JSON output to get `cost_usd` and `tokens` for this session. If the script fails or returns zeros, omit the `Cost:` line (session-mgr will fall back to `.status.json`).
   Pass the following compact structured payload in the prompt — keep it brief, no freeform prose:
   ```
   Status: <completed|partial|blocked>
   Blockers: <one line each, or none>
   Lessons: <one line each, or none>
   Changed: <file list, or none>
   Artifacts: <wikilinks to compiled/ outputs produced this session, or none>
   Cost: $X.XXXX (N tokens)
   Closed Via: <operator|auto>
   Next Start Point: <one line>
   ```
   Also include the task table (if native Tasks were created).
9. **Pending-close cleanup (both paths).** After the session-mgr archive returns success, delete `.claude-code-hermit/state/pending-close.json` if it exists (`rm -f` — ignore if absent). Any pending midnight-drain flag is invalidated by a successful close, regardless of trigger; without this step a flag queued before an operator-invoked close would survive and the next session's first heartbeat tick could fire `AUTO_CLOSE` against it.
10. **Context-reset marker (`--auto` only, after step 9 success).** Write `.claude-code-hermit/state/clear-requested.json`:
    ```json
    { "requested_at": "<utc ISO>", "reason": "daily-auto-close" }
    ```
    Skip on archive failure (step 9 is skipped too — the marker inherits the archive-success precondition). Skip on operator-invoked closes entirely — only the `--auto` path writes this. The watchdog reads it on the next tick and sends `/clear` when the session is still alive + idle + unattended, resetting the stale conversation context before the next scheduled wake incurs a cold cache-write. `/clear` preserves CronCreate routines and Monitor tasks; no re-arm is needed.

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
