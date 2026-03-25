---
name: proposal-act
description: Accept, defer, or dismiss a proposal. For accepted proposals, asks how to proceed — create a session task or note for manual implementation. Every auto-proposal requires operator action.
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

## Accept Flow

When the operator accepts a proposal:

1. Read the proposal file from `.claude/.claude-code-hermit/proposals/PROP-NNN.md`
2. Update the metadata: `**Status:** accepted`
3. Append a timestamp to the Operator Decision section:
   ```
   Accepted on YYYY-MM-DD.
   ```

4. Ask: **"How should this be implemented?"**
   - **"Create a session task"** → Write `.claude/.claude-code-hermit/sessions/NEXT-TASK.md`:
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

5. If channels are configured: send a brief notification: "PROP-NNN accepted: [title]"

**Note:** There is no "Update OPERATOR.md" path. OPERATOR.md is operator-owned — the agent reads it but does not modify it. If the operator wants to update OPERATOR.md based on a proposal, they do it themselves.

## Defer Flow

1. Read the proposal file
2. Update the metadata: `**Status:** deferred`
3. Ask: "Any note on why it's deferred or when to revisit?" (optional — operator can skip)
4. If a note is provided, append to the Operator Decision section:
   ```
   Deferred on YYYY-MM-DD. Reason: [operator's note]
   ```
5. Respond: "PROP-NNN deferred."

Deferred proposals still appear in `/proposal-list` but are sorted below open proposals.

## Dismiss Flow

1. Read the proposal file
2. Update the metadata: `**Status:** dismissed`
3. Ask: "Reason for dismissal?" (optional — operator can skip)
4. If a reason is provided, append to the Operator Decision section:
   ```
   Dismissed on YYYY-MM-DD. Reason: [operator's reason]
   ```
5. Respond: "PROP-NNN dismissed."

Dismissed proposals are hidden from the default `/proposal-list` view. Use "show all" with `/proposal-list` to see them.
