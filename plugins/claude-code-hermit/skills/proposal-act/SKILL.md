---
name: proposal-act
description: 'Accept, defer, dismiss, or resolve a proposal. For accepted proposals, asks how to proceed: start implementing now, create a session task, or note for manual implementation. Activates on messages like "accept PROP-", "dismiss PROP-", "defer PROP-", "resolve PROP-".'
---
# Proposal Act

Take action on a proposal: accept, defer, dismiss, or resolve.

## Usage

```
/claude-code-hermit:proposal-act accept PROP-019
/claude-code-hermit:proposal-act defer PROP-015
/claude-code-hermit:proposal-act dismiss PROP-012
/claude-code-hermit:proposal-act resolve PROP-008
```

If no action or ID is provided, ask the operator which proposal and action.

## Resolving a Proposal ID

Before reading any proposal file, resolve the operator's input to a filename using this algorithm:

1. Trim whitespace and uppercase the input.
2. Match against `/^PROP-(\d+)(?:-(.+))?$/`. If no match: error "Not a PROP id."
3. Zero-pad the integer to 3 digits (e.g. `PROP-6` → `PROP-006`).
4. Build the glob pattern. Always anchor: never use bare `PROP-NNN*.md` (collides with 4-digit NNN files like `PROP-0061.md` once proposal counts cross 1000).
   - If no suffix (e.g. `PROP-006`): glob two anchored patterns and union the results: `PROP-006.md` (legacy exact match) plus `PROP-006-*.md` (new-format files with that integer).
   - If suffix present (e.g. `PROP-006-103612` or `PROP-006-capability-brainstorm-103612`): glob `PROP-006-*<suffix>*.md`. The leading `-*` brackets the slug for timestamp-only inputs; the trailing wildcard catches the `a`/`b`/… collision-suffix variant. The disambiguation prompt resolves any over-matches.
5. Glob `.claude-code-hermit/proposals/<pattern>` (or each pattern in turn for the two-pattern no-suffix case, then union).
6. Count the matches:
   - **0 matches**: error "No proposal matches [input]. Use /proposal-list to see available proposals."
   - **1 match**: proceed with that file.
   - **2+ matches**: show a disambiguation prompt:
     ```
     Multiple proposals match PROP-NNN:
       PROP-NNN-capability-brainstorm-103612 — [title of first match]
       PROP-NNN-session-cost-tracking-104207 — [title of second match]
     Reply with the full ID to continue.
     ```
     Re-resolve with the operator's reply.

## Timestamp Convention

All timestamps in frontmatter and Operator Decision text use ISO 8601 with timezone offset (e.g., `2026-04-06T14:30:00+01:00`). Use the timezone from `config.json` if set, otherwise UTC.

## Accept Flow

When the operator accepts a proposal:

1. Resolve the proposal file using the resolution algorithm above, then read it.
2. Update the YAML frontmatter: set `status` to `accepted`, add `accepted_date` as timestamp. Do NOT set `resolved_date` — resolution happens when reflect confirms the pattern is gone. If the file uses old bullet-point metadata (`- **Status:**`), update that instead.
2b. **First-response tracking:** Check if the proposal's `responded` field is already `true`. If `false`: set `responded: true` in frontmatter, then append a `responded` event:
   ```
   node ${CLAUDE_PLUGIN_ROOT}/scripts/append-metrics.js .claude-code-hermit/state/proposal-metrics.jsonl '{"ts":"<now ISO>","type":"responded","proposal_id":"PROP-NNN","action":"accept"}'
   ```
   Then call `node ${CLAUDE_PLUGIN_ROOT}/scripts/generate-summary.js .claude-code-hermit/state/`. If `responded` is already `true`, skip the append (prevents double-counting).
3. Append a timestamp to the Operator Decision section:
   ```
   Accepted on 2026-04-06T14:30:00+01:00.
   ```

3a. **Session tracking:** Read `state/runtime.json` for `session_id` and `session_state` (both are used below). If `session_id` is non-null, set `accepted_in_session` to that session ID in the proposal's YAML frontmatter. If no session is active (`session_id` is null), leave `accepted_in_session: null`.

3b. **Routine proposals.** If the proposal metadata contains `Type: routine` and a `## Config` section with a JSON block:
    - Parse the JSON block. Validate: must have `id`, `schedule`, `skill`, `enabled` fields.
    - Check for duplicate `id` in existing `config.json` routines array — if found, update the existing entry instead of appending.
    - If no duplicate found, append the routine entry to `config.json` routines array.
    - Respond: "Routine '{id}' added to config. Run `/claude-code-hermit:hermit-routines load` to register it immediately."
    - Notify the operator.
    - Skip step 4 — no further implementation needed.

