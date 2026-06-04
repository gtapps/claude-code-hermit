---
name: tackle-issue
description: |
  Project-scoped extension of the user-level tackle-issue skill, active only inside this monorepo. Same triage workflow (read-only investigation, falsification, verdict, SHIP/CAVEAT/DEFER/SKIP recommendation), plus a picker mode when no specific issue is named, plus an optional branch + TaskCreate handoff on positive verdicts.
  Three input modes:
    • GitHub issue number — "tackle issue 99", "work issue 17", "start on gh #42". Fetches via gh, runs the full triage workflow. On SHIP / SHIP WITH CAVEAT, offers to check out a branch and seed implementation tasks.
    • Pasted task content — "investigate this proposal", "pressure-test this", "scope this before I touch it". Runs the triage workflow on the pasted text. Read-only output only — no branch, no TaskCreate seeding.
    • No input / picker phrasing — "tackle the next issue", "pick an issue", "what should I work on", "next issue". Lists ready-labelled open issues in gtapps/claude-code-hermit, filters those with linked open PRs, applies the dedup log, picks one, then runs the issue-number flow on it.
  Flag:
    • --investigate-only — runs the full triage workflow (including Proposed approach / Files / Verification on positive verdicts) and then stops. No branch checkout, no TaskCreate seeding. Used by /issue-proposals.
  NOT for committing (/commit), opening PRs (/dev-pr), or merging. Stops once a branch is checked out and tasks are seeded.
---

# Tackle Issue

Project-level extension of the user-level `tackle-issue` skill. Picks the next ready GitHub issue (or accepts a specific number or pasted task text), runs the full triage workflow against the current code, and — on a positive verdict — checks out a branch and seeds implementation tasks. Implementation, commit, and PR happen outside this skill.

Three modes: **picker** (no arg), **issue number** (e.g. `tackle issue 99`), **pasted text** (investigation-only).

## Mindset

A GitHub issue or pasted proposal is a **hypothesis**, not a spec. Issues filed by AI agents (hermit-scribe is the common case here) and pasted proposals often have correct intent but imperfect framing — the file paths may be stale, the proposed fix may be the first idea rather than the best one, the scope may be larger than needed, or the situation may have already changed since the issue was filed. Worse, the bug may not exist at all.

The default posture is skeptical investigation. Before drafting any plan, try to falsify the premise. If the premise survives the falsification attempt, then evaluate whether implementing it is actually worth the cost — a verified premise is not the same as a worthwhile change.

Two failure modes to avoid:

- **Rubber-stamping** — accepting the issue's framing and drafting a plan that implements exactly what was written, even when a simpler fix exists or the premise is partially wrong.
- **Reflex-pushback** — manufacturing objections to look thorough. If the premise holds and the ROI is good, say "ship it as written" plainly. The pushback is only valuable when it's grounded in evidence.

## Inputs and dispatch

**Issue number:** any of "tackle issue 99", "work issue 17", "start on gh #42", "look at issue 5" — or a bare `#N` or `owner/repo#N`. Fetch with `gh issue view <N> --repo gtapps/claude-code-hermit --json title,body,labels,comments,author,state,url`. If the issue is closed, surface that and ask whether to continue. Can be combined with `--investigate-only` to suppress the branch + task handoff (see Flag below).

**Pasted task content:** user pastes a proposal, spec, or free-form description. No `gh` fetch needed. Triage output only — no branch, no TaskCreate seeding (no issue-number anchor).

**Picker phrasing:** "tackle the next issue", "pick an issue", "what should I work on", "next issue", or `/tackle-issue` with no argument. Run the Picker mode below, then fall through to the issue-number flow.

**Ambiguous:** user says "tackle this" with no number, no paste, no picker phrasing → ask which mode before fetching anything.

