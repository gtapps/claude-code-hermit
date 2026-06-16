# Contributing to claude-code-hermit

## Design Constraints

These are non-negotiable. Read them before making any changes.

- **No dependencies.** No `package.json`, no `node_modules`. Hook scripts use Bun stdlib only.
- **No build step.** Skills are plain markdown. Hooks are standalone `.ts` / `.sh` scripts.
- **Hooks fail open.** A hook must never block Claude Code. Catch errors, `process.exit(0)`. Never exit non-zero on transient failures.
- **Consume stdin.** Every hook must read stdin to completion even if unused, to avoid broken pipe errors from Claude Code.
- **No test framework.** Tests are a shell script. Don't add Jest, Vitest, or anything else.

## Repo Layout Note

The `.claude/` directory contains repo-local development agents and skills (release automation, validation, test runners). These are maintainer tooling for this repo — separate from the plugin's deliverable `agents/` and `skills/` directories that get installed into user projects.

## Local Development

Test the plugin against a target project using `--plugin-dir`:

```bash
cd /path/to/your-project
claude --plugin-dir /path/to/claude-code-hermit
```

Then run `/claude-code-hermit:hatch` to create the state directory. Edits to skills, hooks, and scripts take effect immediately — no restart needed.

### Testing a branch via marketplace install

`--plugin-dir` bypasses the marketplace resolver entirely. If you need to verify that a plugin surfaces correctly through the normal install path (e.g. when onboarding a new plugin that doesn't exist on `main` yet), point a project-scoped marketplace at your local checkout instead:

```bash
# In the target project — your monorepo checkout must be on the branch under test
claude plugin marketplace add /path/to/claude-code-hermit --scope project
claude plugin install claude-code-fitness-hermit@claude-code-hermit --scope project
```

The `@claude-code-hermit` suffix disambiguates when both a user-scoped and a project-scoped marketplace share the same name. Remove the project marketplace when done (`claude plugin marketplace remove claude-code-hermit --scope project`).

## Testing

```bash
( cd plugins/claude-code-hermit && bun test )
```

For HA-hermit changes:

```bash
( cd plugins/claude-code-homeassistant-hermit && pytest tests/ -v )
```

See [Testing](docs/testing.md) for hook test details, fixtures, manual testing, and how to write new tests.

## PR Workflow

### Branching

- **Default: PR feature branches to `main`.** Use Conventional-Commits prefixes — `fix/<N>-<slug>`, `feat/<N>-<slug>`, or `chore/<slug>` (`<N>` is the GH issue number, omit if no issue; `<slug>` is a short kebab-case descriptor). Examples: `fix/44-self-update-race`, `feat/57-cortex-tagging`, `chore/upgrade-node-24`. Regular merge to `main`.
- **`main` is safe as staging.** Claude Code's `/plugin update` only fires when `version` in `plugin.json` changes ([docs](https://code.claude.com/docs/en/plugins-reference#version-management)) — and `version` only bumps when a maintainer runs `/release <slug>`. Commits merged to `main` between releases are not pushed to operators on the standard install path. Each plugin's `CHANGELOG.md` accumulates entries under `## [Unreleased]` until release time.
- **Exception — plugin-scoped batching branch.** For explicit multi-commit features where `main` HEAD shouldn't sit half-built, branch as `<short-slug>/vX.Y.Z` (e.g. `hermit/v1.0.36`). Most contributions don't need this — when in doubt, target `main`.

### Steps

1. Create a feature branch off `main` (`fix/<N>-<slug>`, `feat/<N>-<slug>`, or `chore/<slug>`)
2. Run `/release-status` for a read-only pipeline snapshot (flags stale `required_core_version`, shows what's awaiting tag)
3. Make changes
4. Run `( cd plugins/claude-code-hermit && bun test )` locally (and the HA pytest suite if HA code changed)
5. Add a bullet to the affected plugin's `CHANGELOG.md` under `## [Unreleased]` — the maintainer promotes it to a real version at release time. (If you're using Claude Code with the repo's local skills, `/commit` does this automatically.)
6. Push — CI runs the same tests
7. Keep commits focused — one concern per PR

## Adding a New Hermit

This repo is a multi-plugin marketplace. The catalog lives at the repo root in `.claude-plugin/marketplace.json`; each entry's `source` field tells Claude Code where to find the plugin. Three patterns are supported:

1. **In-repo, first-party** — `"source": "./plugins/<name>"`. Plugin code lives under `plugins/<name>/`. Use when you have direct push access and want coordinated releases with the rest of the fleet (the existing core, dev-, and HA-hermits all use this).
2. **In-repo, vendored** — `"source": "./external_plugins/<name>"`. Contributor's code, kept in-repo as a synced copy for distribution stability. Use when someone else owns the upstream but you want a known-good version pinned in this marketplace.
3. **Remote git ref** — `{"source": {"source": "github", "repo": "<owner>/<repo>"}, ...}`. Contributor owns their own repo and ships on their own cadence; this monorepo merely catalogs the entry. Use when the plugin author wants to keep ownership and release independently.

To add a first-party (pattern 1) hermit:

1. Create `plugins/<your-hermit>/` with `.claude-plugin/plugin.json` (set `name`, `version`, `description`, `author`) and `.claude-plugin/hermit-meta.json` (set `required_core_version`, `requires`).
2. Add the matching entry to the root `.claude-plugin/marketplace.json` `plugins[]` array — keep `name`, `version`, and the URL fields in sync.
3. Add tests under `tests/` (bun test `*.test.ts` files, or a `tests/run-all.sh` runner — see the per-plugin pattern below).
4. Cut releases via `/release <your-hermit>` — the skill bumps versions in both manifest and marketplace, tags as `<your-hermit>-vX.Y.Z`, and pushes.

## The `required_core_version` Convention

Every plugin in this fleet that depends on the core hermit declares three version fields that must stay in sync:

**`.claude-plugin/hermit-meta.json`** (hermit-internal; not validated by `claude plugin tag`):
```json
"required_core_version": ">=1.0.21",
"requires": { "claude-code-hermit": ">=1.0.21" }
```

**`.claude-plugin/plugin.json`** (native Claude Code resolver field):
```json
"dependencies": [{ "name": "claude-code-hermit", "version": "^1.0.21" }]
```

`required_core_version` is the canonical fleet contract. It is read by the core plugin's `hermit-doctor` (the `dependencies` check), `smoke-test`, and `hermit-evolve`, and by external/third-party hermits that live outside this monorepo. The parallel `requires.claude-code-hermit` field mirrors it — the two must agree, and `tests/hooks.contract.test.ts` enforces this on every CI run (test `sibling manifests: required_core_version vs requires consistency`). When you bump one, bump all three.

When releasing core and a domain plugin together, use `/fleet-release` — it updates all three fields automatically after the core prep commit, before the domain plugin's release runs.

## Per-Plugin Test Runner Pattern

Each plugin owns its own test entry point. Examples:

- `plugins/claude-code-hermit/` — pure `bun test` from the plugin dir (auto-discovers `tests/*.test.ts`; no runner script). See [`docs/testing.md`](plugins/claude-code-hermit/docs/testing.md) for fixtures and how to write new tests.
- `plugins/claude-code-homeassistant-hermit/tests/` — pytest suite; run via `.venv/bin/pytest tests/ -v`.

CI runs each plugin's suite from its own directory (paths-filtered so unrelated plugin edits don't trigger every workflow). New plugins should follow the same pattern: a `run-all.sh` (or equivalent entry point) that returns non-zero on any failure, plus a paths-filtered GitHub Actions workflow under `.github/workflows/`.