4. Ask: **"How should this be implemented?"**

   - **"Start implementing now"** (default, typical answer): handle session lifecycle, then execute in this turn.
     a. Use the `session_state` already read from `state/runtime.json` in step 3a to branch.
     b. **Idle:** delegate to `claude-code-hermit:session-mgr` to transition to `in_progress` and fill SHELL.md Task as "Implement PROP-NNN: <title>". Proceed to (e).
     c. **In progress:** confirm before switching: "Currently working on: <current task>. Switch to PROP-NNN? Y/N".
        - Yes: append `[HH:MM] switched to PROP-NNN: <title> (prior task: <prior task>)` to SHELL.md `## Progress Log`; overwrite SHELL.md `Task:` field with "Implement PROP-NNN: <title>"; `runtime.json session_state` stays `in_progress`. Proceed to (e).
        - No: fall back to "Create a session task" below.
     d. **Waiting:** fall back to "Create a session task" without asking, then notify: "PROP-NNN queued. Session is currently waiting."
     e. Read the proposal body and execute the Proposed Solution as the active task. If the body contains `## Skill Improvement`, use `/skill-creator` for the implementation. If the body is vague, ask the operator for clarification before proceeding.
     e.5. **Quality gate (tier-branched).** Read `.claude-code-hermit/config.json` → `quality_gate.tier`. Resolve per this table:

         | Config state | Resolved tier |
         |---|---|
         | `tier` is `"budget"` / `"balanced"` / `"quality"` | use as-is |
         | `tier` missing, `quality_gate` missing, or value not in enum | `budget` (log one-line warning to SHELL.md Findings) |

         Build a touched-files list from the writes you made during step (e) if you can reliably enumerate them. This is the precise scope for `/code-review` and for the judge. If you can't recall the list (multi-turn work, sub-agent delegation), omit it; downstream falls back to `git diff --name-only HEAD`.

         Branch on the resolved tier:

         - **`budget`**: skip `/code-review` entirely. Proceed to (f). Resolution notification stays plain: "PROP-NNN implemented and resolved."
         - **`quality`**: invoke `/code-review` directly. Pass the touched-files list as focus when enumerable:
           ```
           /code-review focus on PROP-NNN implementation: path/a, path/b
           ```
           Otherwise invoke `/code-review` with no focus; it falls back to git diff. `/code-review` is read-only (since CC 2.1.146) and emits a JSON array of `{file, line, summary, failure_scenario}` findings. Parse it. For each finding, Edit-apply when the fix is unambiguous from `summary` + `failure_scenario` (e.g. off-by-one, missing null guard, `=` vs `==`); otherwise surface. When in doubt, surface. Track `M` (total), `N` (applied), `K = M − N`. On JSON parse failure, fall back to "surfaced (apply skipped — output not parseable)" — never block resolution.

           Resolution notification: "PROP-NNN implemented and resolved. /code-review applied N/M findings (K surfaced)." When `M == 0`: "… /code-review surfaced 0 findings."
         - **`balanced`**: delegate to `claude-code-hermit:quality-gate-judge` with:
           ```
           Proposal: <absolute path to PROP-NNN-*.md>
           Touched-Files: <space-separated relative paths>   (omit this line if not reliably enumerable)
           ```
           Parse line-1 verdict:
           - `RUN: <reason>` → invoke `/code-review` with the touched-files focus (or no focus if omitted), classify and Edit-apply per the `quality` tier above. Notification: "PROP-NNN implemented and resolved. Judge: <reason>. /code-review applied N/M findings."
           - `SKIP: <reason>` → skip `/code-review`. Notification: "PROP-NNN implemented and resolved. Judge skipped /code-review: <reason>."

         **No post-apply test gate fires before step f resolves** — the operator authorized the accept; broken applies ship unless the operator runs `/claude-code-dev-hermit:dev-quality` afterwards.

         Best-effort throughout: if any step errors out (judge fails, `/code-review` errors, JSON parse fails, file read fails), log a one-line warning to SHELL.md Findings and fall back to skip. The gate never blocks resolution.
     f. When verifiably done: run `/proposal-act resolve PROP-NNN`, then notify the operator (or channel in autonomous mode) with the tier-appropriate message from (e.5).

   - **"Create a session task"** → Write `.claude-code-hermit/sessions/NEXT-TASK.md`:
     ```markdown
     # Next Task (from PROP-NNN)

     ## Task
     [One-line task derived from the proposal's Proposed Solution]

     ## Context
     [Summary of the pattern/problem from the proposal, including Related Sessions]

     ## Suggested Plan
     1. [Step derived from Proposed Solution]
     2. [Step derived from Proposed Solution]
     3. Verify the fix resolves the pattern
     ```
     If `NEXT-TASK.md` already exists: do **not** write. Status still flips to `accepted` (operator intent is recorded). Notify: "PROP-NNN accepted. NEXT-TASK is already pending another proposal. Run `/session-start` to consume it first, then re-run `/proposal-act accept PROP-NNN` and pick 'Start implementing now' or manual."
     Otherwise write the file. Then append any of the following bullets to the end of the Suggested Plan, in order, numbered sequentially from `4.` (quality-gate bullet is last so `/code-review` reviews any skill-creator output):
       - **(if the proposal contains `## Skill Improvement` AND `/skill-creator` is available)** `Use /skill-creator to build and validate the skill.`
       - **(if `quality_gate.tier` in `.claude-code-hermit/config.json` is not `"budget"` — i.e. `"balanced"` or `"quality"`)** `Run /code-review on the touched files for a quality review, then commit.`
     Confirm: "Task prepared. The next `/session-start` will offer this as the default task."

   - **"I'll handle it manually"** → Just mark accepted. Respond: "Marked as accepted. No further action taken."

