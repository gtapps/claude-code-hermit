---
name: error-reproduce
description: Reproduce a Sentry/GlitchTip error group locally — check out the release SHA in a throwaway worktree, write a failing test from the event stack, and git-bisect to the introducing commit when it is not obvious. Operator-invoked or chained from triage.
---

# Error Reproduce

Turn an error group into a **failing test** and, where possible, a **suspect commit**. This is the defensible core of the plugin: a cloud pipeline can forward an event, but it cannot check out your repo at the offending release and bisect.

**Assumption:** this hermit runs inside the repo of the application that produced the error. If the tracker project does not correspond to the current repo (check the project slug against the repo), **stop and say so** — do not guess.

---

## Step 1 — Gather the event

```bash
bun ${CLAUDE_PLUGIN_ROOT}/scripts/error-api.ts issue <id> --json
bun ${CLAUDE_PLUGIN_ROOT}/scripts/error-api.ts latest-event <id> --json
```

From the latest event, extract: the exception type/value, the top in-repo stack frames (file, function, line), and the `release` tag. **Scrub any request bodies, headers, or env values from the event before persisting or relaying** — they may carry secrets.

---

## Step 2 — Map the release to a commit

Resolve the `release` tag to a local SHA: try an exact tag match, then `git log --grep=<short-sha>` or the version embedded in the release name. If nothing resolves, fall back to the commit range since the group's `firstSeen` (`git log --since=<firstSeen> --oneline`). Record `last_good` (a release before `firstSeen`) and `first_bad` (the offending release) for Step 4.

---

## Step 3 — Reproduce in a throwaway worktree

Never mutate the working checkout. Create an isolated worktree at the offending SHA:

```bash
git worktree add <tmp-worktree> <first_bad_sha>
```

Write a **failing test** that exercises the offending code path, driven by the stack frame and event context, following the project's existing test conventions (reuse the dev-hermit `commands.test` command if configured; otherwise infer the runner from the repo). Run it and confirm it fails with the same error. Remove the worktree when done (`git worktree remove`).

`git worktree add` / `git bisect` are not pre-approved in `settings.json` — they will prompt. That is intentional for an operator-invoked skill.

---

## Step 4 — Bisect when the introducing commit is unclear

If Step 2 did not pin a single commit, bisect between the known-good and first-bad releases using the failing test as the oracle:

```bash
git bisect start <first_bad_sha> <last_good_sha>
git bisect run <the failing test command>
git bisect reset
```

Record the commit `git bisect` fingers as the suspect.

---

## Step 5 — Annotate the triage record

Append to today's `raw/error-triage-<YYYY-MM-DD>.md` (or create it): the group shortId, repro status (reproduced / could-not-reproduce), the failing-test location, and the suspect commit/range. This record is the input to `error-draft-fix`. Do not open anything or push anything — reproduction is read-only with respect to shared history.
