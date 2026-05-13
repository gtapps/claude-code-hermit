---
name: proposal-act
description: Accept, defer, dismiss, or resolve a proposal. For accepted proposals, asks how to proceed: start implementing now, create a session task, or note for manual implementation. Activates on messages like "accept PROP-", "dismiss PROP-", "defer PROP-", "resolve PROP-".
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
     f. When verifiably done: run `/proposal-act resolve PROP-NNN`, then notify the operator (or channel in autonomous mode): "PROP-NNN implemented and resolved. Summary: <one-line of what was done>."

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
     Otherwise write the file. If the proposal contains `## Skill Improvement` and `/skill-creator` is available, append to the Suggested Plan: "Use `/skill-creator` to build and validate the skill. Run `/skill-creator eval` after creation to verify quality." Confirm: "Task prepared. The next `/session-start` will offer this as the default task."

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
