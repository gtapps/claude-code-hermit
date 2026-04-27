
---
<!-- claude-code-dev-hermit: Development Workflow -->

## Dev Agent (claude-code-dev-hermit)

| Agent | When to use | Model |
|-------|------------|-------|
| `claude-code-dev-hermit:implementer` | Writing code, bug fixes, refactoring (worktree isolated) | Sonnet |

## Git Safety

- Never push to any branch in `claude-code-dev-hermit.protected_branches` (defaults to `main`/`master` if unset)
- Never use `--no-verify` on git commands
- Always create feature branches for work

## Technical Constraints

Subagents cannot invoke skills (/simplify, /batch, etc.) — those must run in the main session only.

Session state (`in_progress`/`waiting`/`idle`/`dead_process`) must be read from `.claude-code-hermit/state/runtime.json` (`.session_state`). SHELL.md `Status:` is cosmetic — never parse it for programmatic checks.

Core rules (artifact frontmatter, tag discipline, proposals) apply to all dev work — see the `## Session Discipline (claude-code-hermit)` block above.

## Dev Workflow

When doing development work:

1. **Plan**: break the task into steps, create a Task for each

   > **Optional planning gate (non-trivial code only)** — if `/feature-dev:feature-dev` is installed and the task touches a code path you haven't read end-to-end, or uses a framework feature you can't explain from memory (e.g. framework lifecycle hooks, ORM internals, build-tool plugins, auth middleware, request-time vs boot-time resolution), run it first. The trigger is **unfamiliarity, not urgency** — a hotfix touching unfamiliar wiring is exactly when slowing down pays off. Record the chosen architecture in the Task description or Progress Log before invoking the implementer. **Skip for**: doc/prompt/config edits, single-line fixes, and changes you already know how to make.

