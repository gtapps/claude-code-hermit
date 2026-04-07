---
name: proposal-act
description: Accept, defer, or dismiss a proposal. For accepted proposals, asks how to proceed — create a session task or note for manual implementation. Activates on messages like "accept PROP-", "dismiss PROP-", "defer PROP-".
---
# Proposal Act

Take action on a proposal: accept, defer, or dismiss.

## Usage

```
/claude-code-hermit:proposal-act accept PROP-019
/claude-code-hermit:proposal-act defer PROP-015
/claude-code-hermit:proposal-act dismiss PROP-012
```

If no action or ID is provided, ask the operator which proposal and action.

## Timestamp Convention

All timestamps in frontmatter and Operator Decision text use ISO 8601 with timezone offset (e.g., `2026-04-06T14:30:00+01:00`). Use the timezone from `config.json` if set, otherwise UTC.

## Accept Flow

When the operator accepts a proposal:

1. Read the proposal file from `.claude-code-hermit/proposals/PROP-NNN.md`
2. Update the YAML frontmatter: set `status` to `accepted`, add `accepted_date` and `resolved_date` as timestamps. If the file uses old bullet-point metadata (`- **Status:**`), update that instead.
2b. **First-response tracking:** Check if the proposal's `responded` field is already `true`. If `false`: set `responded: true` in frontmatter, then append a `responded` event:
   ```
   node ${CLAUDE_PLUGIN_ROOT}/scripts/append-metrics.js .claude-code-hermit/state/proposal-metrics.jsonl '{"ts":"<now ISO>","type":"responded","proposal_id":"PROP-NNN","action":"accept"}'
   ```
   Then call `node ${CLAUDE_PLUGIN_ROOT}/scripts/generate-summary.js .claude-code-hermit/state/`. If `responded` is already `true`, skip the append (prevents double-counting).
3. Append a timestamp to the Operator Decision section:
   ```
   Accepted on 2026-04-06T14:30:00+01:00.
   ```

3a. **Session tracking:** Read `state/runtime.json`. If `session_id` is non-null, set `accepted_in_session` to that session ID in the proposal's YAML frontmatter. If no session is active (`session_id` is null), leave `accepted_in_session: null`.

3b. **Routine proposals.** If the proposal metadata contains `Type: routine` and a `## Config` section with a JSON block:
    - Parse the JSON block. Validate: must have `id`, `time`, `skill`, `enabled` fields.
    - Check for duplicate `id` in existing `config.json` routines array — if found, update the existing entry instead of appending.
    - If no duplicate found, append the routine entry to `config.json` routines array.
    - Respond: "Routine '{id}' added to config. The routine watcher picks it up within 60 seconds."
    - Notify the operator.
    - Skip step 4 — no further implementation needed.

4. Ask: **"How should this be implemented?"**
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
     Confirm: "Task prepared. The next `/session-start` will offer this as the default task."

   - **"I'll handle it manually"** → Just mark accepted. Respond: "Marked as accepted. No further action taken."

4b. **Skill creation proposals.** If the accepted proposal contains a `## Skill Improvement` section OR the proposal title/body indicates a new skill should be created:
    - Check if `/skill-creator` is available (plugin installed)
    - If available AND operator chose "Create a session task":
      - Append to the NEXT-TASK.md suggested plan: "Use `/skill-creator` to build and validate the skill. Run `/skill-creator eval` after creation to verify quality."
      - Note in the task context: "This proposal was flagged for skill-creator — use it for structured iteration instead of manual SKILL.md edits."
    - If `/skill-creator` is not available:
      - Proceed normally (manual implementation or direct SKILL.md edits)
      - Note: "skill-creator not installed — skill changes will be applied directly."

5. Notify the operator: "PROP-NNN accepted: [title]"

**Note:** There is no "Update OPERATOR.md" path. OPERATOR.md is operator-owned — the agent reads it but does not modify it. If the operator wants to update OPERATOR.md based on a proposal, they do it themselves.

## Defer Flow

1. Read the proposal file
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

1. Read the proposal file
2. Update the YAML frontmatter: set `status` to `dismissed`, add `dismissed_date` and `resolved_date` as timestamps. If the file uses old bullet-point metadata (`- **Status:**`), update that instead.
2b. **First-response tracking:** Same as accept flow — check `responded` field, set to `true` if `false`, append `responded` event with `"action":"dismiss"`, call `generate-summary.js`. Skip if already `true`.
3. Ask: "Reason for dismissal?" (optional — operator can skip)
4. If a reason is provided, append to the Operator Decision section:
   ```
   Dismissed on 2026-04-06T14:30:00+01:00. Reason: [operator's reason]
   ```
5. Respond: "PROP-NNN dismissed."

Dismissed proposals are hidden from the default `/proposal-list` view. Use "show all" with `/proposal-list` to see them.
