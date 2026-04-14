---
name: proposal-list
description: Lists all proposals with their status, source, and age. Shows auto-detected proposals prominently. Activates on messages like "what have you noticed", "any improvements", "any proposals", "show proposals".
---
# Proposal List

Lists all proposals with status, source, and age. Auto-detected proposals (from the learning loop) are listed first.

## Plan

### 1. Read all proposals

Read all files matching `.claude-code-hermit/proposals/PROP-*.md`.

If no proposals exist: respond "No proposals found." and stop.

### 2. Parse metadata

For each proposal, extract metadata. If the file starts with `---` (YAML frontmatter), read fields from frontmatter: `id`, `status`, `source`, `session`, `created`, `related_sessions`, `category`. Extract the title from the `# Proposal: PROP-NNN — [Title]` heading.

If the file does not start with `---` (pre-Observatory format), fall back to parsing markdown bullet metadata:
- **ID:** from filename (PROP-NNN)
- **Status:** from `**Status:**` line
- **Source:** from `**Source:**` line (default `manual` if missing — older proposals may not have this field)
- **Created:** from `**Created:**` line
- **Session:** from `**Session:**` line
- **Related Sessions:** from `**Related Sessions:**` line (if present)
- **Title:** from the `# Proposal: PROP-NNN — [Title]` heading

### 3. Calculate age

Determine the current session number from the highest S-NNN-REPORT.md in `sessions/`. Calculate age as the difference between current session number and the session number in the proposal's `Session` field. Display as "N sessions ago".

### 4. Display as table

```
| ID       | Status   | Source        | Category    | Age          | Summary                          |
|----------|----------|---------------|-------------|--------------|----------------------------------|
| PROP-020 | proposed | auto-detected | improvement | 1 session    | [tag-correlation] Frontend blocked |
| PROP-019 | proposed | auto-detected | routine     | 3 sessions   | [blocker] Test env recurring     |
| PROP-015 | proposed | manual        | improvement | 12 sessions  | ⚠ Refactor auth module           |
| PROP-012 | accepted | manual        | capability  | 20 sessions  | Add retry logic                  |
```

Ordering:
1. Auto-detected proposals first (Source: auto-detected), then manual
2. Within each group: open (proposed) first, then accepted, then deferred
3. Within each status: newest first

Stale proposals (open for 10+ sessions) get a ⚠ prefix on the summary line.

### 5. Default filtering

By default, **hide** proposals with status `dismissed` or `resolved`.

If the operator asks to "show all", "include dismissed", "show everything", or similar: include all proposals regardless of status. Dismissed and resolved proposals appear at the bottom of the table with their status visible.

### 6. Offer actions

After displaying the table, offer:

```
Actions: /proposal-act accept [ID] | /proposal-act defer [ID] | /proposal-act dismiss [ID]
```

If there are stale proposals, add: "⚠ N proposal(s) have been open for 10+ sessions. Consider reviewing or dismissing."
