# Contributing to claude-code-hermit

## Design Constraints

These are non-negotiable. Read them before making any changes.

- **No dependencies.** No `package.json`, no `node_modules`. Hook scripts use Node.js stdlib only.
- **No build step.** Skills are plain markdown. Hooks are standalone `.js` / `.sh` scripts.
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

## Testing

```bash
( cd plugins/claude-code-hermit && bash tests/run-all.sh )
```

For HA-hermit changes:

```bash
( cd plugins/claude-code-homeassistant-hermit && pytest tests/ -v )
```

See [Testing](docs/testing.md) for hook test details, fixtures, manual testing, and how to write new tests.

## PR Workflow

1. Create a feature branch
2. Make changes
3. Run `( cd plugins/claude-code-hermit && bash tests/run-all.sh )` locally (and the HA pytest suite if HA code changed)
4. Push — CI runs the same tests
5. Keep commits focused — one concern per PR

## Adding a New Hermit

This repo is a multi-plugin marketplace. The catalog lives at the repo root in `.claude-plugin/marketplace.json`; each entry's `source` field tells Claude Code where to find the plugin. Three patterns are supported:

1. **In-repo, first-party** — `"source": "./plugins/<name>"`. Plugin code lives under `plugins/<name>/`. Use when you have direct push access and want coordinated releases with the rest of the fleet (the existing core, dev-, and HA-hermits all use this).
2. **In-repo, vendored** — `"source": "./external_plugins/<name>"`. Contributor's code, kept in-repo as a synced copy for distribution stability. Use when someone else owns the upstream but you want a known-good version pinned in this marketplace.
3. **Remote git ref** — `{"source": {"source": "github", "repo": "<owner>/<repo>"}, ...}`. Contributor owns their own repo and ships on their own cadence; this monorepo merely catalogs the entry. Use when the plugin author wants to keep ownership and release independently.

To add a first-party (pattern 1) hermit:

1. Create `plugins/<your-hermit>/` with `.claude-plugin/plugin.json` (set `name`, `version`, `description`, `author`, `required_core_version`).
2. Add the matching entry to the root `.claude-plugin/marketplace.json` `plugins[]` array — keep `name`, `version`, and the URL fields in sync.
3. Add `tests/run-all.sh` if you have tests (see the per-plugin runner pattern below).
4. Cut releases via `/release <your-hermit>` — the skill bumps versions in both manifest and marketplace, tags as `<your-hermit>-vX.Y.Z`, and pushes.

## The `required_core_version` Convention

Every plugin in this fleet that depends on the core hermit declares a semver-range string in its `plugin.json`:

```json
"required_core_version": ">=1.0.20",
"requires": { "claude-code-hermit": ">=1.0.20" }
```

`required_core_version` is the canonical fleet contract. It is read by the core plugin's `hermit-doctor` (the `dependencies` check), `smoke-test`, and `hermit-evolve`, and by external/third-party hermits that live outside this monorepo. The parallel `requires.claude-code-hermit` field mirrors it — the two must agree, and `tests/run-hooks.sh` enforces this on every CI run (test `sibling manifests: required_core_version vs requires consistency`). When you bump one, bump both.

## Per-Plugin Test Runner Pattern

Each plugin owns its own `tests/run-all.sh` that orchestrates the suites it cares about. Examples:

- `plugins/claude-code-hermit/tests/run-all.sh` — bash + Python; calls `run-hooks.sh`, `run-contracts.py`, `run-scripts.sh`, `recurrence-gate-matrix.sh`. See [`docs/testing.md`](plugins/claude-code-hermit/docs/testing.md) for hook-test details, fixtures, and how to write new tests.
- `plugins/claude-code-homeassistant-hermit/tests/` — pytest suite; run via `.venv/bin/pytest tests/ -v`.

CI runs each plugin's suite from its own directory (paths-filtered so unrelated plugin edits don't trigger every workflow). New plugins should follow the same pattern: a `run-all.sh` (or equivalent entry point) that returns non-zero on any failure, plus a paths-filtered GitHub Actions workflow under `.github/workflows/`.
