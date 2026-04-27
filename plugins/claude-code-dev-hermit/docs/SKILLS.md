# Skills Reference

Ten skills, each invoked with `/claude-code-dev-hermit:`.

---

## hatch

One-time project setup. Run after `/claude-code-hermit:hatch`.

**What it does:**

1. Checks prerequisites (core v1.0.18+, Task List ID configured)
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

## dev-adapt

Project profiling. Run after hatch or whenever the project's test or CI setup changes.

**What it does:**

1. Reads package manifests, CI configs, README, OPERATOR.md, and existing config in parallel
2. Detects test, typecheck, and lint commands with a confidence rating (high / medium / low)
3. Detects protected branches from CI config and git history
4. Detects commit format (conventional / gitmoji / freeform) from the last 50 commits
5. Confirms medium- and low-confidence values via `AskUserQuestion`; auto-confirms high-confidence
6. Writes confirmed values to `.claude-code-hermit/config.json` under `claude-code-dev-hermit.*`
7. Writes a compiled `dev-profile-<date>.md` artifact for future sessions

**Config keys written:** `commands.test`, `commands.typecheck`, `commands.lint`, `commands.dev_start`, `commands.dev_stop`, `protected_branches`, `commit_format`, `commit_format_pattern`, `dev_required_ports`, `dev_expected_listeners`, `dev_health_url`, `dev_health_timeout_secs`, `dev_auth_check`, `dev_log_path_pattern`, `dev_error_pattern`, `dev_noise_pattern`. The `dev_*` group is written only when the project has a service-on-port dev workflow (mobile, desktop, library, embedded projects skip these).

---

## dev-branch

Feature-branch creation gate. Run before delegating to the implementer or starting direct edits on a fresh task.

**What it does:**

Validates the repo state and creates a named branch through eight gates:

1. **Prerequisites** — `.claude-code-hermit/sessions/` must exist
2. **Gate 0** — already on a non-protected branch → short-circuit
3. **Gate 1** — clean working tree
4. **Gate 2** — fetch from origin (soft-fail if offline)
5. **Gate 3** — resolve base from `protected_branches[0]` (skip glob entries), then `origin/HEAD`, then `main`/`master`
6. **Gate 4** — no worktree collision (`git worktree list --porcelain`)
7. **Gate 5** — no branch-name collision (local + remote; remote skipped if offline)
8. **Gate 6** — `git checkout -b <name> origin/<base>`
9. **Gate 7** — append creation to SHELL.md Progress Log

Does not push.

**Argument shapes:**
- Full branch name with prefix (`feature/PROJ-123-add-auth`) — used as-is
- Bare description (`PROJ-123 add auth`) — operator picks prefix; description is slugified

**Note:** the `implementer` agent creates its own branch inside its worktree independently. `/dev-branch` is for the main session.

---

## dev-up

Boot the dev server in a Monitor-managed subprocess. Run before browser-testing or any task that exercises the running app.

**What it does:** seven gates — config check, idempotency probe (skip if a dev-server monitor is already running and healthy), optional auth probe, port-free-or-allowlisted check (lsof primary, ss fallback), tool availability, register a Monitor entry that runs `commands.dev_start`, optional HTTP health-poll until 2xx (timeout configurable via `dev_health_timeout_secs`).

**Lifetime is session-scoped.** The Monitor stops on `/session-close` and on the next session-start. For a long-lived server, run it in your own tmux/systemd/foreman.

**Required config:** `commands.dev_start`. Optional: `dev_required_ports`, `dev_expected_listeners`, `dev_health_url`, `dev_auth_check`. Configure via `/dev-adapt`.

**Encore-style daemon false-positives:** add the daemon's port + process_match regex to `dev_expected_listeners`. The port-check helper allowlists matched listeners.

