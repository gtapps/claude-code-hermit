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

- **Use `/commit` for every commit in this repo.** It detects which plugin's scope the diff belongs to, routes the CHANGELOG entry to that plugin's `CHANGELOG.md`, and path-scopes staging (never `git add -A`). The skill enforces "one plugin per commit" — cross-plugin changes are split into separate `/commit` runs. Run `/dev-quality` before `/commit` — it handles the cleanup pass.
- Root-scope edits (CI, root README, `.claude/`, `.claude-plugin/marketplace.json`) skip the CHANGELOG step entirely — they don't ship to operators. `/commit` handles that automatically.
- Releases still go through `/release <slug>`, which promotes a plugin's `[Unreleased]` section to a real version. `/commit` accumulates those entries during day-to-day work.
- **Where these skills live**: `/commit`, `/release`, `/release-status`, `/fleet-release`, `/test-run`, `/tackle-issue` are repo-internal skills under `.claude/skills/` — they're not shipped to operators, only used during monorepo dev. Use `/release-status` for a read-only pipeline snapshot before any release session; use `/fleet-release` when multiple plugins change together on one branch (handles dep ordering and `required_core_version` sync automatically).
- **Changelog style: terse like [Claude Code's CHANGELOG](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md).** Each `### Added / Changed / Fixed` bullet is 1–3 lines, `- **component: what changed** — short rationale if non-obvious.` Rationale, debugging context, and design tradeoffs go in the commit message and PR description, not the bullet. The verbose form is reserved for `### Upgrade Instructions`, which `hermit-evolve` reads imperative-step-by-step. The `/commit` and `/release` skills enforce this; the convention lives here for any agent that bypasses them.
- **`/release` is operator-initiated — don't auto-suggest it.** Don't propose `/release <slug>` or `/fleet-release` in plans, summaries, or "next steps." Wait for an explicit ship/release/version request. `/dev-pr` is the normal end of feature/fix flow and is welcome to suggest. `/release-status` is read-only and fine to suggest when checking pipeline state.

## Branching

- **Default: PR `fix/<N>-<slug>` / `feat/<N>-<slug>` / `chore/<slug>` branches to `main`.** Same flow for contributors and maintainer. `<N>` is the GH issue number (omit if no issue), `<slug>` is a short kebab-case descriptor. Examples: `fix/44-self-update-race`, `feat/57-cortex-tagging`, `chore/upgrade-node-24`. Regular merge to `main`.
- **Why main is safe as staging.** Claude Code's `/plugin update` only fires when `version` in `plugin.json` changes ([docs](https://code.claude.com/docs/en/plugins-reference#version-management)). Commits on `main` between releases are invisible to operators on the standard install path — `/release <slug>` is the actual ship event because it bumps `version` and promotes `[Unreleased]` → `[X.Y.Z]`. Caveats: brand-new installers and `--plugin-dir` testers get whatever is on `main` HEAD, so don't leave `main` knowingly broken for long.
- **Tags ship to operators on next `/plugin update`.** The `version` bump inside `/release` is the gate — pre-release commits on `main` don't reach `/plugin update` users until that bump happens.
- **Worktree discipline (`claude --worktree`).** When the session runs inside a git worktree, the repo root is the worktree (`git rev-parse --show-toplevel`), not the main checkout. Never `cd` into, edit, or `git -C` files under the main checkout or any sibling worktree — that's another session's territory. The only shared, intentionally main-rooted path is `.claude-code-hermit/` (gitignored hermit state). The `claude-code-dev-hermit` `worktree-boundary-guard` hook hard-blocks edits that escape the worktree.

## Layout gotchas

- **Sibling-scan pattern**: `${CLAUDE_PLUGIN_ROOT}/../*/.claude-plugin/plugin.json` resolves to `plugins/*/...` and finds all fleet plugins as guaranteed siblings.
- **Old standalone repos are redirect-only zombies**: `gtapps/claude-code-dev-hermit` and `gtapps/claude-code-homeassistant-hermit` exist but their `marketplace.json` redirects to this monorepo via `git-subdir`. **Do not push code there.** All work happens here.

## Environment quirks

- **Secrets:** env vars → `.env` (gitignored); secret files (`.pem` etc.) → `.claude.local/` (gitignored). Never `.claude/` — it's checked in.
- **Docker paths mirror the host** (`${PWD}:${PWD}` mount) — absolute paths are identical inside the container despite the container user being `claude`.
- **`rm -rf` is blocked** by the `enforce-deny-patterns` hook. Use `rm -r` (no `-f`) for scratch cleanup.
- **Subtree imports are unsquashed**: `git log --first-parent` for the monorepo-only view; full upstream commits live under each subtree merge.
- **CI is not path-filtered yet**: every plugin's tests run on every PR. Don't assume a HA-test failure on a core-only PR is your fault.
- **Shell `cd` persists across Bash calls.** Any `cd` in a Bash call leaves CWD pinned for subsequent Bash calls in the session — affects CWD-relative scripts like `heartbeat-precheck.js .claude-code-hermit` (silently `SKIP|HEARTBEAT.md missing`) and commands like `git add`. Plugin test runners (`bash plugins/<slug>/tests/run-all.sh`) end inside `plugins/<slug>/`. Use absolute paths or prefix `cd "$(git rev-parse --show-toplevel)" && …` (resolves to the current tree root — the worktree under `claude --worktree`, the main checkout otherwise — never a hardcoded path).

## Rules

- Always use Context7 for library/API documentation, code generation, and setup/configuration steps — don't wait for an explicit request.
- Don't overengineer.
- **This hermit is the plugin-dev special case.** When reasoning about utility of features in `plugins/claude-code-hermit/` (the shipped hermit), don't use this hermit's session history as evidence — the operator here maintains the plugin source. Target users are downstream operators who interact via Discord/Telegram and don't open `feat/PROP-NNN-*` branches.
