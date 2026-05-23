# claude-code-hermit (monorepo)

This repo is a multi-plugin Claude Code marketplace. Four plugins ship from `plugins/<slug>/`:
`claude-code-hermit` (core), `claude-code-dev-hermit`, `claude-code-homeassistant-hermit`, `claude-code-fitness-hermit`.
Each plugin has its own `CLAUDE.md`, `CHANGELOG.md`, and `tests/` — read those for plugin-specific context.

The top-level `.claude-plugin/marketplace.json` is the only marketplace. The README at the repo root is the canonical hermit pitch.

Always launch Claude Code from this repo's root, not from inside a plugin dir. Auto-memory is keyed by CWD, and plugin dirs contain their own `.claude-plugin/` (launching there can load the plugin under test as the project plugin). Per-plugin `CLAUDE.md` files load on demand when you touch their files.

## Conventions

- **Per-plugin paths**: every plugin lives at `plugins/<slug>/`. Tests, scripts, skills, agents, hooks, state-templates, docs, CHANGELOG, CLAUDE.md all live inside that dir.
- **Tests run from inside the plugin dir**: each plugin has its own runner — `bash tests/run-all.sh` for core and HA, `node scripts/*.test.js` for dev-hermit. Helpers use CWD-relative paths and break if invoked from repo root.
- **Tag format**: `<slug>--v<X.Y.Z>` (double-dash, e.g. `claude-code-hermit--v1.0.20`).
- **Independent versioning**: each plugin's `plugin.json` bumps on its own cadence. Domain plugins declare core compat via `required_core_version: ">=X.Y.Z"` (semver range, not pin).
- **Dependency fields**: `required_core_version` and `requires` live in `.claude-plugin/hermit-meta.json` (hermit-internal, validator-invisible). `dependencies` is the native Claude Code resolver field in `plugin.json`. `required_core_version` is authoritative — read by `plugins/claude-code-hermit/scripts/doctor-check.js` from `hermit-meta.json`. `requires` mirrors it for documentation. Update all three when the core version requirement changes. All hermit-internal manifest extensions (`hermit.*`, etc.) belong in hermit-meta.json.
- **Marketplace.json bumps**: only the matching plugin's entry. The release skill takes a slug arg: `/release <plugin-slug>`.

## Commits