**Targets:** the service-on-port + HTTP archetype — Node (Next/Nuxt/Vite/Express/NestJS/Fastify), Python (Django/Flask/FastAPI), Ruby on Rails, Java (Spring Boot/Quarkus), PHP (Laravel `artisan serve`, Symfony `symfony serve`, vanilla `php -S`), Go, Rust, static-site generators (Hugo/Jekyll/Astro), monorepo umbrella commands (nx/turbo), docker-compose. Out of scope: mobile dev, desktop apps (Electron/Tauri), embedded/firmware — those have multi-process or device-coupled lifecycles this skill does not model.

---

## dev-down

Stop the session-scoped dev server registered by `/dev-up`.

**What it does:** three gates — confirm a `dev-server` Monitor exists; stop it via `commands.dev_stop` (e.g., `docker compose down`) if configured, otherwise via the watch skill's SIGTERM → 10s drain → SIGKILL; re-probe ports and warn if anything unexpected still binds. Custom `dev_stop` is required for compose / supervisord / foreman setups whose process tree the Monitor's signal cannot reach.

---

## dev-log-watch

Generate a Monitor entry that tails the dev-server log file for error patterns. Run once per project during onboarding.

**What it does:** four gates — config check (`dev_log_path_pattern` + `dev_error_pattern` required); build the canonical bash one-liner via `scripts/lib/log-watch-builder.js`, which detects `$(date ...)` substrings and emits the midnight while-loop wrapper for date-rotating logs (Winston/Pino/structlog) or plain `tail -F` for fixed paths (Rails `log/development.log`); verify the log directory exists; register either persistently into `config.monitors[]` (auto-registers each session) or ad-hoc for the current session only.

**Use only for file logs.** stdout/journald/Docker stacks have native primitives — see `docs/DEV-LOG-WATCH.md` `## Use instead`.

---

## dev-status

One-shot read-only status. Run any time you want to know "is the server up? what branch am I on? is anything stale?" without scanning three places.

**What it does:** three lines of output — branch state (current branch, dirty/clean, ahead/behind upstream), dev-server monitor state (registry presence, pid liveness, optional health probe via `scripts/lib/health-poll.js` with 3s timeout), worktree state (active count + sample, prunable count + sample with the `git worktree prune` recovery hint).

**Read-only.** Names commands the operator can run (`/dev-down`, `git worktree prune`) but never executes them. No FAIL gates; if a section's read fails, that section reports `(read failed)` and the others continue.

**No port probes, no SHELL.md parse, no dev-log-errors monitor reporting** — different questions, different skills (`/dev-up`, native `git status`, `/watch status`).

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

## dev-doctor

Setup health check. Diagnoses whether the project is correctly configured for the implementer agent to operate safely.

**What it does:**

Runs 17 dev-specific checks and produces a `PASS / WARN / FAIL` report. Manual mode also composes core validators (`/smoke-test`, `hermit-config-validator`, `/hermit-doctor`).

| # | Property checked |
|---|---|
| 1 | Core hermit version ≥ required |
| 2 | Dev workflow marker in CLAUDE.md |
| 3 | always_on requires strict hook profile |
| 4 | Protected branches configured (**FAIL** if missing or empty) |
| 5 | Test command binary reachable (via `scripts/lib/resolve-command.js`) |
| 6 | Typecheck or lint configured |
| 7 | Worktree support (`git worktree list`) |
| 8 | git-push-guard.js parses cleanly |
| 9 | .gitignore covers state dir and secret files |
| 10 | Test command safety (no destructive patterns) |
| 11 | commit_format and commit_format_pattern consistent |
| 12 | `.claude/worktrees/` gitignored |
| 13 | `.worktreeinclude` covers hermit config |
| 14 | Auto-loaded env files free of credential-like keys |
| 15 | Dev start command binary reachable (via the same resolver helper) |
| 16 | Dev log path parent directory exists |
| 17 | Dev required ports valid range; expected_listeners ports ⊆ required_ports |

Concludes with a machine-readable `Safe for implementer: yes|no` line.

**Modes:**
- **Manual** — full check including core validators; side effects allowed
- **Scheduled** — dev-specific checks only, no side effects; runs weekly if registered via hatch

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
