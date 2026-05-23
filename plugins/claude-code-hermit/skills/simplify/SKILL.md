---
name: simplify
description: Parallel code review and cleanup of recent changes. Replicates the original bundled /simplify command that was removed in CC v2.1.146.
argument-hint: [optional focus, e.g. "memory efficiency"]
---

# Simplify — parallel review, sequential apply

Spawns three focused review subagents in parallel, each returning a list of suggested edits. The main agent then applies them sequentially, resolving conflicts deterministically using the Principles below. The skill is **non-interactive**: it never stops to ask the user. When the Principles don't pick a clear winner, the finding is logged as "not applied" rather than surfaced as a question — the user reads the final report and re-engages if they want one of the rejected proposals.

**Why review-then-apply and not apply-in-parallel:** if three subagents Edit the same files concurrently, they race. Late writers either fail loudly (Edit's `old_string` mismatch) or — worse — see "my change is already there" and silently skip, so most findings get dropped. Parallelizing the slow part (analysis) while serializing writes gives both speed and correctness.

If `$ARGUMENTS` contains a focus hint (e.g. "memory efficiency"), pass it through to all three subagents so they weight that dimension.

## Principles every reviewer must follow

These are cross-cutting — they apply to every finding regardless of reviewer category. The main agent passes them into each reviewer's prompt.

1. **Preserve behavior.** Any change to return values, exceptions, edge-case handling, or observable side effects is a *behavior change*, not a simplification. If a refactor alters output for any input — even malformed or "invalid" input the original happened to accept — it's not a cleanup, it's a redesign. Don't propose those as simplifications; if you spot one and think it's worth doing, label it explicitly so the user can decide.

2. **Clarity over brevity.** Fewer lines is not the goal; a reader understanding the code at a glance is. Avoid nested ternaries when `if/elif/else` reads clearer. Don't wrap trivial operations in named helpers just to "reuse" something — `multiplyTwoNumbers(n, n)` is worse than `n * n`, not better. A short dense one-liner is worse than a two-line form a reader can follow on first pass.

3. **Respect house conventions.** If the session's `CLAUDE.md` documents style rules or idiom preferences, they win over generic idioms — a reviewer suggesting f-strings is wrong if `CLAUDE.md` says use `.format()`. CLAUDE.md is the canonical place for project rules; subagents already see it in context, so no manual passthrough is needed.

## Phase 1 — Capture changes

1. Run `git status --short` to surface untracked new files (no diff command shows these).
2. Run `git diff HEAD` to capture unstaged + staged changes to tracked files.
3. If the diff is empty, run `git diff` against the merge-base. If still empty, fall back to recently modified or mentioned files in the current session.
4. For each untracked file from step 1, read its full contents and append as a synthetic `+++` block so the subagents see new files as additions.
5. If the combined diff is under ~20 lines AND covers a single concern, skip Phase 2 and just dispatch the most relevant single reviewer. Three reviewers on a six-line diff is overkill and produces noise.

## Phase 2 — Launch THREE reviewers IN PARALLEL

Dispatch three `Agent` tool calls in a single message. All use:

- `subagent_type: "general-purpose"`
- `model: "sonnet"` — pin so cost stays predictable across parent session models

Each reviewer receives the full diff and the focus hint (if any), and returns proposed edits as JSON. **Reviewers do NOT call Edit.** They report; the main agent applies.

### Required return format

Each reviewer must end its response with a fenced JSON block:

```json
{
  "findings": [
    {
      "file": "absolute/path/to/file",
      "old_string": "exact text to replace (must be unique in the file or include enough context to be unique)",
      "new_string": "replacement text",
      "rationale": "one short sentence — what was wrong, why this is better",
      "confidence": "high" | "medium" | "low"
    }
  ]
}
```

Empty findings → `{"findings": []}`. Don't pad.

### 1 — Code Reuse Reviewer

> Review the following diff for missed reuse opportunities. Search the WIDER codebase (not just the diff) using Grep to find:
> - New functions that duplicate existing utilities or helpers
> - Inline logic that should use existing utilities: hand-rolled string manipulation, manual path handling, custom env checks, ad-hoc type guards
> - Similar patterns in utility directories, shared modules, and adjacent files
>
> **Principles** (apply to every finding):
> - **Preserve behavior.** If your proposed change alters return values, exceptions, side effects, or edge-case handling for *any* input — including malformed input — it's a redesign, not a simplification. Don't propose it as a cleanup; if worth doing, flag it as a behavior change.
> - **Clarity > brevity.** Wrapping `n * n` in `multiplyTwoNumbers(n, n)` is not reuse, it's worse code. Only propose reuse when the existing helper genuinely captures a non-trivial pattern.
> - **Respect house conventions.** Project conventions (below) override generic idioms.
>
> **Do NOT use Edit, Write, or any file-modification tool.** Your job is to propose edits, not apply them. Return findings as a JSON block per the schema above. Skip false positives silently.
>
> FOCUS HINT: {hint or "none"}
>
> DIFF:
> {paste full diff here}

### 2 — Code Quality Reviewer

> Review the following diff for quality issues. Look for:
> - Redundant state: state duplicating existing state, cached values that could be derived, observers/effects that could be direct calls
> - Parameter sprawl: new parameters added instead of generalizing or restructuring
> - Copy-paste with slight variation: near-duplicate blocks that should share an abstraction
> - Leaky abstractions: exposing internals, breaking existing abstraction boundaries
> - Stringly-typed code: raw strings where constants, enums, or branded types already exist
> - Verbose patterns: unnecessary intermediate variables, `== true`/`== false`, redundant else after return, multi-check null guards that collapse to one expression
> - Unnecessary JSX nesting: wrapper Boxes/elements that add no layout value — check if inner component props (flexShrink, alignItems, etc.) already provide the needed behavior
> - Nested conditionals: ternary chains (`a ? x : b ? y : ...`), nested if/else, or nested switch 3+ levels deep — flatten with early returns, guard clauses, a lookup table, or an if/else-if cascade
> - Unnecessary comments: comments explaining WHAT the code does (well-named identifiers already do that), narrating the change, or referencing the task/caller — delete; keep only non-obvious WHY (hidden constraints, subtle invariants, workarounds)
>
> **Principles** (apply to every finding):
> - **Preserve behavior.** If your refactor alters return values, exceptions, side effects, or edge-case handling for *any* input, it's a behavior change — flag it as such, don't dress it up as a cleanup.
> - **Clarity > brevity.** Don't trade readability for fewer lines. Nested ternaries, dense one-liners, chained mystery operators are not improvements over clear `if/else` blocks. A reader should grok the rewrite faster than the original.
> - **Respect house conventions.** Project conventions (below) override generic idioms.
>
> **Do NOT use Edit, Write, or any file-modification tool.** Your job is to propose edits, not apply them. Return findings as a JSON block per the schema above.
>
> FOCUS HINT: {hint or "none"}
>
> DIFF:
> {paste full diff here}

### 3 — Efficiency Reviewer

> Review the following diff for efficiency issues. NO premature optimization. Look for:
> - Unnecessary work: redundant computations, repeated file reads, duplicate API calls, N+1 patterns
> - Missed concurrency: independent operations run sequentially
> - Hot-path bloat: blocking work on startup or per-request paths
> - Recurring no-op updates: state/store updates inside polling loops, intervals, or event handlers that fire unconditionally — add a change-detection guard so downstream consumers aren't notified when nothing changed. Also: if a wrapper function takes an updater/reducer callback, verify it honors same-reference returns (or whatever the "no change" signal is) — otherwise callers' early-return no-ops are silently defeated
> - TOCTOU anti-patterns: pre-checking existence before operating instead of operating and handling errors
> - Memory: unbounded data structures, missing cleanup, event listener leaks
> - Overly broad operations: reading entire files when only portions needed
>
> **Principles** (apply to every finding):
> - **Preserve behavior.** A faster algorithm that handles edge cases differently is a behavior change, not an optimization. Flag it as such.
> - **Clarity > brevity.** A single-pass loop is only better than two-pass if it stays readable. If merging passes makes the control flow harder to follow, the two-pass version was fine.
> - **Respect house conventions.** Project conventions (below) override generic idioms.
>
> **Do NOT use Edit, Write, or any file-modification tool.** Your job is to propose edits, not apply them. Return findings as a JSON block per the schema above.
>
> FOCUS HINT: {hint or "none"}
>
> DIFF:
> {paste full diff here}

## Phase 3 — Merge and apply (sequential)

Once all three reviewers return:

### 3a. Collect, group, and resolve same-region findings

Parse the JSON blocks. If one reviewer's block fails to parse, log it and continue with the others — don't abort the whole run. Group findings by `(file, old_string)`. For each group with more than one finding, compare the `new_string` values:

- **Byte-identical or semantically equivalent `new_string`** (e.g., trivial renames like `u for u in ...` vs `user for user in ...`) → silent dedupe. Keep the one with higher confidence; if tied, Code Quality > Code Reuse > Efficiency (Quality fixes tend to be the most local and least risky). If you're unsure whether two rewrites are equivalent, treat them as different and escalate.
- **Meaningfully different `new_string`** (different algorithm, different control flow, different intermediates) → check the **Principles** against each variant:
  - Does one variant respect *preserve behavior* while the other changes output on some input? → pick the behavior-preserving one. Log the rejected variant + its behavior change in the report (under "Noticed but not applied") so the user can opt in later if they want.
  - Does one variant respect *clarity > brevity* while the other is denser/cleverer for no gain? → pick the clearer one. Log the rejected variant.
  - Does one variant respect *house conventions* (per CLAUDE.md) while the other doesn't? → pick the conforming one.

  If the principles **don't discriminate** — both options preserve behavior identically, both are equally clear, both respect conventions — apply **neither**. Log them under "Noticed but not applied: principles couldn't decide" so the user can pick if they care.

  Never stop to ask. Surfacing a style call to the user mid-run defeats the point of having principles. The user invoked `/simplify` to clean code, not to answer a quiz.

### 3b. Group by file, sort by file order

For each file, read it once and locate each finding's `old_string`. Sort findings by their offset so edits happen top-to-bottom (helps the user follow the diff in review).

### 3c. Detect overlaps

Two findings on the same file *overlap* if their `old_string` regions intersect. For each overlap group:
- If one strictly contains another, the broader rewrite usually subsumes the narrower one — but **check first** whether the broader version respects the Principles as well as the narrower. If the broader rewrite trades clarity for brevity, or quietly changes behavior on an edge case the narrower one preserves, pick the narrower (and log the broader as rejected on principle grounds).
- If they intersect but neither contains the other, apply the same Principles check from 3a. If principles discriminate, pick the principle-aligned one and log the rejected variant. If they don't, apply **neither** and log both under "Noticed but not applied".

### 3d. Apply, top to bottom

For each non-conflicting finding, in file order:
1. Re-read the target file (or the relevant section) to confirm `old_string` still appears verbatim. Earlier edits or external changes can shift content; checking proactively is cheaper than recovering from an Edit failure.
2. If it still matches, call `Edit` with the `old_string` and `new_string`.
3. If it no longer matches, skip silently — the finding was subsumed by an earlier edit.
4. If `Edit` fails for any other reason, surface the error and stop on that file.

### 3e. Report

Print a concise per-file summary, then "noticed but not applied", then totals:

```
path/to/file.ts
  ✓ [Quality] removed `=== true` comparison on line 31
  ✓ [Reuse]   replaced manual loop with `.reduce(...)` on line 53
  ⊘ [Efficiency] skipped — old_string no longer matches (subsumed)

Noticed but not applied:
  ⚠ [Quality] proposed compound rewrite of parse_user_input (lines 70-74) —
      rejected on principle "clarity > brevity" (denser, calls strip() twice).
      To apply: ask explicitly.
  ⚠ [Reuse] proposed `email.partition("@")` with None return for no-@ inputs
      (lines 95-99) — behavior change vs original (`""`). To apply: ask explicitly.

Totals: applied N · deduped M · principle-rejected K · stale-anchor skips L · parse failures P
```

The "Noticed but not applied" section is how the user discovers rejected proposals and can opt in. The skill never blocks waiting for an answer.

No essays. Just what changed, what didn't, and why.
