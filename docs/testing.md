# Testing

## Running Tests

```bash
bash tests/run-hooks.sh
```

This runs each hook with fixture input and asserts exit 0.

---

## Test Structure

Tests live in `tests/`:

- `run-hooks.sh` — main test runner, executes all hook tests
- `fixtures/` — input files for hook tests

### Fixture Files

| File                   | Used by                                     | Format                                                                            |
| ---------------------- | ------------------------------------------- | --------------------------------------------------------------------------------- |
| `stop-hook-input.json` | cost-tracker, suggest-compact, session-diff | JSON with `session_id`, `model`, `input_tokens`, `output_tokens`, `context_usage` |
| `shell-session.md`     | evaluate-session                            | SHELL.md format (copy of a live session)                                          |

---

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

For hooks that read `.claude-code-hermit/sessions/SHELL.md`, ensure the file exists — see `tests/fixtures/shell-session.md`.

---

## Writing New Tests

When adding or modifying a hook:

1. **Happy-path test** — add a fixture input and assert exit 0 in `run-hooks.sh`
2. **Empty-stdin test** — verify `echo '' | node scripts/your-hook.js` exits 0 without crashing
3. **Output validation** — if the hook writes files, assert they exist and contain valid data

### Hook Contract

All hooks follow this contract:

| Property           | Rule                                                                                                                 |
| ------------------ | -------------------------------------------------------------------------------------------------------------------- |
| **Stdin**          | Stop hooks receive JSON. SessionStart hooks receive no stdin.                                                        |
| **Exit code**      | Always 0 on error. Non-zero only for genuine assertion failures.                                                     |
| **Profile gating** | Use `run-with-profile.js` or check `AGENT_HOOK_PROFILE` internally. Valid profiles: `minimal`, `standard`, `strict`. |
| **File paths**     | Resolved relative to cwd (the target project root).                                                                  |

### No Test Framework

Tests are shell scripts. No Jest, Vitest, or anything else. This is a design constraint — see [Contributing](../CONTRIBUTING.md).

---

## Contract Tests (run-contracts.py)

```bash
python3 tests/run-contracts.py
```

Added in v0.3.5. Runs 20+ Python-based contract tests that verify:

- Plugin manifest integrity (`plugin.json` fields, skill/hook references)
- Hook script exit codes and stdin contracts
- State file ownership constraints
- Profile-gating correctness

These are stricter than `run-hooks.sh` — they test the plugin's behavioral contracts, not just exit codes.

### Fixture: cron-test-corpus.json

`tests/cron-test-corpus.json` is a shared fixture (added v0.3.10) used by contract tests that exercise the routine watcher's schedule-matching logic. It contains time/schedule pairs with expected fire/skip decisions. Add entries when fixing schedule edge cases.

---

## Frontmatter Validator (validate-frontmatter.js)

```bash
node tests/validate-frontmatter.js
```

Added in v0.3.9. Validates that all `.md` files in `skills/` and `agents/` have valid YAML frontmatter with required fields (`name`, `description`). Exits non-zero if any file fails. Run before releasing skills changes.
