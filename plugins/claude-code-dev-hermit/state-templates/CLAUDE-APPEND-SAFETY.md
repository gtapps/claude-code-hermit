---
<!-- claude-code-dev-hermit: Development Workflow -->

## Git Safety (always applies)

These rules apply to every agent doing dev work in this project — the native `Agent` tool, custom subagents, the main session. The `git-push-guard` hook backs them at strict profile.

- **Never `git push`** from agent context. Stop and ask the operator. The sanctioned answer is `/claude-code-dev-hermit:dev-pr`, which runs Gate 0 checks then pushes + opens a PR. This forbids *improvised* pushes, not the push performed by that skill itself: while executing it, its Gate 1 push **is** the sanctioned action — run it, don't stop to ask.
- **Never use `--no-verify`** on any git command (commit, push, merge, rebase). Pre-commit hooks exist for a reason.
- **Never commit to a branch in `claude-code-dev-hermit.protected_branches`** (defaults to `main`/`master` if unset). Always work on a feature branch.
- **Never force-push from agent context.** No bare `--force` or `-f`. `--force-with-lease` is allowed only to a non-protected branch with an explicit refspec (the safe rebase-recovery case); ambiguous-target leases and leases to protected branches are blocked. When in doubt, surface the divergence and let the operator resolve.
- **Stay in your worktree.** When the session runs in a git worktree, never edit files in the original checkout or a sibling worktree — that's another session's territory. The `worktree-boundary-guard` hook hard-blocks edits that escape the worktree. In a **background** session the harness moves you into a worktree automatically on your first edit, so don't proactively call `EnterWorktree`, and don't treat an "isolate first" message as a rule violation or a reason to stop and ask: just re-attempt the edit.

If a task would require violating these rules, stop and ask the operator. Do not attempt workarounds (alternate commands, env vars, manual git plumbing).

## Branch Discipline

If the project's own CLAUDE.md or skills define a branch-naming convention (e.g. `<short-slug>/vX.Y.Z` for plugin releases, ticket-prefixed branches, or anything else), follow that. The naming rules below are the fallback for projects without one.

Before starting code changes:

1. Verify clean working tree (`git status --porcelain` returns empty). If dirty, stop and surface the diff — let the operator commit or stash before proceeding.
2. Branch from the first entry of `claude-code-dev-hermit.protected_branches` (defaults to `main`). Use `git checkout -b <prefix>/<slug> origin/<base>` so the new branch tracks the latest remote.
3. Name the branch `<prefix>/<slug>` where `prefix ∈ {feature, fix, chore, hotfix}`. Detect the prefix as the longest match of `hotfix|feature|fix|chore` at the start of the input (case-insensitive, treated as a word). Otherwise default to `feature`.
4. Append a one-line entry to `.claude-code-hermit/sessions/SHELL.md` Progress Log: `[HH:MM] created branch <name> from <base>`.

### Slug rules (apply to the description portion only, never the prefix)

1. Lowercase the input.
2. Replace whitespace runs with a single `-`.
3. Drop any character not in `[a-z0-9-]`.
4. Collapse consecutive `-` into one.
5. Strip leading and trailing `-`.

`/` is preserved only as the prefix separator. Mid-description `/` becomes `-`.

Examples: `PROJ-123 add auth flow` → `feature/proj-123-add-auth-flow`. `Fix login redirect (urgent!)` → `fix/login-redirect-urgent`. `feature/foo/bar` → `feature/foo-bar`.

## Technical Constraints

Subagents can invoke skills and spawn nested subagents. For delegated sub-steps the contract is: the subagent returns a verdict (plus an optional `operator_message`), and the **main session owns `AskUserQuestion` and operator notification**.

Session state (`in_progress`/`waiting`/`idle`/`dead_process`) lives in `.claude-code-hermit/state/runtime.json` (`.session_state`). SHELL.md `Status:` is cosmetic — never parse it for programmatic checks.

Core rules (artifact frontmatter, tag discipline, proposals) apply to all dev work — see the `## Session Discipline (claude-code-hermit)` block above.

## Before Archiving a Task

- PR opened.
- Feature branch committed, no uncommitted changes.
- If partial: Session Summary describes what remains.

## Dev Session Hygiene

- **Tasks**: skip TaskCreate for trivial single-step tasks; serialize and delete all Tasks at task boundaries.
- **Progress Log**: if entries exceed 50, summarize older entries into a compact block; keep last 10 in detail.

## Dev Knowledge

Dev artifacts that persist across sessions go to `compiled/` with frontmatter (`title`, `created`, `type`, `tags`). Examples: architecture decisions, codebase health assessments, review pattern summaries, dependency audit snapshots. Ephemeral inputs (CI logs, code snapshots under analysis) go to `raw/`. Lessons and patterns go to auto-memory — don't duplicate into `compiled/`. If the project has a `knowledge-schema.md`, consult it before writing any `compiled/` artifact — it defines what the hermit produces and when.

## Dev Proposal Categories

Use these prefixes in proposal titles for consistent sorting:
- **[missing-tests]** — Uncovered code paths
- **[tech-debt]** — Code that works but should be refactored
- **[dependency]** — Stale, vulnerable, or unnecessary deps
- **[tooling]** — Missing linter rules, CI checks, dev scripts
- **[architecture]** — Structural improvements

All dev proposals must pass the three-condition gate: (1) repeated pattern across sessions, (2) meaningful consequence if unaddressed, (3) operator-actionable change. Exception: ideas surfaced by `/claude-code-dev-hermit:domain-brainstorm` are single-pass — the brainstorm establishes the candidate, so condition (1) is waived (conditions 2 and 3 still apply).

Tier mapping:
- **Tier 2** (micro-approval): `[tech-debt]`, `[tooling]`, `[dependency]` updates
- **Tier 3** (full PROP-NNN): `[missing-tests]`, `[architecture]`, `[dependency]` removals

## Dev Quick Reference

- One-time setup / re-config: `/claude-code-dev-hermit:hatch`
- Cleanup pass: `/claude-code-hermit:simplify` (parallel reviewers, applies its own edits)
- Parallel changes across many files: `/batch` (built-in)
- Diagnostics: `/debug` (built-in)
- High-stakes review: `/code-review` (built-in)
