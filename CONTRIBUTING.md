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
bash tests/run-hooks.sh
```

See [Testing](docs/testing.md) for hook test details, fixtures, manual testing, and how to write new tests.

## PR Workflow

1. Create a feature branch
2. Make changes
3. Run `bash tests/run-hooks.sh` locally
4. Push — CI runs the same tests
5. Keep commits focused — one concern per PR