- **Use `/commit` for every commit in this repo.** It detects which plugin's scope the diff belongs to, routes the CHANGELOG entry to that plugin's `CHANGELOG.md`, and path-scopes staging (never `git add -A`). The skill enforces "one plugin per commit" — cross-plugin changes are split into separate `/commit` runs. Run `/dev-quality` before `/commit` — it handles the code-review pass.
- Root-scope edits (CI, root README, `.claude/`, `.claude-plugin/marketplace.json`) skip the CHANGELOG step entirely — they don't ship to operators. `/commit` handles that automatically.
- Releases still go through `/release <slug>`, which promotes a plugin's `[Unreleased]` section to a real version. `/commit` accumulates those entries during day-to-day work.
- **Where these skills live**: `/commit`, `/release`, `/release-status`, `/fleet-release`, `/test-run`, `/tackle-issue` are repo-internal skills under `.claude/skills/` — they're not shipped to operators, only used during monorepo dev. Use `/release-status` for a read-only pipeline snapshot before any release session; use `/fleet-release` when multiple plugins change together on one branch (handles dep ordering and `required_core_version` sync automatically).
- **Changelog style: terse like [Claude Code's CHANGELOG](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md).** Each `### Added / Changed / Fixed` bullet is 1–3 lines, `- **component: what changed** — short rationale if non-obvious.` Rationale, debugging context, and design tradeoffs go in the commit message and PR description, not the bullet. The verbose form is reserved for `### Upgrade Instructions`, which `hermit-evolve` reads imperative-step-by-step. The `/commit` and `/release` skills enforce this; the convention lives here for any agent that bypasses them.
- **`/release` is operator-initiated — don't auto-suggest it.** Don't propose `/release <slug>` or `/fleet-release` in plans, summaries, or "next steps." Wait for an explicit ship/release/version request. `/dev-pr` is the normal end of feature/fix flow and is welcome to suggest. `/release-status` is read-only and fine to suggest when checking pipeline state.

## Branching

- **Default: PR `fix/<N>-<slug>` / `feat/<N>-<slug>` / `chore/<slug>` branches to `main`.** Same flow for contributors and maintainer. `<N>` is the GH issue number (omit if no issue), `<slug>` is a short kebab-case descriptor. Examples: `fix/44-self-update-race`, `feat/57-cortex-tagging`, `chore/upgrade-node-24`. Regular merge to `main`.
- **Why main is safe as staging.** Claude Code's `/plugin update` only fires when `version` in `plugin.json` changes ([docs](https://code.claude.com/docs/en/plugins-reference#version-management)). Commits on `main` between releases are invisible to operators on the standard install path — `/release <slug>` is the actual ship event because it bumps `version` and promotes `[Unreleased]` → `[X.Y.Z]`. Caveats: brand-new installers and `--plugin-dir` testers get whatever is on `main` HEAD, so don't leave `main` knowingly broken for long.
- **Tags ship to operators on next `/plugin update`.** The `version` bump inside `/release` is the gate — pre-release commits on `main` don't reach `/plugin update` users until that bump happens.

## Layout gotchas

- **Sibling-scan pattern**: `${CLAUDE_PLUGIN_ROOT}/../*/.claude-plugin/plugin.json` resolves to `plugins/*/...` and finds all fleet plugins as guaranteed siblings.
- **Old standalone repos are redirect-only zombies**: `gtapps/claude-code-dev-hermit` and `gtapps/claude-code-homeassistant-hermit` exist but their `marketplace.json` redirects to this monorepo via `git-subdir`. **Do not push code there.** All work happens here.

## Environment quirks

- **Secrets:** env vars → `.env` (gitignored); secret files (`.pem` etc.) → `.claude.local/` (gitignored). Never `.claude/` — it's checked in.
- **Docker paths mirror the host** (`${PWD}:${PWD}` mount) — absolute paths are identical inside the container despite the container user being `claude`.
- **`rm -rf` is blocked** by the `enforce-deny-patterns` hook. Use `rm -r` (no `-f`) for scratch cleanup.
- **Subtree imports are unsquashed**: `git log --first-parent` for the monorepo-only view; full upstream commits live under each subtree merge.
- **CI is not path-filtered yet**: every plugin's tests run on every PR. Don't assume a HA-test failure on a core-only PR is your fault.
- **Shell `cd` persists across Bash calls.** Any `cd` in a Bash call leaves CWD pinned for subsequent Bash calls in the session — affects CWD-relative scripts like `heartbeat-precheck.js .claude-code-hermit` (silently `SKIP|HEARTBEAT.md missing`) and commands like `git add`. Plugin test runners (`bash plugins/<slug>/tests/run-all.sh`) end inside `plugins/<slug>/`. Use absolute paths or prefix `cd /home/d0m/Projects/gtapps/claude-code-hermit && …`.

## Rules

- Always use Context7 for library/API documentation, code generation, and setup/configuration steps — don't wait for an explicit request.
- Don't overengineer.
- **This hermit is the plugin-dev special case.** When reasoning about utility of features in `plugins/claude-code-hermit/` (the shipped hermit), don't use this hermit's session history as evidence — the operator here maintains the plugin source. Target users are downstream operators who interact via Discord/Telegram and don't open `feat/PROP-NNN-*` branches.
---
<!-- claude-code-dev-hermit: Development Workflow -->

## Git Safety (always applies)

These rules apply to every agent doing dev work in this project — the native `Agent` tool, custom subagents, the main session. The `git-push-guard` hook backs them at strict profile.

- **Never `git push`** from agent context. Stop and ask the operator. The sanctioned answer is `/claude-code-dev-hermit:dev-pr`, which runs Gate 0 checks then pushes + opens a PR.
- **Never use `--no-verify`** on any git command (commit, push, merge, rebase). Pre-commit hooks exist for a reason.
- **Never commit to a branch in `claude-code-dev-hermit.protected_branches`** (defaults to `main`/`master` if unset). Always work on a feature branch.
- **Never force-push from agent context.** No bare `--force` or `-f`. `--force-with-lease` is allowed only to a non-protected branch with an explicit refspec (the safe rebase-recovery case); ambiguous-target leases and leases to protected branches are blocked. When in doubt, surface the divergence and let the operator resolve.

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

## Implementation Flow

If the project's own CLAUDE.md or skills define an implementation flow (e.g. its own commit/test/PR sequence), follow that. The steps below are the fallback for projects without one.

After making code changes:

1. Run the configured test command (`claude-code-dev-hermit.commands.test`, set via `/claude-code-dev-hermit:hatch`). If unset, ask the operator for the command and offer to save it via `hatch`.
2. If tests fail, fix the failures or surface them in the response — **do not declare the task done with broken tests**.
3. If the task is non-trivial and `/feature-dev:feature-dev` is installed, run it first when the code path is unfamiliar (framework lifecycle hooks, ORM internals, build-tool plugins, auth middleware). The trigger is **unfamiliarity, not urgency**. Skip for: doc/prompt/config edits, single-line fixes, code paths you've already read end-to-end.
4. Before declaring the task done: run `/claude-code-dev-hermit:dev-quality`. It runs `/code-review` on the diff and re-runs `commands.test` if configured. If tests regress, investigate before committing. If `/code-review:code-review` is installed (`code-review@claude-plugins-official`), the skill will tell you to suggest it to the operator — do not invoke that skill autonomously. **Nested git repo?** If your work is happening inside a nested git repo (true submodule, Composer path package, npm/pnpm path workspace, vendored dep edited in place), pass `--cwd <relative/path>` so `/dev-quality` scopes git ops, `/code-review`, and the test re-run to that repo. State still lives under the parent's `.claude-code-hermit/`, but the captured SHA is the child's HEAD.

## Tests Before PR

If the project defines its own pre-PR validation (e.g. a custom test runner, CI gate, or PR-creation skill that handles testing internally), follow that. The steps below are the fallback.

1. Run `/claude-code-dev-hermit:dev-quality` — handles `/code-review` + test re-run (see §Implementation Flow step 4). For nested-repo workflows, pass `--cwd <path>`.
2. Commit.
3. If you committed after `/dev-quality` ran and `commands.test` is configured, re-run it once — `/dev-pr` Gate 0 checks `last-test.json` against the current HEAD sha.
4. Run `/claude-code-dev-hermit:dev-pr`. Gate 0 reads `last-test.json` and refuses if missing, on a stale sha, or with a non-pass status. Pass `--cwd <path>` if you used it for `/dev-quality` — the PR opens against the child repo's remote.

## Technical Constraints

Subagents cannot invoke skills (`/code-review`, `/batch`, etc.) — those must run in the main session only.

Session state (`in_progress`/`waiting`/`idle`/`dead_process`) lives in `.claude-code-hermit/state/runtime.json` (`.session_state`). SHELL.md `Status:` is cosmetic — never parse it for programmatic checks.

Core rules (artifact frontmatter, tag discipline, proposals) apply to all dev work — see the `## Session Discipline (claude-code-hermit)` block above.

## Before Archiving a Task

- `/claude-code-dev-hermit:dev-pr` run, or PR opened via other means — URL recorded in `state/bindings.json`.
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

All dev proposals must pass the three-condition gate: (1) repeated pattern across sessions, (2) meaningful consequence if unaddressed, (3) operator-actionable change.

Tier mapping:
- **Tier 2** (micro-approval): `[tech-debt]`, `[tooling]`, `[dependency]` updates
- **Tier 3** (full PROP-NNN): `[missing-tests]`, `[architecture]`, `[dependency]` removals

## Dev Quick Reference

- One-time setup / re-config: `/claude-code-dev-hermit:hatch`
- Mid-task test run + cache warm: `/claude-code-dev-hermit:dev-test` (supports `--cwd <path>`)
- Pre-wrap quality gate: `/claude-code-dev-hermit:dev-quality` (supports `--cwd <path>`)
- Open the PR: `/claude-code-dev-hermit:dev-pr` (supports `--cwd <path>`)
- Cleanup: `/code-review` (built-in)
- Parallel changes across many files: `/batch` (built-in)
- Diagnostics: `/debug` (built-in)
- High-stakes review: `/code-review:code-review` (from `code-review@claude-plugins-official`, recommended companion)