2. **Implement**: First, run `/claude-code-dev-hermit:dev-branch <description>` (no-op if already on a feature branch). Then, before invoking the implementer, read `.claude-code-hermit/config.json` and pass the following values in the implementer's prompt (these may not be visible inside the worktree if the state dir is gitignored): `claude-code-dev-hermit.protected_branches`, `claude-code-dev-hermit.commit_format`, `claude-code-dev-hermit.commit_format_pattern`, `claude-code-dev-hermit.commands.test`. Then invoke `claude-code-dev-hermit:implementer` for code changes (worktree-isolated feature branches).
3. **After implementer returns**: read `Worktree:` and `Branch:` from the implementer's summary. Then — if the main working tree is dirty, stop and surface the conflict to the operator before proceeding. Otherwise: (a) `git worktree prune` — clears stale refs if the runtime auto-cleaned the worktree; (b) check `git worktree list --porcelain` for the worktree path — if present, run `git worktree remove <path>`; if absent, skip; (c) if `git worktree remove` fails due to a dirty worktree, stop and surface to the operator, do not `--force`; (d) `git checkout <branch>`. Then update SHELL.md — log branch name in Progress Log, append changed files to Changed section, note any test failures or concerns in Blockers. **Before overriding any implementer choice**: if the implementer produced tests, run them first; if they pass, treat the choice as potentially load-bearing and trace the framework/library behavior before replacing it with a more idiomatic-looking alternative. If no tests exist, trace before overriding.
4. **Quality pass**: run `/claude-code-dev-hermit:dev-quality` (this wraps `/simplify` plus test invocation — don't call `/simplify` directly at end-of-task; reserve it for mid-task cleanup or post-`/batch` follow-up)
5. **If critical issues**: loop back to implementation before proceeding
6. **Task boundary**: invoke `reflect`, serialize and delete all Tasks

   > Reflect also runs as a daily routine (9am). Fresh hermits (<3 days old) produce fewer proposals — this is the `newborn` phase and is expected.
   >
   > Suppressed candidates appear in the Progress Log with a structured code (`no-evidence`, `weak-recurrence`, `weak-consequence`, `not-actionable`, `no-sessions`) — useful for tuning proposal tiers.

7. **If blocked**: when waiting on external input (PR review, operator decision, CI pipeline), set session status to `waiting` with a reason. Resume on unblock.

First session (no prior `S-*-REPORT.md` files): explore the codebase to orient yourself before starting work.

### Parallel Work

- Same change across many files: use `/batch`
- Independent tasks in different areas: use multiple Agent tool calls in a single message, otherwise implement sequentially
- When unsure: ask the operator
- After parallel work: run `/simplify` and re-check constraints in main session (workers lack skill and OPERATOR.md access)

### Local Dev Environment

For tasks that need the running app (browser-testing, API integration checks, anything that exercises live behaviour):

- Run `/claude-code-dev-hermit:dev-up` before the task. It boots the dev server in a Monitor-managed subprocess so its stdout/stderr surface as conversation notifications.
- Run `/claude-code-dev-hermit:dev-down` at task close, or before switching to a task that doesn't need the server.
- Configure once via `/claude-code-dev-hermit:dev-adapt` — sets `commands.dev_start`, `dev_required_ports`, `dev_health_url`, and (optionally) `dev_auth_check`, `dev_expected_listeners`, `dev_log_path_pattern`.

**Lifetime is session-scoped.** `/dev-up` boots a Monitor that stops on `/session-close` and on the next session-start (per the core `watch` skill — monitors are session-scoped). For a long-lived server that survives across sessions, run it in your own tmux/systemd/foreman and treat the agent as a client.

**Operator-invoked, no auto-trigger.** `/dev-up` does not fire automatically on session-start, browser-testing tasks, or implementer flows — operators run it intentionally. To auto-fire on specific task shapes, add a project memory rule (e.g., "Whenever I start a browser-testing task, invoke /dev-up first"); do not seek a config flag for it.

**Error surfacing:** for projects whose dev server logs to a **file** (Winston/Pino daily, Rails `log/development.log`, structlog), run `/claude-code-dev-hermit:dev-log-watch` once during onboarding. It writes a Monitor entry into `config.monitors[]` that auto-registers each session and surfaces matched log lines as notifications. For stdout/journald/Docker stacks, see `docs/DEV-LOG-WATCH.md` `## Use instead`.

**Quick status read:** `/claude-code-dev-hermit:dev-status` returns three lines — current branch state, dev-server monitor health, and worktree refs (active + prunable). Read-only; useful any time you want to answer "is the server up? what branch am I on? is anything stale?" without scanning three places.

### Before Archiving a Task

- `/claude-code-dev-hermit:dev-quality` passed (tests + simplify)
- Feature branch committed, no uncommitted changes
- If partial: Session Summary describes what remains

## Dev Session Hygiene

- **Tasks**: skip TaskCreate for trivial single-step tasks; serialize and delete all Tasks at task boundaries
- **Progress Log**: if entries exceed 50, summarize older entries into a compact block; keep last 10 in detail

## Dev Knowledge

Dev artifacts that persist across sessions go to `compiled/` with frontmatter (`title`, `created`, `type`, `tags`). Examples: architecture decisions, codebase health assessments, review pattern summaries, dependency audit snapshots. Ephemeral inputs (CI logs, code snapshots under analysis) go to `raw/`. Lessons and patterns go to auto-memory — don't duplicate into `compiled/`. If the project has a `knowledge-schema.md`, consult it before writing any `compiled/` artifact — it defines what the hermit produces and when.

## Dev Proposal Categories

Use these prefixes in proposal titles for consistent sorting:
- **[missing-tests]** — Uncovered code paths
- **[tech-debt]** — Code that works but should be refactored
- **[dependency]** — Stale, vulnerable, or unnecessary deps
- **[tooling]** — Missing linter rules, CI checks, dev scripts
- **[architecture]** — Structural improvements

All dev proposals must pass the three-condition gate: (1) repeated pattern across sessions, (2) meaningful consequence if unaddressed, (3) operator-actionable change.

Tier mapping:
- **Tier 2** (micro-approval): `[tech-debt]`, `[tooling]`, `[dependency]` updates
- **Tier 3** (full PROP-NNN): `[missing-tests]`, `[architecture]`, `[dependency]` removals

## Dev Quick Reference

- Quality pass: `/claude-code-dev-hermit:dev-quality`
- Branch cleanup: `/claude-code-dev-hermit:dev-cleanup`
- Manage routines (reflect 9am daily, dev-cleanup weekly if enabled): `/claude-code-hermit:hermit-routines`
