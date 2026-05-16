---
name: dev-pr
description: "Operator-sanctioned alternative to bare `git push` from agent context. Open a PR from the current feature branch with a body assembled inline from commit history, the test command's last output, screenshots, and an optional project PR template. Refuses on protected branches, dirty trees, or zero commits ahead. Run as the final step of a ticket."
---

# /dev-pr

Push the current branch and open a PR with a structured body. Reads commit history, the test results you just ran (per `state-templates/CLAUDE-APPEND.md` §Tests Before PR), any screenshots in `raw/screenshots/`, and an optional project PR template — assembles them into title + body — then calls the forge-appropriate CLI.

## Configuration

`commands.pr_create` — the shell command used to open the PR. Set by `/claude-code-dev-hermit:hatch` from the detected forge. **If unset, Gate 0 refuses immediately** with a pointer to run `/hatch`.

- **GitHub**: `gh pr create` — flags: `--body-file <path>`, `--base <branch>`.
- **GitLab**: `glab mr create` — flags: `--description "$(cat <path>)"`, `--target-branch <branch>`.
- **Bitbucket / custom / other**: operator-supplied. Gate 3 passes `--title "$TITLE" --body-file "$PR_BODY_TMP" --base "$BASE"` to custom commands — wrap your CLI in a script that accepts those flags if the native CLI uses different ones.

The command must print the PR URL on a line matching `^https?://`.

## Prerequisites

- Verify `.claude-code-hermit/sessions/` exists. If not: tell the operator to run `/claude-code-hermit:hatch` and `/claude-code-dev-hermit:hatch` first.
- Read `.claude-code-hermit/config.json` once. Cache `claude-code-dev-hermit.protected_branches` (defaults to `["main", "master"]`), `commands.pr_create` (no default — if unset, Gate 0 fails with a pointer to run `/claude-code-dev-hermit:hatch`), `pr_base_branch`, `pr_template_path`.

## Argument

Optional `--cwd <path>`. When set, the entire flow targets the nested git repo at `<path>` end-to-end: Gate 0 checks (forge, branch, clean tree, tests, commits-ahead), Gate 1 push, Gate 2 title/body assembly, and Gate 3 `commands.pr_create` invocation all run against `<path>`. **The PR opens against `<path>`'s remote, not the parent's** — that's intentional (the child repo is the unit being PR'd) but the operator must understand it. Use this for nested-repo workflows (see CLAUDE-APPEND §Implementation Flow).

State (`bindings.json`, `last-test.json`, `SHELL.md`) still resolves under the parent's `.claude-code-hermit/` — there's a single store. The `last-test.json` cache check stays SHA-only — `record.sha === git -C "$TARGET" rev-parse HEAD` already discriminates parent records from child records (different repos, different histories, different SHAs).

## Plan

In every gate below, when `--cwd <path>` is set, prefix all `git ...` invocations with `-C "<path>"` (e.g. `git -C "<path>" status --porcelain`) and run the configured `commands.pr_create` via Bash with `cwd: "<path>"` so the forge CLI reads the child's `.git/config`. When `--cwd` is omitted, run as today (against `$PWD`). Below, `$TARGET` stands for `<path>` when set or `$PWD` otherwise; the bash blocks show the no-`--cwd` form.

### Gate 0 — preconditions

Run all checks in order. FAIL on the first failure, name it, give the exact command to fix it.

**0. Forge / tool sanity.** Two sub-checks, both cheap and run before anything else:

*0a. `commands.pr_create` configured?* If the cached value is absent or empty: FAIL `"commands.pr_create not configured — run /claude-code-dev-hermit:hatch to set it"`.

*0b. Forge/tool coherence.* Derive the tool discriminator: `TOOL=$(basename $(echo "$PR_CREATE" | awk '{print $1}'))`. Classify `git remote get-url origin 2>/dev/null` using the same map as hatch:
- `github.com` or `github.` → `FORGE=github`
- `gitlab.com` or `gitlab.` → `FORGE=gitlab`
- `bitbucket.org` → `FORGE=bitbucket`
- anything else → `FORGE=custom`

