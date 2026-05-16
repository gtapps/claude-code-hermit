# Gate 0 Override Protocol

When `/dev-pr` Gate 0 fails because `commands.test` has pre-existing failures on base — failures your branch did not introduce — this protocol lets you proceed while leaving an auditable record in the PR body for reviewers.

---

## What this is (and isn't)

This is a **paper-trail improvement, not a logic fix**. Gate 0 still refuses on any non-pass test result; the override makes the bypass deliberate and visible to reviewers rather than a silent file edit. A real fix — a count-based baseline that compares branch failures against base failures programmatically — is on the roadmap. This manual protocol is the stopgap until that ships.

---

## When to use it

Only when `commands.test` on the base branch also fails with the same set of failures your branch shows. Do not use if your branch introduced new failures — fix those first.

---

## ⚠️ The bypass is ephemeral

The `bypass` block you write into `last-test.json` is erased by the next test run. Any invocation of `/dev-test`, `/dev-quality`, or a `/dev-pr` Gate 0 cache miss that re-runs tests will silently overwrite the file.

**The bypass patch must be the last write to `last-test.json` before you run `/dev-pr`.** Do not run `/dev-test` or `/dev-quality` between the patch and `/dev-pr`.

---

## Nested-repo flow (`--cwd`)

If you invoke `/dev-pr --cwd <path>` (parent has a nested git repo at `<path>`: true submodule, Composer path package, npm/pnpm workspace, vendored dep edited in place), every git command in the steps below must target the child repo. Prefix `git` with `-C "<path>"` (e.g. `git -C "<path>" checkout <base>`, `git -C "<path>" rev-parse <base>`) and run `commands.test` inside `<path>`. See `skills/dev-pr/SKILL.md:27-33` for the full `--cwd` contract.

The `.claude-code-hermit/state/last-test.json` path stays parent-scoped (single state store across parent and any nested children). Only the SHA captured into `bypass.base_sha` (Step 3) must come from the child repo.

The bash blocks in the steps below show the no-`--cwd` form. Substitute `git -C "<path>"` for `git` when `--cwd` is set.

---

## Protocol

**Step 1 — Confirm failures are pre-existing on base.**

From a clean working tree:

```bash
git fetch origin
git checkout <base>         # use the same base as /dev-pr's resolution (pr_base_branch > first protected branch > origin/HEAD > main/master)
<commands.test>             # run and capture the failure summary
git checkout -              # return to your feature branch
```

If `<base>` isn't a local branch (common on fresh worktrees that only have the feature branch checked out), create a tracking branch first: `git checkout -t origin/<base>`.

**Step 2 — Diff the summaries.**

Compare the base failure output to what you see on your branch. If your branch introduces zero new failures, proceed. If it adds new failures, fix those first — the override is only for failures that already existed.

**Step 3 — Patch `last-test.json` with a bypass block.**

Use `jq` to avoid hand-editing risk (preserves `command`, `ts`, and other existing fields):

```bash
BASE_SHA=$(git rev-parse <base>)
SUMMARY="<one-line summary of the pre-existing failures>"

jq \
  --arg sha "$BASE_SHA" \
  --arg summary "$SUMMARY" \
  '. + {
    "status": "pass",
    "exit_code": 0,
    "bypass": {
      "reason": "pre-existing-base-failures",
      "base_sha": $sha,
      "summary": $summary
    }
  }' \
  .claude-code-hermit/state/last-test.json \
  > .claude-code-hermit/state/last-test.json.tmp \
  && mv .claude-code-hermit/state/last-test.json.tmp .claude-code-hermit/state/last-test.json
```

`<base>` is the same base branch resolution as Step 1. `<summary>` is a one-line description operators and reviewers will read — e.g. `"3 TS2304 errors in DiscoverAiSearch*.test.tsx (missing @testing-library/react types)"`.

**Step 4 — Run `/dev-pr` immediately.**

```
/claude-code-dev-hermit:dev-pr
```

Gate 0 cache-hits on the patched file (`status: "pass"`, sha matches HEAD). Gate 2 detects the `bypass` field and renders a `### Gate 0 Override` audit section in the PR body — reviewers see exactly what was knowingly bypassed.

Do not run `/dev-test` or `/dev-quality` between Step 3 and Step 4.

---

## PR body output

When the bypass is in place, the `## Verification` section in the PR body reads:

```
## Verification

- Tests: **audited override** (reason: pre-existing-base-failures)

### Gate 0 Override

- base_sha: <sha>
- summary: <your one-line summary>
```

---

## `bypass` block shape

| Field | Type | Description |
|-------|------|-------------|
| `reason` | string | Closed enum. Only allowed value: `"pre-existing-base-failures"`. Gate 2 emits this value directly in the `Tests:` line — no lockstep coupling. |
| `base_sha` | string | Full SHA of the base branch HEAD when you confirmed the failures. |
| `summary` | string | One-line human-readable description of what the pre-existing failures are. |

---

## What not to do

- **Do not silently patch just `status` and `exit_code`** — without a `bypass` block, Gate 2 renders `Tests: **pass**` and reviewers have no way to know a bypass happened.
- **Do not patch without running Step 1** — if you skip the confirmation, you may bypass a real regression your branch introduced.
- **Do not run tests between the patch and `/dev-pr`** — the next test run erases the bypass block silently.
- **Do not use this for "fix later" deferrals** — the protocol is for pre-existing base failures, not for failures on your branch that you intend to address in a follow-up PR.

---

## Next iteration

A future version of this plugin will ship a count-based baseline (`/dev-test --capture-baseline`) that automates Step 1-2: run once on base, store the failure count, and let Gate 0 compare branch-count vs baseline-count instead of requiring absolute pass. When that ships, this manual override becomes the fallback for edge cases the baseline can't cover.
