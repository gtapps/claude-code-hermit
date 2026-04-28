# claude-code-hermit (monorepo)

This repo is a multi-plugin Claude Code marketplace. Three plugins ship from `plugins/<slug>/`:
`claude-code-hermit` (core), `claude-code-dev-hermit`, `claude-code-homeassistant-hermit`.
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

- **Use `/commit` for every commit in this repo.** It detects which plugin's scope the diff belongs to, routes the CHANGELOG entry to that plugin's `CHANGELOG.md`, path-scopes staging (never `git add -A`), and runs `/simplify` on every diff (including markdown-only). The skill enforces "one plugin per commit" — cross-plugin changes are split into separate `/commit` runs.
- Root-scope edits (CI, root README, `.claude/`, `.claude-plugin/marketplace.json`) skip the CHANGELOG step entirely — they don't ship to operators. `/commit` handles that automatically.
- Releases still go through `/release <slug>`, which promotes a plugin's `[Unreleased]` section to a real version. `/commit` accumulates those entries during day-to-day work.
- **Where these skills live**: `/commit`, `/release`, `/create-pr`, `/release-status`, `/fleet-release`, `/test-run` are repo-internal skills under `.claude/skills/` — they're not shipped to operators, only used during monorepo dev. Use `/release-status` for a read-only pipeline snapshot before any release session; use `/fleet-release` when multiple plugins change together on one branch (handles dep ordering and `required_core_version` sync automatically).

## Branching

- **Default for version work: use a plugin-scoped branch** named `<short-slug>/vX.Y.Z` (e.g. `dev-hermit/v0.3.0`, `hermit/v1.0.22`, `ha-hermit/v0.0.7`). Accumulate commits there until the version is complete, then PR + regular merge (no squash) to `main`, then `/release <slug>`. This groups related commits, gives CI and `/ultrareview` a natural review point, and avoids shipping to operators mid-iteration.
- **Direct to `main`** for atomic, self-contained changes where a PR adds no value: hotfixes, single-line doc edits, dep bumps, and changes where the diff is its own review. Use judgment — if you'd want to see it in a PR before it reaches operators, branch.
- **Branch naming**: `<short-slug>/vX.Y.Z` where short-slug drops the `claude-code-` prefix (`dev-hermit`, `hermit`, `ha-hermit`). The `v` prefix is required — matches tag convention and disambiguates from feature names.
- **Never squash-merge** a plugin branch. Squash changes the SHA and strands the tag on an orphan commit. Regular merge commit, then `/release` tags HEAD of `main`.
- **Tags ship immediately to operators** — no staging. The branch is your safety gate.

## Layout gotchas

- **Sibling-scan pattern**: `${CLAUDE_PLUGIN_ROOT}/../*/.claude-plugin/plugin.json` resolves to `plugins/*/...` and finds all fleet plugins as guaranteed siblings.
- **Old standalone repos are redirect-only zombies**: `gtapps/claude-code-dev-hermit` and `gtapps/claude-code-homeassistant-hermit` exist but their `marketplace.json` redirects to this monorepo via `git-subdir`. **Do not push code there.** All work happens here.

## Environment quirks

- **`rm -rf` is blocked** by the `enforce-deny-patterns` hook. Use `rm -r` (no `-f`) for scratch cleanup.
- **Subtree imports are unsquashed**: `git log --first-parent` for the monorepo-only view; full upstream commits live under each subtree merge.
- **CI is not path-filtered yet**: every plugin's tests run on every PR. Don't assume a HA-test failure on a core-only PR is your fault.