Fail **only** when both forge and tool are in the recognized set and they form a known-bad pairing:
- `FORGE=github` AND `TOOL != gh` → FAIL
- `FORGE=gitlab` AND `TOOL != glab` → FAIL

All other combinations (FORGE=bitbucket, FORGE=custom, TOOL not in {gh,glab}, no remote) → warn-and-proceed (custom wrappers on known hosts must not be blocked).

Fail message: `"commands.pr_create ('<configured>') doesn't match origin host (<forge>) — re-run /claude-code-dev-hermit:hatch or update commands.pr_create in .claude-code-hermit/config.json"`.

**1. Protected-branch check.** Materialize the cached `protected_branches` config value as a bash array, then compare the current branch against each pattern using bash glob semantics:

```bash
PROTECTED_BRANCHES=(main master)   # from config.claude-code-dev-hermit.protected_branches
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
for pattern in "${PROTECTED_BRANCHES[@]}"; do
  case "$CURRENT_BRANCH" in
    $pattern)
      echo "FAIL: cannot open PR from protected branch $CURRENT_BRANCH"
      echo "  recovery: create a feature branch (see CLAUDE-APPEND.md §Branch Discipline)"
      exit 1 ;;
  esac
done
```

**2. Clean-tree check.** `git status --porcelain` must return empty. If non-empty: FAIL with `"commit or stash changes before opening a PR"`.

**3. Tests check.** Read `commands.test` from `.claude-code-hermit/config.json`.

- If `commands.test` is **unset**: warn `"No test command configured — test check skipped."` and proceed.

Otherwise, read `.claude-code-hermit/state/last-test.json`:

- If the file exists **and** `sha === git -C "$TARGET" rev-parse HEAD` **and** `status === "pass"`: cache hit — skip test run and proceed.
- Anything else (file missing, stale SHA, or `status !== "pass"`): run tests now:

  ```bash
  node "${CLAUDE_PLUGIN_ROOT}/scripts/record-test-result.js" run
  ```

  Append `--cwd "<path>"` when the operator passed `--cwd`. Use `timeout: 600000`. If exit non-zero: read the just-written `state/last-test.json` and include `likely_cause` in the message if present (`tests failed (exit 137, likely OOM) — fix and re-run /dev-pr`); otherwise FAIL `"tests failed (exit N) — fix and re-run /dev-pr"`. If exit 0: proceed.

  For suites longer than 10 min: run tests in a terminal, record with `node <PLUGIN_ROOT>/scripts/record-test-result.js write <exit_code> <duration_ms>` (append `--cwd "<path>"` when relevant), then re-run `/dev-pr`.

This is the gate that enforces CLAUDE-APPEND §Tests Before PR mechanically rather than relying on the agent's self-report.

**Known pre-existing failures on base — override protocol.** If tests fail because of failures pre-existing on base (not introduced by your branch), see [`../../docs/GATE-0-OVERRIDE.md`](../../docs/GATE-0-OVERRIDE.md) for the audited bypass steps. Never silently patch `last-test.json` — the protocol writes a `bypass` block that Gate 2 renders as a `### Gate 0 Override` audit section in the PR body so reviewers see the bypass.

**4. Commits-ahead check.** Resolve base branch — assign to `BASE` in this priority order:
1. `pr_base_branch` from config if set.
2. First non-glob entry of `protected_branches`.
3. `origin/HEAD` (`git symbolic-ref refs/remotes/origin/HEAD` → strip `refs/remotes/origin/`).
4. `main` or `master` if either exists locally or remotely.

Then:

```bash
git rev-list --count "$BASE..HEAD"
```

If 0: FAIL with `"nothing to PR — no commits ahead of $BASE"`.

### Gate 1 — push

```bash
git ls-remote --exit-code --heads origin "$CURRENT_BRANCH" 2>/dev/null
```

**No upstream (non-zero exit):** `git push -u origin "$CURRENT_BRANCH"`.

**Upstream exists — check divergence:**

