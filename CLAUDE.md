# claude-code-hermit (monorepo)

This repo is a multi-plugin Claude Code marketplace. Six plugins ship from `plugins/<slug>/`:
`claude-code-hermit` (core), `claude-code-dev-hermit`, `claude-code-homeassistant-hermit`, `claude-code-fitness-hermit`, `hermit-scribe`, `laravel-forge-hermit`.
Each plugin has its own `CLAUDE.md`, `CHANGELOG.md`, and `tests/` — read those for plugin-specific context.

The top-level `.claude-plugin/marketplace.json` is the only marketplace. The README at the repo root is the canonical hermit pitch.

Always launch Claude Code from this repo's root, not from inside a plugin dir. Auto-memory is keyed by CWD, and plugin dirs contain their own `.claude-plugin/` (launching there can load the plugin under test as the project plugin). Per-plugin `CLAUDE.md` files load on demand when you touch their files.

## Conventions

- **Per-plugin paths**: every plugin lives at `plugins/<slug>/`. Tests, scripts, skills, agents, hooks, state-templates, docs, CHANGELOG, CLAUDE.md all live inside that dir.
- **Tests run from inside the plugin dir**: core and HA are pure `bun test` (auto-discovers `tests/*.test.ts`; HA keeps Python only as a test fixture, nothing shipped runs it); dev/fitness/scribe/forge use `bash tests/run-all.sh` (forge also needs a composer/PHP step). Helpers use CWD-relative paths and break if invoked from repo root.
- **Tag format**: `<slug>--v<X.Y.Z>` (double-dash, e.g. `claude-code-hermit--v1.0.20`).
- **Independent versioning**: each plugin's `plugin.json` bumps on its own cadence. Domain plugins declare core compat via `required_core_version: ">=X.Y.Z"` (semver range, not pin).
- **Dependency fields**: `required_core_version` and `requires` live in `.claude-plugin/hermit-meta.json` (hermit-internal, validator-invisible). `dependencies` is the native Claude Code resolver field in `plugin.json`. `required_core_version` is authoritative — read by `plugins/claude-code-hermit/scripts/doctor-check.ts` from `hermit-meta.json`. `requires` mirrors it for documentation. Update all three when the core version requirement changes. All hermit-internal manifest extensions (`hermit.*`, etc.) belong in hermit-meta.json. When a domain hatch depends on new core terminus behavior (e.g. the domain hatch continuation protocol), bump `required_core_version` to the new core version and follow the protocol doc in `plugins/claude-code-hermit/skills/hatch/SKILL.md`.
- **Marketplace.json bumps**: only the matching plugin's entry. The release skill takes a slug arg: `/release <plugin-slug>`.

## Commits

