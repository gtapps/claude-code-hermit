---
name: error-draft-fix
description: Draft a fix for a reproduced error on a branch, failing test committed first. Opening the PR is approval-gated — delegates to /claude-code-dev-hermit:dev-pr when installed, otherwise stops at a local branch and DMs. Never pushes from agent context.
---

# Error Draft Fix

Take a reproduced error and produce a **fix on a branch with the failing test as a guard**. The push and PR are the operator's call — this skill stops short of both.

**Precondition:** a reproduce record exists (from `error-reproduce`) with a failing test and, ideally, a suspect commit. If there is no reproduction, stop and run `error-reproduce` first — never draft a fix against an unreproduced error.

**Assumption:** running inside the watched application's repo (same guard as `error-reproduce`).

---

## Step 1 — Branch

Branch from the default branch (not from a detached repro worktree):

```bash
git checkout -b error-fix/<shortId> origin/<default-branch>
```

---

## Step 2 — Commit the failing test first

Add the failing test from the reproduce record and commit it on its own. Committing the test before the fix makes the guard visible in history and lets the next step prove the fix flips it green.

---

## Step 3 — Draft the fix

Implement the smallest change that addresses the root cause identified in reproduction. Re-run the project test suite (`commands.test` if configured) and confirm the previously-failing test now passes and nothing else regressed.

---

## Step 4 — Hand off (approval-gated — never push here)

**Do not `git push` from agent context.** Per the project git-safety rules, the sanctioned push+PR path is `/claude-code-dev-hermit:dev-pr`.

- **dev-hermit installed** → surface the branch, the fix summary, and the green test to the operator, and tell them to run `/claude-code-dev-hermit:dev-pr` (which runs its own gates, then pushes and opens the PR).
- **dev-hermit not installed** → stop at the local `error-fix/<shortId>` branch. DM the operator (core Operator Notification protocol) with the branch name and a one-paragraph summary. They push.

---

## Step 5 — Tracker follow-up (later, still gated)

Resolving the issue in Sentry/GlitchTip happens **after** the fix merges, and is still surface-then-approve:

```bash
bun ${CLAUDE_PLUGIN_ROOT}/scripts/error-api.ts resolve <id> --confirm
```

Propose it; never run it unprompted. Update the noise ledger row to `fixed-in <release>` once the fix ships (the `error-incident-summary` skill does the full writeup).