**Flag `--investigate-only`:** can be combined with any issue-number input. Runs the full triage workflow (Falsification → Verdict → Recommendation → Output format, including Proposed approach / Files / Verification on positive verdicts), then stops. No branch checkout, no TaskCreate seeding. See [§ Flag: --investigate-only](#flag----investigate-only) below.

## Picker mode

Only runs when no issue number and no pasted content is provided.

### P0. Fetch candidates

```bash
gh issue list --repo gtapps/claude-code-hermit --label ready --state open \
  --json number,title,body,labels,updatedAt,url --limit 30
```

If 0 results: "No `ready`-labelled open issues — label issues `ready` on GitHub to opt in." Stop.

### P1. Filter issues with linked open PRs

```bash
gh pr list --repo gtapps/claude-code-hermit --state open \
  --json number,body,headRefName --limit 100
```

Build a set of referenced issue numbers from PR bodies (regex `(?:[Cc]loses|[Ff]ixes|[Rr]esolves)?\s*#(\d+)`) and head-ref branch names (pattern `(?:feat|fix|chore)/(\d+)-`). Remove those from the candidate list.

### P2. Apply dedup log

Read `.claude/state/tackle-issue-log.jsonl` (treat missing as empty). Drop candidates with:
- a `skip` event in the last 7 days, or
- a `presented` event in the last 24h without a subsequent `go`, `skip`, or `defer`, or
- a `defer` event in the last 24h.

`go` events are historical only — the linked-PR filter already handles "this issue is being worked."

### P3. Pick one

Sort remaining: `priority:high` label first, then by `updatedAt` descending. Pick `[0]`. If empty after filters: "All eligible issues have been recently picked or have open PRs." Stop.

### P4. Fall through

Continue to the Falsification workflow with the picked issue number as input.

## Falsification workflow

Run these against the current code before forming any verdict.

1. **Does the bug actually reproduce, or is the code already handling it?** Read the cited code paths. Find where the described behavior is implemented and check whether the described failure mode is real.

2. **Is the feature already shipped, possibly under a different name?** Grep for relevant symbols and concepts. Check docs and README.

3. **Are cited file paths, symbols, and behaviors still current?** Renames and refactors silently invalidate issue bodies.

4. **Has the situation changed since the issue was filed?** `git log` on cited files, or `git log -S "<symbol>"` for named symbols. Check whether relevant commits landed after the issue date.

Read referenced files with `Read`. Grep with `Grep`. Skim sibling tests for the existing behavior contract. Confirm each load-bearing claim against the current code, or label it "recalled, not verified."

**PROP-NNN cross-reference (this repo only):** if the issue body references `PROP-NNN-<slug>-HHMMSS`, read the matching file under `.claude-code-hermit/proposals/` and include its `## Problem` and `## Proposed Solution` sections in the evidence pass. Do NOT try to dereference PROP-NNN ids from other repos — the numbering is per-repo.

## Verdict (on the premise)

- **Confirmed as-is** — issue is accurate and the fix it proposes (if any) is sound.
- **Refined approach** — premise is accurate but a simpler, cleaner, or more surgical fix exists.
- **Corrected scope** — fix is needed but smaller, larger, or differently shaped than the issue suggests.
- **Nothing to do** — premise is wrong. The bug doesn't exist, the feature already exists, or the situation has changed. **Stop here.** Recommend closing/commenting on the issue. Do not produce a plan or branch.

## Recommendation (on whether to ship)

- **SHIP** — net positive, proceed now.
- **SHIP WITH CAVEAT** — proceed, but flag a specific risk, follow-up, or scope edge.
- **DEFER** — worth doing, but not now. Say what unblocks it.
- **SKIP** — premise holds but ROI is weak. **This is a legitimate outcome.** Name that honestly rather than defaulting to ship.

## Output format

Present everything in chat. **Do not call ExitPlanMode.**

> Contract note: `/issue-proposals` parses this output by exact heading (`## Recommendation:`,
> `## Verdict:`, `Proposed approach`, `Files to touch`, `Verification plan`, `Trade-offs`).
> If you rename any of these, update `/issue-proposals` Steps 6–7 to match.

```
## Verdict: <Confirmed as-is | Refined approach | Corrected scope | Nothing to do>

## Evidence
- <File or symbol checked> → <what was confirmed or falsified>

## Trade-offs
**Pros:** <value delivered, problems solved>
**Cons:** <complexity cost, maintenance burden, risk>
**Cost of doing nothing:** <what stays broken, or "negligible">

## Recommendation: <SHIP | SHIP WITH CAVEAT | DEFER | SKIP>
<one-line why>
```

Then, **only if recommendation is SHIP or SHIP WITH CAVEAT**, append:

```
## Proposed approach
<plan in prose or steps>
<If deviating from issue: "Deviating from source: <what> because <why>">

## Files to touch
- <path> — <change>

## Verification plan
- <test, manual check, or command that proves the change works>
```

Then stop. Do not ask whether to proceed.

## Flag: --investigate-only

When `--investigate-only` is passed:
- Run the full Falsification workflow → Verdict → Recommendation → Output format (including
  Proposed approach / Files to touch / Verification plan on positive verdicts).
- **Stop after printing the report.** Do not run the Branch + task handoff (H0–H6).
- This flag is used by `/issue-proposals` to capture the verdict and plan text for proposal
  creation, without starting implementation.

## Branch + task handoff

Runs only when the verdict is SHIP or SHIP WITH CAVEAT **and** the input mode produced a GitHub issue number (not pasted text) **and** `--investigate-only` was NOT passed.

### H0. Guardrails

- On `main`/`master` with dirty tree → stop, point at `/commit`.
- Mid-rebase, mid-merge, or detached HEAD → stop.
- On a feature branch with uncommitted changes → stop, point at `/commit`.
- On a feature branch (clean tree, commits ahead of base) → AskUserQuestion: continue current work, or switch to the new issue's branch leaving current as-is.
- `gh auth status` fails → stop with auth instructions.
- Never commit, push, or open PRs from this skill.

### H1. Draft branch name

Label-classified: `bug` → `fix/<N>-<slug>`, `enhancement`/`feature` → `feat/<N>-<slug>`, otherwise `chore/<N>-<slug>`. Slug from issue title: drop non-ASCII, lowercase, space-collapse non-`[a-z0-9]` runs, drop stopwords (`a an the and or of for to in on with by from as is are`), take first 5 tokens, join with `-`, hard-cap at 40 chars.

### H2. Draft plan

3–6 imperative TODO bullets from the issue body + linked PROP `## Proposed Solution` if present. If the triage Proposed-approach section already enumerated steps, reuse those bullets verbatim.

### H3. Present and ask

Print:
```
Issue #N — <title>
URL: <url>
Labels: <comma list>
Linked PROP: <id or "(none)">
Branch: <branch>
Plan:
  • …
```

`AskUserQuestion` (header "Tackle issue"):
- **go** — Check out branch, seed TaskCreate items, hand off
- **skip** — Record skip (7-day dedup), exit
- **defer** — Record defer (24h cooldown), exit

Append `{"ts":"…","issue":N,"action":"presented","branch":"…","verdict":"…","recommendation":"…"}` to `.claude/state/tackle-issue-log.jsonl` before asking, then `{"ts":"…","issue":N,"action":"<choice>"}` after.

### H4. On `go`: check out branch

```bash
git fetch origin
BASE=$(gh repo view --json defaultBranchRef -q .defaultBranchRef.name)
git checkout -b <branch> origin/$BASE
```

If the branch already exists locally: `git checkout <branch>` and warn.

### H5. Seed tasks

`TaskCreate` each plan bullet as a separate task. Append three trailing tasks:
- Run `/claude-code-dev-hermit:dev-quality`
- Run `/commit`
- Run `/claude-code-dev-hermit:dev-pr`

### H6. Report and stop

```
On branch <branch>, ready to implement.
When done: /dev-quality → /commit → /dev-pr.
```

Exit. No code edits, no commits, no PR.

## Simplicity

Minimum code that solves the problem. No abstractions for single-use code. No speculative flexibility. Surgical changes — every changed line should trace to the verdict.

If the draft plan exceeds what the task requires, cut. Move "while we're here" cleanup to a SHIP WITH CAVEAT note.

## Never

- Call `ExitPlanMode`.
- Commit, push, open PRs, comment on issues, change labels, or close issues.
- Write to `.claude-code-hermit/` (hermit-runtime state, not workflow state).
- Auto-pick more than one issue per invocation.

## Anti-patterns

- **Verifying by paraphrasing the issue.** The evidence line must describe what was read in the code, not what was read in the issue.
- **Pro/con sections that hedge without substance.** Name concrete costs and benefits — files affected, time to maintain, edge cases at risk.
- **Defaulting to SHIP because the premise is verified.** Verified premise + weak ROI = SKIP.
- **Scope creep into the plan.** Unrelated improvements noticed during exploration go in chat after the report, not in the plan.
- **Calling ExitPlanMode.** This is the single most important "don't."
