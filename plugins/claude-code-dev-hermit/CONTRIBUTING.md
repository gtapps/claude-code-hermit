# Contributing to claude-code-dev-hermit

Thanks for wanting to contribute! This plugin extends [claude-code-hermit](https://github.com/gtapps/claude-code-hermit) with dev workflow capabilities. Whether it's a bug fix, a new skill idea, or better docs — we appreciate it.

## Design Constraints

These are non-negotiable. Read them before making any changes.

- **No dependencies.** No `package.json`, no `node_modules`. Hook scripts use Node.js stdlib only.
- **No build step.** Skills are plain markdown. Hooks are standalone `.js` scripts.
- **Hooks fail open.** A hook must never block Claude Code. Catch errors, `process.exit(0)`. Never exit non-zero on transient failures.
- **Consume stdin.** Every hook must read stdin to completion even if unused, to avoid broken pipe errors from Claude Code.
- **No test framework.** Tests are plain Node.js scripts. Don't add Jest, Vitest, or anything else.
- **Don't reinvent.** Before building something, check if Claude Code already has it natively (built-in skills, Explore subagent, Task API, etc.). If it does, delegate — don't build.
- **Profile-gate hooks.** Safety hooks go at `strict` only. Quality hooks at `standard,strict`. Never block at `minimal`.
- **`scripts/lib/` must be pure.** Helpers in `scripts/lib/` must be importable with no side effects — no top-level `process.exit`, no Monitor entrypoint behavior, no I/O at load time. Process entrypoints (scripts spawned by the Monitor or hooks.json) belong in `scripts/`.

## Local Development

Test the plugin against a target project using `--plugin-dir`:

```bash
cd /path/to/your-project
claude --plugin-dir /path/to/claude-code-dev-hermit
```

Then run `/claude-code-dev-hermit:hatch` to activate. Edits to skills, hooks, and scripts take effect immediately — no restart needed.

### Prerequisites

- [Claude Code](https://code.claude.com) v2.1.110+
- [claude-code-hermit](https://github.com/gtapps/claude-code-hermit) v1.0.22+ (core must be installed in the target project)
- Node.js 24+

## Testing

```bash
bash tests/run-all.sh
```

The test suite covers all hooks and helpers; add tests for any new hook or lib logic.

## Project Structure

```
skills/hatch/        — one-time setup wizard
skills/dev-pr/       — push branch + open PR
hooks/hooks.json     — registers git-push-guard
scripts/             — git-push-guard.js (the only script)
tests/               — run-all.sh + skill-structure.test.js
state-templates/     — CLAUDE-APPEND.md (injected into target project's CLAUDE.md)
docs/                — user-facing documentation
.claude-plugin/      — plugin manifest + hermit-meta.json
```

The plugin shipped no agents and no `scripts/lib/` after v0.3.0 — see CHANGELOG `[0.3.0]` for what was removed.

## PR Workflow

1. Create a feature branch
2. Make changes
3. Run `bash tests/run-all.sh` locally
4. Keep commits focused — one concern per PR
5. Update docs if your change affects user-facing behavior

## What Makes a Good Contribution

- **New skills** that complement the dev workflow without duplicating Claude Code built-ins
- **Hook improvements** that make git safety smarter without being annoying
- **Bug fixes** with a test case that reproduces the issue
- **Doc improvements** — clearer explanations, missing examples, typo fixes
- **Ideas** — open an [issue](https://github.com/gtapps/claude-code-hermit/issues) to discuss before building something big

## What to Avoid

- Adding npm dependencies or build steps
- Skills that duplicate Claude Code native features (`/simplify`, `/batch`, `/debug`, Explore subagent)
- Hooks that activate below their intended profile level
- Large refactors without prior discussion