```bash
REMOTE_SHA=$(git ls-remote origin "$CURRENT_BRANCH" | cut -f1)
AHEAD=$(git rev-list --count "$REMOTE_SHA..HEAD")
BEHIND=$(git rev-list --count "HEAD..$REMOTE_SHA")
```

- `BEHIND > 0`: FAIL `"remote has commits you don't — git pull --rebase first"`. Do NOT force-push (the `git-push-guard` hook blocks it at strict; the rule applies at every profile per CLAUDE-APPEND §Git Safety).
- `AHEAD > 0`: regular push: `git push origin "$CURRENT_BRANCH"`.
- Both 0: skip push, record `push: already up to date`.

On push failure: FAIL with stderr tail + recovery hint.

### Gate 2 — assemble title and body

Build the title and body inline, no helper script.

**Title.** Try in order:
1. If `state/bindings.json` has `bindings[branch].external.id` (e.g. `PROJ-123`) and `external.title`, format as `PROJ-123: <first-commit-subject>`.
2. Else: use the first commit's subject, with any conventional-commit prefix (`feat:`, `fix(scope):`, `chore:`, etc.) stripped.
3. Else: use the branch name with `/` replaced by `-`.

**Body.** Assemble the following sections in order (skip any whose source data is empty):

1. **Summary** — bullet list of commit subjects from `git log --first-parent <BASE>..HEAD --pretty=format:'%s'`. Strip conventional-commit prefixes first (`/^(feat|fix|docs|style|refactor|perf|test|chore|build|ci|revert)(\([^)]+\))?!?:\s*/i`), THEN deduplicate by exact post-strip string preserving first occurrence order. Heading `## Summary`, then `- <subject>` per line.

2. **Context** — if `state/bindings.json` has `bindings[branch].external = { source, id, url, title }`, emit a `## Context` heading followed by a single line containing a markdown link. The link text is the bold-wrapped string `<source> <id>` (e.g. `**Linear PROJ-123**`), the link target is `url`, and the line ends with ` — <title>`. Concrete example for `{source: "Linear", id: "PROJ-123", url: "https://linear.app/...", title: "fix login redirect"}` produces a single line beginning with `**` then the bold-bracketed link then ` — fix login redirect`. If `external.title` is missing, drop the ` — <title>` suffix. If `external.url` is missing, skip the section entirely.

3. **Verification** — read `state/last-test.json` (written by the `record-test-result` hook; Gate 0 step 3 already verified it exists, matches HEAD, and passed).

   **If `last-test.json.bypass` is absent**, render as:

   ```
   ## Verification

   - Tests: **pass** (12.3s)
   ```

   The duration is `last-test.json.duration_ms / 1000` rounded to one decimal (or `(unrecorded)` if `duration_ms` is null). Never invent results.

   **If `last-test.json.bypass` is present** (operator used the Gate 0 override protocol), render instead:

   ```
   ## Verification

   - Tests: **audited override** (reason: <bypass.reason>)

   ### Gate 0 Override

   - base_sha: <bypass.base_sha>
   - summary: <bypass.summary>
   ```

   Reproduce `bypass.reason`, `bypass.base_sha`, and `bypass.summary` verbatim from the JSON field. This section is the audit record visible to reviewers; never omit it when the bypass field is present.

4. **Screenshots** — if `.claude-code-hermit/raw/screenshots/<binding-id>/manifest.json` exists, emit a `## Screenshots` heading followed by one bullet per manifest entry. Each bullet is a markdown image: a leading `- ` then `!`, then the alt text in square brackets (the `criterion` field), then the source in parentheses (the `path` field). The `binding-id` is `bindings[branch].external.id` if present, else `branch.replace(/\//g, '-')`. If `config.scope === 'local'` and any path isn't a `https://` URL, add a note line below the bullets: `_Note: screenshots in raw/ are gitignored under local scope — they will appear as broken images in the PR._`

5. **Notes** — optional. Skip unless the operator passed in qualitative concerns through Gate 2 (out-of-scope follow-ups, known limitations) — there is no automatic source for this section.

