# Testing

## Running Tests

```bash
bash tests/run-all.sh
```

This runs all test suites — hook tests, contract tests, and frontmatter validation.

---

## Test Structure

Tests live in `tests/`:

- `run-all.sh` — main test runner, executes all test suites
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
cat tests/fixtures/stop-hook-input.json | bun scripts/cost-tracker.ts

# suggest-compact (Stop hook — always runs)
cat tests/fixtures/stop-hook-input.json | bun scripts/suggest-compact.ts

# session-diff (Stop hook — standard/strict profile)
cat tests/fixtures/stop-hook-input.json | \
  AGENT_HOOK_PROFILE=standard CLAUDE_PLUGIN_ROOT=. \
  bun scripts/run-with-profile.ts standard,strict scripts/session-diff.ts

# evaluate-session (Stop hook — standard/strict profile)
echo '{}' | AGENT_HOOK_PROFILE=standard bun scripts/evaluate-session.ts

# check-upgrade (SessionStart hook)
bash scripts/check-upgrade.sh .
```

For hooks that read `.claude-code-hermit/sessions/SHELL.md`, ensure the file exists — see `tests/fixtures/shell-session.md`.

---

## Writing New Tests

When adding or modifying a hook:

1. **Happy-path test** — add a fixture input and assert exit 0 in `hooks.contract.test.ts`
2. **Empty-stdin test** — verify `echo '' | bun scripts/your-hook.ts` exits 0 without crashing
3. **Output validation** — if the hook writes files, assert they exist and contain valid data

### Hook Contract

All hooks follow this contract:

| Property           | Rule                                                                                                                 |
| ------------------ | -------------------------------------------------------------------------------------------------------------------- |
| **Stdin**          | Stop hooks receive JSON. SessionStart hooks receive no stdin.                                                        |
| **Exit code**      | Always 0 on error. Non-zero only for genuine assertion failures.                                                     |
| **Profile gating** | Use `run-with-profile.ts` or check `AGENT_HOOK_PROFILE` internally. Valid profiles: `minimal`, `standard`, `strict`. |
| **File paths**     | Resolved relative to cwd (the target project root).                                                                  |

### Test Framework

Hook contract tests live in `tests/hooks.contract.test.ts` and run with `bun test` (no extra dependencies — `bun:test` is built in). The remaining suites are shell/Python scripts. No Jest, Vitest, or anything else — see [Contributing](../CONTRIBUTING.md).

---

## Contract Tests (run-contracts.py)

```bash
python3 tests/run-contracts.py
```

Runs 20+ Python-based contract tests that verify:

- Plugin manifest integrity (`plugin.json` fields, skill/hook references)
- Hook script exit codes and stdin contracts
- State file ownership constraints
- Profile-gating correctness

These are stricter than `hooks.contract.test.ts` — they test the plugin's behavioral contracts, not just exit codes.

### Fixture: cron-test-corpus.json

`tests/cron-test-corpus.json` is a shared fixture used by contract tests that validate cron expression parsing. It contains time/schedule pairs with expected fire/skip decisions. Add entries when fixing schedule edge cases.

