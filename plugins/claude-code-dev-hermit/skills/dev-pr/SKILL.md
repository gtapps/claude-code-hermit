---
name: dev-pr
description: Open a PR from the current feature branch with a body assembled inline from commit history, the test command's last output, screenshots, and an optional project PR template. Refuses on protected branches, dirty trees, or zero commits ahead. Run as the final step of a ticket.
---

# /dev-pr

Push the current branch and open a PR with a structured body. Reads commit history, the test results you just ran (per `state-templates/CLAUDE-APPEND.md` §Tests Before PR), any screenshots in `raw/screenshots/`, and an optional project PR template — assembles them into title + body — then calls `gh pr create` (or the configured equivalent).

## Prerequisites

- Verify `.claude-code-hermit/sessions/` exists. If not: tell the operator to run `/claude-code-hermit:hatch` and `/claude-code-dev-hermit:hatch` first.
- Read `.claude-code-hermit/config.json` once. Cache `claude-code-dev-hermit.protected_branches` (defaults to `["main", "master"]`), `commands.pr_create` (defaults to `gh pr create`), `pr_base_branch`, `pr_template_path`.

## Plan

### Gate 0 — preconditions

Run all four checks in order. FAIL on the first failure, name it, give the exact command to fix it.

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

**3. Tests-ran check.** Read `.claude-code-hermit/state/last-test.json` (written by the `record-test-result` `PostToolUse` hook whenever the configured `commands.test` runs via Bash). Three failure modes:

- File missing: FAIL `"no test result recorded — run the configured test command (commands.test) before /dev-pr; if commands.test is unset, run /claude-code-dev-hermit:hatch to configure it"`.
- `sha !== current HEAD`: FAIL `"last test run was on <sha>, now at <head> — re-run commands.test"`.
- `status !== 'pass'`: FAIL `"last test run failed (exit <exit_code>) — fix and re-run commands.test"`.

This is the gate that enforces CLAUDE-APPEND §Tests Before PR mechanically rather than relying on the agent's self-report.

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

3. **Verification** — read `state/last-test.json` (written by the `record-test-result` hook; Gate 0 step 3 already verified it exists, matches HEAD, and passed). Format:

   ```
   ## Verification

   - Tests: **pass** (12.3s)
   ```

   The duration is `last-test.json.duration_ms / 1000` rounded to one decimal (or `(unrecorded)` if `duration_ms` is null). Lint / typecheck / format runs may be added if `state/last-test.json` is later extended to record those (current implementation tracks only the test command). Never invent results.

4. **Screenshots** — if `.claude-code-hermit/raw/screenshots/<binding-id>/manifest.json` exists, emit a `## Screenshots` heading followed by one bullet per manifest entry. Each bullet is a markdown image: a leading `- ` then `!`, then the alt text in square brackets (the `criterion` field), then the source in parentheses (the `path` field). The `binding-id` is `bindings[branch].external.id` if present, else `branch.replace(/\//g, '-')`. If `config.scope === 'local'` and any path isn't a `https://` URL, add a note line below the bullets: `_Note: screenshots in raw/ are gitignored under local scope — they will appear as broken images in the PR._`

5. **Notes** — optional. Skip unless the operator passed in qualitative concerns through Gate 2 (out-of-scope follow-ups, known limitations) — there is no automatic source for this section.

**Project PR template.** If `pr_template_path` is set in config, OR `.github/PULL_REQUEST_TEMPLATE.md` exists, OR `docs/pull_request_template.md` exists — load the first one found and append it after the assembled body, separated by `\n\n---\n\n`. Do not attempt to merge headings or substitute sections — the project's template appears verbatim below ours.

### Gate 3 — create the PR

Write the body to a temp file (avoids shell-quoting issues with multi-line markdown). Use the `Write` tool with `file_path: $PR_BODY_TMP` (capture the path from `mktemp` via Bash first) and `content: <assembled body>`. Then:

```bash
PR_BODY_TMP=$(mktemp)
# (Write tool wrote the body to $PR_BODY_TMP)
gh pr create --title "$TITLE" --body-file "$PR_BODY_TMP" --base "$BASE"
# or the configured commands.pr_create
rm -f "$PR_BODY_TMP"
```

- Capture stdout; extract the first line matching `^https?://` as the PR URL.
- If stdout/stderr contains `pull request already exists`: ask the operator (`AskUserQuestion`: `Update existing PR body` / `Cancel`). On Update, run `gh pr edit <number> --body-file "$PR_BODY_TMP"`.
- On `gh auth` error in stderr: FAIL `"not authenticated — run: gh auth login"`.
- On any non-zero exit: FAIL with stderr tail + exit code.

### Gate 4 — record

**Write `state/bindings.json`** (atomic temp+rename): set `bindings[branch].pr_url = url`.

**Append to SHELL.md Progress Log:** `[HH:MM] PR opened: <url>`.

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
- **No code edits, no test runs.** Run tests yourself (per CLAUDE-APPEND §Tests Before PR) before invoking `/dev-pr`. This skill is a push-and-create operation only.
- **No screenshot creation.** Reads from `raw/screenshots/<binding-id>/manifest.json`. Producing screenshots is a stack-specific plugin's job.
- **No merge.** Opening the PR is the terminal step; merging is a separate operator decision.
- **Never force-push.** Even on divergence — surface the conflict, let the operator resolve. The `git-push-guard` hook blocks force-push at strict profile; this skill respects the same rule unconditionally.
- **Session→PR auto-link.** Calling `gh pr create` via Bash preserves Claude Code's native session→PR linking. The operator can resume this session later with `claude --from-pr <number>`.