**Project PR template.** Check in priority order: `pr_template_path` from config (operator override), then `.github/PULL_REQUEST_TEMPLATE.md`, then `.gitlab/merge_request_templates/Default.md`, then `.bitbucket/pull_request_template.md`, then `docs/pull_request_template.md`. Load the first one found and append it after the assembled body, separated by `\n\n---\n\n`. Do not attempt to merge headings or substitute sections — the project's template appears verbatim below ours.

### Gate 3 — create the PR

Write the body to a temp file (avoids shell-quoting issues with multi-line markdown). Use the `Write` tool with `file_path: $PR_BODY_TMP` (capture the path from `mktemp` via Bash first) and `content: <assembled body>`. Then dispatch based on `$TOOL` (derived in Gate 0 step 0b):

```bash
PR_BODY_TMP=$(mktemp)
# (Write tool wrote the body to $PR_BODY_TMP)

case "$TOOL" in
  gh)
    $PR_CREATE --title "$TITLE" --body-file "$PR_BODY_TMP" --base "$BASE"
    ;;
  glab)
    # glab mr create uses --description (string) and --target-branch, not --body-file/--base
    $PR_CREATE --title "$TITLE" --description "$(cat "$PR_BODY_TMP")" --target-branch "$BASE"
    ;;
  *)
    # Custom command: Gate 3 passes gh-style flags.
    # Wrap your CLI in a script that accepts --title --body-file --base if it uses different flags.
    $PR_CREATE --title "$TITLE" --body-file "$PR_BODY_TMP" --base "$BASE"
    ;;
esac

rm -f "$PR_BODY_TMP"
```

- Capture stdout; extract the first line matching `^https?://` as the PR URL.
- On any non-zero exit: print stderr tail and a tool-aware recovery hint:
  - `$TOOL == gh` → `"recovery: gh auth login"`
  - `$TOOL == glab` → `"recovery: glab auth login"`
  - `*` → `"recovery: check authentication for your forge CLI"`

### Gate 4 — record

**Write `state/bindings.json`** (atomic temp+rename): set `bindings[branch].pr_url = url`.

**Append to SHELL.md Progress Log:** `[HH:MM] PR opened: <url>`.

**Emit session-close nudge:** append to the report:
```
next: PR opened — consider /claude-code-hermit:session-close to wrap the session
```

## Output

```
dev-pr
  branch:   feature/proj-123-fix-login
  base:     main
  push:     pushed (3 commits)
  title:    PROJ-123: fix login redirect on expired session
  url:      https://github.com/org/repo/pull/456
  body:     4 sections, 2 screenshots embedded
  template: project (.github/PULL_REQUEST_TEMPLATE.md appended)
  status:   created
  next:     PR opened — consider /claude-code-hermit:session-close to wrap the session
```

On Gate 0 FAIL: name the failed check and give the exact command to satisfy it. Example:

```
dev-pr
  FAIL (Gate 0 — protected branch): cannot open PR from main
  recovery: create a feature branch (see CLAUDE-APPEND.md §Branch Discipline)
```

On Gate 3 FAIL: show the host-tool exit message + a one-line recovery hint.

## Rules

- **Never skips clean-tree or protected-branch checks.** No `--force` flag exists; the only escape is to fix the underlying condition.
- **Runs tests on cache miss.** If no fresh pass exists at HEAD, Gate 0 runs `record-test-result.js run` automatically. First `/dev-pr` after changes may take time; subsequent calls at the same HEAD hit cache instantly.
- **No screenshot creation.** Reads from `raw/screenshots/<binding-id>/manifest.json`. Producing screenshots is a stack-specific plugin's job.
- **No merge.** Opening the PR is the terminal step; merging is a separate operator decision.
- **Never force-push.** Even on divergence — surface the conflict, let the operator resolve. The `git-push-guard` hook blocks force-push at strict profile; this skill respects the same rule unconditionally.
- **Session→PR auto-link.** When `$TOOL == gh`, calling `gh pr create` via Bash preserves Claude Code's native session→PR linking. The operator can resume later with `claude --from-pr <number>`. This feature is GitHub-specific and does not apply for other forge tools.
