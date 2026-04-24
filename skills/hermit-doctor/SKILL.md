---
name: hermit-doctor
description: Returns a six-check health report on the hermit installation — config validity, hook registration, state file integrity, cost budget, proposal health, file permissions. Use when diagnosing an install, before a release, or after suspicious behavior. Activates on messages like "/hermit-doctor", "health check", "diagnose the hermit", "what's wrong", "run diagnostic".
---

# Hermit Doctor

Runs six read-only health checks against the current hermit install and surfaces the
summary. Safe to run at any time. Produces no side effects beyond writing
`.claude-code-hermit/state/doctor-report.json` and appending a summary block to SHELL.md.

## Steps

1. Run the check script:
   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/scripts/doctor-check.js .claude-code-hermit
   ```
   The script writes `.claude-code-hermit/state/doctor-report.json` and prints the same
   JSON to stdout. It exits 0 unconditionally — on any internal failure the failing
   check reports `status: "fail"` in its own entry rather than crashing the report.

2. Parse the JSON. For each of the six checks (`config`, `hooks`, `state`, `cost`,
   `proposals`, `permissions`), emit one line using this format:
   - `✓ <id> — <detail>` when `status: ok`
   - `⚠ <id> — <detail>` when `status: warn`
   - `✗ <id> — <detail>` when `status: fail`

3. Append a summary section to `.claude-code-hermit/sessions/SHELL.md` under a new
   `## Doctor Report (<ts>)` heading. Use the same six lines from step 2. Place it
   above the `## Monitoring` section so it sits with session-level context, not
   with monitoring chatter.

4. Return the six lines to the caller. Cap total output at 15 lines.

## Silence policy

- If every check is `ok`, return only: `All six checks passed.` Do not notify via
  channel (Tier 0). Still append to SHELL.md so the run is traceable.
- If any check is `warn` or `fail`, return the full six-line summary. Channel
  notification follows the usual § Operator Notification policy in CLAUDE.md —
  `fail` warrants a proactive ping; `warn` alone does not unless the operator asked.

## What each check looks at

| id | What it verifies | Status rules |
|---|---|---|
| `config` | Runs `validate-config.js` against `.claude-code-hermit/config.json`. | `fail` on any error; `warn` on any warning. |
| `hooks` | Parses `hooks/hooks.json`; verifies each referenced script file exists on disk. | `fail` if any script is missing. |
| `state` | `JSON.parse` every `.claude-code-hermit/state/*.json`; warns if expected files missing. | `fail` on unparseable file; `warn` if any expected file (`alert-state.json`, `reflection-state.json`, `runtime.json`, `monitors.runtime.json`) is absent. |
| `cost` | Sums today's `estimated_cost_usd` from `.claude/cost-log.jsonl` against `config.idle_budget`. | `fail` ≥ 100%; `warn` ≥ 80%; `ok` below. |
| `proposals` | Counts `proposals/PROP-*.md` with `status: open`; ages via `created:` frontmatter. | `warn` if any open PROP > 30 days, or if more than 10 open. |
| `permissions` | `fs.statSync(p).mode & 0o777` on `config.json`, `state/*.json`, and `proposals/`. | `warn` if any world-readable (`mode & 0o004 ≠ 0`). |

No automatic fixes. Doctor reports; the operator acts.

## Notes

- The check logic lives in `scripts/doctor-check.js` so it can be unit-tested without
  invoking the model.
- Re-runs are cheap. No locking needed.
- Doctor does not ping external APIs (Discord, Telegram, Anthropic). Everything is
  local filesystem reads.
