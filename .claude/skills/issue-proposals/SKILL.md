---
name: issue-proposals
description: |
  Repo-internal routine skill. Fetches open GitHub issues on gtapps/claude-code-hermit,
  filters out ones with linked open PRs or existing proposals, picks one, runs it through
  /tackle-issue --investigate-only as a viability gate, and on a SHIP / SHIP WITH CAVEAT
  recommendation creates a hermit proposal via /claude-code-hermit:proposal-create. One
  issue per run; dedup by gh-issue-<N> tag across all proposal statuses. Not shipped to
  downstream operators — hardcoded to this repo.
---

# Issue Proposals

Routine skill: autonomous issue→proposal pipeline. Fetches one open GitHub issue,
vets it through `/tackle-issue --investigate-only`, and creates a proposal only if the
verdict is SHIP or SHIP WITH CAVEAT.

Intended to run daily as a hermit routine. The routine is **not** auto-registered by
this skill. Add an entry to `.claude-code-hermit/config.json` (`routines[]` with
`skill: issue-proposals`, a `schedule`, and `enabled: true`), then `/claude-code-hermit:hermit-routines load`.
Until then the skill only runs when invoked manually: `/issue-proposals`.

## Steps

### 1. gh guard

Run `gh auth status --hostname github.com 2>&1`. If exit code is non-zero:

```
Append to SHELL.md ## Findings:
  [HH:MM] issue-proposals: gh unavailable — re-auth with `gh auth login`
```

Stop cleanly. Do not emit an error — this is a routine no-op, not a failure.

### 2. Fetch candidates

```bash
gh issue list \
  --repo gtapps/claude-code-hermit \
  --state open \
  --json number,title,url,updatedAt,labels \
  --limit 30
```

If the result is an empty array: append to SHELL.md Progress Log:
`[HH:MM] issue-proposals — no open issues` and stop.

### 3. PR filter

```bash
gh pr list \
  --repo gtapps/claude-code-hermit \
  --state open \
  --json number,body,headRefName \
  --limit 100
```

Build a set of referenced issue numbers from:
- PR bodies: regex `(?i)\b(?:close[sd]?|fix(?:es|ed)?|resolve[sd]?)\b\s*:?\s+#(\d+)`.
  A GitHub closing keyword is **required**, so bare `#N` mentions (e.g. "similar to #5",
  PR cross-links) are ignored and incidental references don't drop an eligible issue
  from candidacy.
- Head-ref branch names: pattern `(?:feat|fix|chore)/(\d+)-`

Remove matching issues from the candidate list.

### 4. Proposal dedup

Run a single grep to collect all `gh-issue-<N>` markers already in the proposals directory:

```bash
grep -roh "gh-issue-[0-9]*" .claude-code-hermit/proposals/ 2>/dev/null | sort -u
```

This produces a list of already-proposed issue numbers. Drop any candidate whose number
appears in that list — regardless of the proposal's `status`.

This is the authoritative dedup gate. Dismissed or resolved proposals still block
re-investigation so a closed/re-opened issue doesn't flood proposals.

### 5. Pick one

From the remaining candidates:
1. Prefer issues with label `priority:high` (check the `labels[].name` array)
2. Among those (or all if none are priority:high): sort by `updatedAt` descending; take `[0]`

If the list is empty after filtering: append to SHELL.md Progress Log:
`[HH:MM] issue-proposals — all eligible issues already proposed or have open PRs` and stop.

### 6. Investigate

Invoke `/tackle-issue <N> --investigate-only` where `<N>` is the picked issue number.

This runs tackle-issue's full Falsification workflow → Verdict → Recommendation → Proposed
approach (on positive verdicts). It stops before the Branch + task handoff (H0–H6).

Read the output and classify the recommendation. Look for a line beginning with
`## Recommendation:` in the output. **This parse depends on tackle-issue's exact output
headings** (`## Recommendation:`, `## Verdict:`, `Proposed approach`, `Files to touch`,
`Verification plan`, `Trade-offs`). If those headings change in tackle-issue, update this
step and Step 7 to match; there is no test guarding the contract. The token after the
colon determines the path:
- `SHIP` or `SHIP WITH CAVEAT` → proceed to Step 7
- `DEFER`, `SKIP`, or Verdict `Nothing to do` → proceed to Step 8 (log, no proposal)

If `/tackle-issue` produces no output, an error trace, or no `## Recommendation:` line:
append to SHELL.md Findings `[HH:MM] issue-proposals: tackle-issue returned no parseable
verdict for #<N> — treating as DEFER` and proceed to Step 8.

### 7. Create proposal (SHIP / SHIP WITH CAVEAT only)

Invoke `/claude-code-hermit:proposal-create` with the following:

**Evidence Source:** `operator-request`

**Title:** `[gh-#<N>] <issue title>` — prefix with the issue number for discoverability.

**Compose the body** from tackle-issue's output:

- **Context:** Issue `#<N>` — `<title>` (`<url>`). Investigated by `/tackle-issue
  --investigate-only`. Verdict: `<verdict>`. Recommendation: `<recommendation>`.
- **Problem:** Fill from tackle-issue's Evidence section + Cost-of-doing-nothing field.
- **Proposed Solution:** Fill from tackle-issue's Proposed approach + Files to touch +
  Verification plan sections. If the verdict was Refined approach or Corrected scope,
  note the deviation from the original issue.
- **Impact:** Fill from tackle-issue's Trade-offs (Pros / Cons).
- **Final line of Proposed Solution** (always append):
  > To implement: review this proposal, then enter plan mode (`/model opusplan` or the
  > `/fast` toggle) to plan with Opus. Approve the plan, then execute. Run `/dev-quality`
  > → `/commit` → `/dev-pr` when done.

**Category** — derived from issue labels:
- `bug` label → `bug`
- `enhancement` or `feature` label → `capability`
- otherwise → `improvement`

**Tags** — `[gh-issue-<N>, <one topical tag from the issue title>]`

The `gh-issue-<N>` tag is the dedup marker read in Step 4. It must always be present.

**source:** `operator-request`

### 8. Log outcome (always)

Append one line to SHELL.md `## Progress Log`:

- On proposal created: `[HH:MM] issue-proposals — investigated #<N>: SHIP → <PROP-NNN>`
- On DEFER/SKIP: `[HH:MM] issue-proposals — investigated #<N>: <RECOMMENDATION> → none`
- On Nothing-to-do: `[HH:MM] issue-proposals — investigated #<N>: Nothing-to-do → none`
- On no candidates: (already logged in steps 2/5, no duplicate needed)

## Never

- Pick more than one issue per invocation.
- Create a branch, commit, push, comment on issues, label issues, or close issues. This
  skill is read-only against GitHub (`gh issue list` / `gh pr list` only); it writes a
  proposal and a SHELL.md log, nothing back to the tracker.
- Write to `.claude-code-hermit/` outside of SHELL.md Progress Log entries (the proposal is
  created by `/claude-code-hermit:proposal-create` which handles its own state).
- Invoke tackle-issue without `--investigate-only` (would create a branch + Tasks).

## Notes

- The `log-routine-event.sh issue-proposals fired` call is handled automatically by the
  hermit-routines prompt template — the skill does not need to call it.
- If gh returns a rate-limit error (exit 0, empty or error JSON), treat as "no candidates"
  and log the reason.
- This skill is intentionally thin — investigation logic lives in `/tackle-issue`, proposal
  pipeline in `/claude-code-hermit:proposal-create`. Changes to either are inherited here.
