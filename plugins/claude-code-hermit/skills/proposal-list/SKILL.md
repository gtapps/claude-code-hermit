---
name: proposal-list
description: Lists all proposals with their status, source, and age. Shows auto-detected proposals prominently. Activates on messages like "what have you noticed", "any improvements", "any proposals", "show proposals".
---
# Proposal List

Lists all proposals with status, source, and age. Auto-detected proposals (from the learning loop) are listed first.

## Plan

### 1. Read the proposals index

Read `.claude-code-hermit/state/proposals-index.json` — a derived cache of every proposal's frontmatter (`id`, `status`, `source`, `category`, `title`, `created`, `session`, `responded`, plus a `legacy` flag), refreshed on every proposal write by the `generate-summary` PostToolUse hook. **(fresh read — re-read the file now; do not reuse a value cached in context from before compaction.)**

Rebuild the index first, then read it:
```
bun ${CLAUDE_PLUGIN_ROOT}/scripts/proposals-index.ts .claude-code-hermit
```
The rebuild reads frontmatter off disk — idempotent, no LLM/token cost — so run it unconditionally rather than trusting an mtime heuristic: it also catches out-of-band proposal writes and **deletions** that the `generate-summary` hook (which fires only on `Edit`/`Write` tool payloads) never sees. The script prints `SKIP|no proposals dir` when there are no proposals — in that case respond "No proposals found." and stop. If the index's `count` is 0, also respond "No proposals found." and stop.

**Do not read proposal bodies.** Every field the table needs is in the index row; this is the whole point of the index (reading a dozen full bodies costs ~22K tokens for a table that needs only frontmatter). Read a specific body only if the operator asks to see one proposal's detail.

### 2. (metadata is already parsed)

The index rows are the parsed metadata — use them directly. Legacy pre-frontmatter proposals appear with `legacy: true` and whatever fields could be recovered (`source` defaults to `manual`).

### 3. Calculate age

Determine the current session number from the highest S-NNN-REPORT.md in `sessions/`. Calculate age as the difference between current session number and the session number in the proposal's `Session` field. Display as "N sessions ago".

### 4. Display as table

```
| ID                                       | Status   | Source        | Category    | Age          | Summary                          |
|------------------------------------------|----------|---------------|-------------|--------------|----------------------------------|
| PROP-020-tag-correlation-103612          | proposed | auto-detected | improvement | 1 session    | [tag-correlation] Frontend blocked |
| PROP-019-test-env-recurring-091455       | proposed | auto-detected | routine     | 3 sessions   | [blocker] Test env recurring     |
| PROP-015-refactor-auth-module-142233     | proposed | manual        | improvement | 12 sessions  | ⚠ Refactor auth module           |
| PROP-012                                 | accepted | manual        | capability  | 20 sessions  | Add retry logic (legacy ID)      |
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
