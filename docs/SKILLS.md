# Skills Reference

Three skills, each invoked with `/claude-code-dev-hermit:`.

---

## hatch

One-time project setup. Run after `/claude-code-hermit:hatch`.

**What it does:**

1. Checks prerequisites (core v1.0.0+, Task List ID configured)
2. Appends the dev workflow block to CLAUDE.md (or replaces it if reinitializing)
3. Runs a setup wizard:
   - Auto-detects branch naming, protected branches, CI config, test commands
   - Asks about hook profile, deploy process, code review expectations
   - Offers companion plugins (code-review, feature-dev, context7)
4. Suggests dev-specific heartbeat items (test suite, uncommitted changes, stale branches, dependency audits)
5. Registers `scheduled_checks` entries for installed companion plugins (feature-dev)
6. Stamps the plugin version in config.json

**Idempotent.** Running it again detects the existing setup and offers to reinitialize — useful after plugin updates.

---

## dev-quality

Post-implementation quality gate. Run after code changes are done, before marking a task complete.

**What it does:**

1. Runs tests — if they fail, stops immediately (fix the code first)
2. Runs `/simplify` on changed files (its parallel review agents cover reuse, quality, and efficiency)
3. Runs tests again — if `/simplify` broke something, it reverts and proceeds with the pre-simplify code

**Output:** test status (before/after simplify), whether simplify was applied or reverted.

For PR review, security-sensitive code, or large refactors where git history context matters, invoke `code-review:code-review` explicitly after the quality pass.

---

## dev-cleanup

Branch cleanup utility. Use when local branches have accumulated across sessions.

**What it does:**

1. Finds merged branches (`git branch --merged main`)
2. Finds stale branches (no recent commits)
3. Cross-references active work — SHELL.md, all session reports, NEXT-TASK.md
4. Presents a table with status and suggestions
5. Asks which branches to delete
6. Deletes confirmed branches safely

**Safety rules:**
- Never deletes current branch or main/master
- Never force-deletes without per-branch confirmation
- Local only — never touches remote branches
- Cross-references all session reports and NEXT-TASK.md — never deletes branches tied to pending work
- Skips branches tied to `waiting` sessions (e.g., PR submitted, awaiting review)
- Logs all deletions to SHELL.md

---

## Agent: implementer

Not a skill, but central to the workflow. Invoked automatically during the dev workflow's implementation step.

| Property | Value |
|----------|-------|
| Model | Sonnet |
| Max turns | 50 |
| Isolation | Worktree (separate git branch) |
| Memory | Project-scoped |

**Allowed tools:** Read, Write, Edit, Bash, Glob, Grep
**Disallowed:** WebSearch, WebFetch (keeps it focused on the codebase)

**Safety rules:** see [Git Safety](GIT-SAFETY.md) — no push, no `--no-verify`, no commits to main, no out-of-scope changes.

**Returns:** structured summary with changes, files modified, test results, concerns, and branch name.