- Root-scope edits (CI, root README, `.claude/`, `.claude-plugin/marketplace.json`) skip the CHANGELOG step entirely — they don't ship to operators. `/commit` handles that automatically.
- Releases still go through `/release <slug>`, which promotes a plugin's `[Unreleased]` section to a real version. `/commit` accumulates those entries during day-to-day work.
- **Where these skills live**: `/commit`, `/release`, `/release-status`, `/fleet-release`, `/bump-core-req`, `/test-run`, `/tackle-issue` are repo-internal skills under `.claude/skills/` — they're not shipped to operators, only used during monorepo dev. Use `/release-status` for a read-only pipeline snapshot before any release session; use `/fleet-release` when multiple plugins change together on one branch (handles dep ordering and `required_core_version` sync automatically).
- **Changelog style: terse like [Claude Code's CHANGELOG](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md).** Each `### Added / Changed / Fixed` bullet is 1–3 lines, `- **component: what changed** — short rationale if non-obvious.` Rationale, debugging context, and design tradeoffs go in the commit message and PR description, not the bullet. The verbose form is reserved for `### Upgrade Instructions`, which `hermit-evolve` reads imperative-step-by-step. The `/commit` and `/release` skills enforce this; the convention lives here for any agent that bypasses them.
- **`/release` is operator-initiated — don't auto-suggest it.** Don't propose `/release <slug>` or `/fleet-release` in plans, summaries, or "next steps." Wait for an explicit ship/release/version request. `/release-status` is read-only and fine to suggest when checking pipeline state.
- **Proposals are local-only — never reference them externally.** Proposals (`PROP-NNN`, the local proposal queue) live in this project's hermit state and are internal dev bookkeeping. Never mention a proposal ID or the fact that work came from a proposal in a CHANGELOG entry, commit message, PR title/description, or branch name. Describe the change on its own terms. Branch names use `feat/<N>-<slug>`/`fix/<N>-<slug>` off the GH issue number, not a proposal ID.

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
- **`rm -rf` is blocked** by the `enforce-deny-patterns` hook — now also inside `&&`/`;`/`|` chains, but only the literal `rm -rf` spelling (`rm -fr`, `rm -r -f` are not matched). Use `rm -r` (no `-f`) for scratch cleanup.
- **Subtree imports are unsquashed**: `git log --first-parent` for the monorepo-only view; full upstream commits live under each subtree merge.
- **CI is path-filtered per plugin**: every plugin has a paths-filtered workflow under `.github/workflows/` (`test-hooks` core, `test-ha`, `test-dev`, `test-fitness`, `test-scribe`, `test-forge`), so a PR touching one plugin runs only that plugin's suite. Root-file changes (`package.json`, `bun.lock`, `tsconfig.json`) trigger all of them.
- **Shell `cd` persists across Bash calls.** Any `cd` in a Bash call leaves CWD pinned for subsequent Bash calls in the session — affects CWD-relative scripts like `heartbeat-precheck.ts .claude-code-hermit` (silently `SKIP|HEARTBEAT.md missing`) and commands like `git add`. Plugin test runners (`bun test` or `bash plugins/<slug>/tests/run-all.sh` run from inside the plugin dir) end inside `plugins/<slug>/`. Use absolute paths or prefix `cd "$(git rev-parse --show-toplevel)" && …` (resolves to the current tree root — the worktree under `claude --worktree`, the main checkout otherwise — never a hardcoded path).

## Verification

- **Confirm Claude Code's own behavior empirically before building on it.** When a feature or bug depends on how Claude Code itself behaves (what a tool actually returns, the exact shape a hook receives on stdin, how the harness namespaces or loads things, what a setting or slash command really does, how a native feature fires), don't conclude from docs, memory, or assumption. Spin up a tmux session running real Claude Code, exercise the actual tool, feature, or behavior, and read what it does. The empirical verdict from that run is what you build on; if it contradicts the docs or your expectation, the live behavior wins and that gap is the finding.
- **Use tmux so the probe runs non-blocking alongside this session.** Launch `claude` in a tmux pane (`tmux new-session -d`, `send-keys` to drive it, `capture-pane` to read output), observe the real result, then act on it. Always follow the verdict the live run produces, never the assumed behavior. **Launch the probe with `--model haiku`** to keep probe cost down — the goal is to observe harness behavior, which does not depend on the model tier. Note: under `--plugin-dir`, skills load at session start, so edits to a skill mid-probe are not picked up — relaunch to test changed skill text, and `${CLAUDE_PLUGIN_ROOT}` is not substituted in `--plugin-dir` mode (derive the plugin root from the skill's Base directory instead).

## Rules

- Always use Context7 for library/API documentation, code generation, and setup/configuration steps — don't wait for an explicit request.
- Don't overengineer.
- **This hermit is the plugin-dev special case.** When reasoning about utility of features in `plugins/claude-code-hermit/` (the shipped hermit), don't use this hermit's session history as evidence — the operator here maintains the plugin source. Target users are downstream operators who interact via Discord/Telegram and don't open `feat/PROP-NNN-*` branches.
