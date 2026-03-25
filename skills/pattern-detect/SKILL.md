---
name: pattern-detect
description: Analyzes recent session reports to detect recurring patterns — blockers, failures, workarounds, cost trends, and tag correlations. Creates proposals automatically when a pattern appears across multiple sessions. Runs at session close before archiving.
---
# Pattern Detect

Analyzes recent session reports to detect recurring operational patterns. Creates auto-proposals when patterns are found. Invoked by the main agent during session-close, after finalizing ACTIVE.md but before archiving.

## Prerequisites

- At least 3 archived session reports must exist in `sessions/` (S-*-REPORT.md files)
- If fewer than 3 reports exist: skip pattern detection entirely — not enough data

## Steps

### 1. Read recent session reports (selective)

Read the last 5 session reports from `.claude/.claude-code-hermit/sessions/` (S-*-REPORT.md files, sorted by number descending).

For each report, extract **only** these sections — do not read full reports:
- `## Summary` — for Status, Tags, and Cost fields
- `## Blockers` — blocker descriptions
- `## Progress Log` — for workaround descriptions

Also extract the current session's data from `ACTIVE.md` (same sections).

### 2. Detect patterns

Run all four detection categories:

#### Category 1: Blocker recurrence

Compare blocker descriptions across reports. Look for the same blocker keyword, phrase, or semantically similar issue appearing in **3 or more** sessions.

- Evaluate semantic similarity, not just exact string match — "test env unreachable", "test environment down", and "cannot connect to test server" are the same pattern
- Include the current session's blockers in the comparison

#### Category 2: Workaround repetition

Scan Progress Log entries for workarounds applied in **2 or more** sessions. Indicators: "worked around", "manually", "temporary fix", "as a workaround", or similar phrasing describing the same mitigation applied repeatedly.

A repeated workaround indicates a missing permanent fix.

#### Category 3: Cost trend

Compare session costs across the last 6 reports (if available):
- Calculate the average cost of the last 3 sessions
- Calculate the average cost of the 3 sessions before that
- Flag only when: last-3 average is **>50% higher** than prior-3 average **AND** the absolute increase is > $1.00

Small or gradual increases are normal — only flag significant trends.

#### Category 4: Tag correlation

For each report, extract the Tags field and Status field:
1. Group sessions by tag
2. For each tag appearing in 3+ sessions: count how many closed as `blocked` or `partial`
3. If **3 or more** sessions sharing the same tag closed non-successfully: flag as a pattern

This surfaces systemic issues in a domain area even when individual blocker descriptions differ.

### 3. Scan all proposals (single pass)

Read all files in `.claude/.claude-code-hermit/proposals/` **once** and categorize by status and source:
- **Active proposals** — status is not `dismissed` or `resolved` (for dedup in step 6)
- **Accepted auto-proposals** — `Status: accepted` and `Source: auto-detected` (for feedback loop)
- **Open proposals** — `Status: proposed` (for staleness check)

Use this categorized data for the next three checks without re-reading the files.

#### 3a. Dedup check

For each detected pattern, check if any active proposal already covers it — search by keyword in proposal titles and Problem sections. If a matching proposal exists: **skip** — do not create a duplicate.

#### 3b. Feedback loop (verify fixes)

For each accepted auto-proposal:
1. Read the `Related Sessions` field to understand what pattern was detected
2. Check if that pattern has **not recurred** in the last 3 sessions since the proposal was accepted
3. If the pattern is absent from the last 3 sessions: update the proposal's status to `resolved` and append a note:
   ```
   ## Resolution
   Pattern has not recurred in 3 sessions since acceptance. Auto-resolved on YYYY-MM-DD.
   ```

#### 3c. Flag stale proposals

For each open proposal:
1. Compare the proposal's `Created` date against the current session count
2. If a proposal has been open for **10 or more sessions** since creation: note it for the operator
3. Do NOT auto-close — just flag

### 4. Create auto-proposals

For each new pattern detected (not already covered by an existing proposal):
1. Invoke the `proposal-create` skill with the following additions:
   - Set `Source: auto-detected`
   - Set `Related Sessions:` to the list of session IDs where the pattern appeared
   - In the Context section: describe the pattern and which sessions exhibited it
   - In the Problem section: describe the recurring issue with excerpts from each session
   - In the Proposed Solution section: suggest a concrete fix
   - Prefix the title with a category tag: `[blocker]`, `[workaround]`, `[cost-trend]`, or `[tag-correlation]`

### 5. Update ACTIVE.md

If any patterns were detected (new or existing), append a `## Patterns Detected` section to ACTIVE.md before it gets archived:

```markdown
## Patterns Detected
- Recurring blocker: "test environment unreachable" (S-038, S-041, S-042) → Auto-created PROP-019
- Tag correlation: "frontend" sessions consistently blocked (S-035, S-039, S-042) → Auto-created PROP-020
- Stale proposal: PROP-015 has been open for 12 sessions — consider reviewing
- Resolved: PROP-012 pattern hasn't recurred in 3 sessions — marked resolved
```

If no patterns detected: omit the section entirely.

### 6. Send channel alert

If any proposals were auto-created AND channels are configured in `config.json`:
- Send an alert: "Pattern detected across recent sessions. Created N proposal(s). Review with /proposal-list"
- Include a one-line summary of each new proposal

If proposals were only resolved or flagged as stale (no new proposals created): do not send a channel alert.