5. Notify the operator: "PROP-NNN accepted: [title]"

**Note:** There is no "Update OPERATOR.md" path. OPERATOR.md is operator-owned — the agent reads it but does not modify it. If the operator wants to update OPERATOR.md based on a proposal, they do it themselves.

## Defer Flow

1. Resolve the proposal file using the resolution algorithm above, then read it.
2. Update the YAML frontmatter: set `status` to `deferred`, add `deferred_date` as timestamp. Do NOT set `resolved_date` — deferral is not a terminal state. If the file uses old bullet-point metadata (`- **Status:**`), update that instead.
2b. **First-response tracking:** Same as accept flow — check `responded` field, set to `true` if `false`, append `responded` event with `"action":"defer"`, call `generate-summary.js`. Skip if already `true`.
3. Ask: "Any note on why it's deferred or when to revisit?" (optional — operator can skip)
4. If a note is provided, append to the Operator Decision section:
   ```
   Deferred on 2026-04-06T14:30:00+01:00. Reason: [operator's note]
   ```
5. Respond: "PROP-NNN deferred."

Deferred proposals still appear in `/proposal-list` but are sorted below open proposals.

## Dismiss Flow

1. Resolve the proposal file using the resolution algorithm above, then read it.
2. Update the YAML frontmatter: set `status` to `dismissed`, add `dismissed_date` and `resolved_date` as timestamps. If the file uses old bullet-point metadata (`- **Status:**`), update that instead.
2b. **First-response tracking:** Same as accept flow — check `responded` field, set to `true` if `false`, append `responded` event with `"action":"dismiss"`, call `generate-summary.js`. Skip if already `true`.
3. Ask: "Reason for dismissal?" (optional — operator can skip)
4. If a reason is provided, append to the Operator Decision section:
   ```
   Dismissed on 2026-04-06T14:30:00+01:00. Reason: [operator's reason]
   ```
5. Respond: "PROP-NNN dismissed."

Dismissed proposals are hidden from the default `/proposal-list` view. Use "show all" with `/proposal-list` to see them.

## Resolve Flow

Used when reflect has surfaced a sparse-cadence proposal as a resolution candidate (pattern absent from recent sessions but cadence too infrequent to auto-resolve). Also available directly: `/claude-code-hermit:proposal-act resolve PROP-NNN`.

1. Resolve the proposal file using the resolution algorithm above, then read it.
2. Update the YAML frontmatter: set `status` to `resolved`, `resolved_date` to current timestamp. Do NOT set `dismissed_date`. If the file uses old bullet-point metadata (`- **Status:**`), update that instead.
3. Append a `resolved` event to proposal-metrics.jsonl:
   ```
   node ${CLAUDE_PLUGIN_ROOT}/scripts/append-metrics.js .claude-code-hermit/state/proposal-metrics.jsonl '{"ts":"<now ISO>","type":"resolved","proposal_id":"PROP-NNN"}'
   ```
4. Append to the Operator Decision section:
   ```
   Resolved on 2026-04-06T14:30:00+01:00.
   ```
   If the resolve was triggered by reflect's auto-resolve flow (pattern absent from recent sessions), the caller may append "Pattern confirmed absent." but this is no longer the default — resolve also covers implementation completion via the Start-now branch.
5. Respond: "PROP-NNN resolved."

No first-response tracking on resolve — the proposal was already accepted and that event was already logged.
