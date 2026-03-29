# Contributing to claude-code-hermit

## Design Constraints

These are non-negotiable. Read them before making any changes.

- **No dependencies.** No `package.json`, no `node_modules`. Hook scripts use Node.js stdlib only.
- **No build step.** Skills are plain markdown. Hooks are standalone `.js` / `.sh` scripts.
- **Hooks fail open.** A hook must never block Claude Code. Catch errors, `process.exit(0)`. Never exit non-zero on transient failures.
- **Consume stdin.** Every hook must read stdin to completion even if unused, to avoid broken pipe errors from Claude Code.
- **No test framework.** Tests are a shell script. Don't add Jest, Vitest, or anything else.

## Local Development

Test the plugin against a target project using `--plugin-dir`:

```bash
cd /path/to/your-project
claude --plugin-dir /path/to/claude-code-hermit
```

Then run `/claude-code-hermit:init` to create the state directory. Edits to skills, hooks, and scripts take effect immediately — no restart needed.

## Running Hooks Manually

Each hook can be tested in isolation. Stop hooks expect JSON on stdin:

```bash
# cost-tracker (Stop hook — always runs)
cat tests/fixtures/stop-hook-input.json | node scripts/cost-tracker.js

# suggest-compact (Stop hook — always runs)
cat tests/fixtures/stop-hook-input.json | node scripts/suggest-compact.js

# session-diff (Stop hook — standard/strict profile)
cat tests/fixtures/stop-hook-input.json | \
  AGENT_HOOK_PROFILE=standard CLAUDE_PLUGIN_ROOT=. \
  node scripts/run-with-profile.js standard,strict scripts/session-diff.js

# evaluate-session (Stop hook — standard/strict profile)
echo '{}' | AGENT_HOOK_PROFILE=standard node scripts/evaluate-session.js

# check-upgrade (SessionStart hook)
bash scripts/check-upgrade.sh .
```

For hooks that read `.claude-code-hermit/sessions/SHELL.md`, make sure the file exists — see `tests/fixtures/shell-session.md` for the expected format.

## Hook Contract

All hooks registered in `hooks/hooks.json` follow this contract:

| Property | Rule |
|----------|------|
| **Stdin** | Stop hooks receive JSON with `session_id`, `model`, `input_tokens`, `output_tokens`, `context_usage`. SessionStart hooks receive no stdin. |
| **Exit code** | Always 0 on error. Non-zero only for genuine assertion failures (e.g., path traversal in `run-with-profile.js`). |
| **Profile gating** | Use `run-with-profile.js` wrapper or check `AGENT_HOOK_PROFILE` env var internally. Valid profiles: `minimal`, `standard`, `strict`. |
| **File paths** | Resolved relative to cwd (the target project root). |

See `docs/ARCHITECTURE.md` for the full hook table and profile matrix.

## Running Tests

```bash
bash tests/run-hooks.sh
```

This runs each hook with fixture input and asserts exit 0. The test fixtures in `tests/fixtures/` also serve as documentation of the hook input format.

## PR Workflow

1. Create a feature branch
2. Make changes
3. Run `bash tests/run-hooks.sh` locally
4. Push — CI runs the same tests
5. Keep commits focused — one concern per PR

## What to Test

When adding or modifying a hook:
- Add a happy-path test (fixture input, exit 0)
- Add an empty-stdin test (exit 0, no crash)
- If the hook writes output files, assert they exist and contain valid data
