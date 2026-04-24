---
name: dev-doctor
description: Check that this project is set up correctly for dev-hermit and safe for the implementer agent. Composes core validators for shared checks; adds dev-specific property verification. Run manually to diagnose setup issues; registered as a weekly scheduled_check (findings-only mode, no side effects).
---

# /dev-doctor

Verify the dev-hermit setup is implementer-safe. Produces a `PASS / WARN / FAIL` report for each property, plus a machine-readable final verdict line.

## Modes

This skill runs differently depending on how it is invoked:

- **Manual** (operator runs `/dev-doctor` directly): full check including `/claude-code-hermit:smoke-test` and the `hermit-config-validator` agent
- **Scheduled** (fired by `reflect-scheduled-checks` via `scheduled_checks` config entry): findings-only subset — skip smoke-test to avoid side effects (state-file repairs, channel test messages)

Detect scheduled mode by checking the invocation context: if invoked from `reflect-scheduled-checks` or if a `--scheduled` flag is passed, run scheduled mode. Otherwise run manual mode.

## Steps

### Manual mode

**Step 1 — Core validator composition**

Run in parallel:

1. Invoke `/claude-code-hermit:smoke-test` — captures plugin references, OPERATOR.md, CLAUDE.md markers, routines, scheduled_checks registration. Record its PASS/FAIL summary.
2. Invoke `hermit-config-validator` agent — validates config.json structure (required keys, routine times, channel structure, env naming). Record its verdict.

**Step 2 — Dev-specific checks** (same as scheduled mode, see below)

**Step 3 — Compile full report** combining smoke-test + validator + dev-specific results.

### Scheduled mode (findings-only)

Skip smoke-test and hermit-config-validator invocations. Run only the dev-specific checks below. Emit findings as `actionable` / `contextual` / `empty` in the format `reflect-scheduled-checks` expects.

## Dev-specific checks

For each property below, read the relevant file(s) and emit `PASS`, `WARN`, or `FAIL` with a one-sentence explanation. Use judgment for judgment calls (e.g., "test command looks safe") rather than pattern matching.

| # | Property | How to check |
|---|---|---|
| 1 | Core hermit version ≥ required | Compare `_hermit_versions["claude-code-hermit"]` in config.json with `required_core_version` in `${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json` |
| 2 | Dev workflow marker in CLAUDE.md | `grep "claude-code-dev-hermit: Development Workflow" CLAUDE.md` |
| 3 | always_on + strict profile | If `always_on: true` in config, `env.AGENT_HOOK_PROFILE` must be `strict`; FAIL if not |
| 4 | Protected branches configured | `dev.protected_branches` in config must be non-empty array |
| 5 | Test command configured | `dev.commands.test` must be non-null |
| 6 | Typecheck or lint configured | At least one of `dev.commands.typecheck` / `dev.commands.lint` non-null; WARN only if both absent |
| 7 | Worktree support | Run `git worktree list` — must exit 0 |
| 8 | Hook script valid | Run `node --check ${CLAUDE_PLUGIN_ROOT}/scripts/git-push-guard.js` — must exit 0 |
| 9 | .gitignore covers state and secrets | `.gitignore` must contain `.claude-code-hermit/state/` (or `.claude-code-hermit/`), `.env`, `.env.local`; WARN for each missing entry |
| 10 | Test command safety | Read the configured test command — WARN if it looks potentially destructive (e.g., contains `rm`, `curl \| sh`, drops tables); this is a judgment call |

## Output format

```
dev-doctor report

[smoke-test: PASS / FAIL — <summary>]    ← manual mode only
[config-validator: PASS / FAIL]           ← manual mode only

PASS  core v1.0.16 ≥ required v1.0.16
PASS  dev workflow marker present in CLAUDE.md
FAIL  always_on=true but AGENT_HOOK_PROFILE is not strict — guard will never fire
PASS  protected branches configured: main, staging
WARN  no typecheck or lint command configured
PASS  git worktree supported
PASS  git-push-guard.js parses cleanly
WARN  .gitignore missing .env.local entry

Safe for implementer: no   (1 FAIL)
Next: set AGENT_HOOK_PROFILE=strict via /claude-code-hermit:hermit-settings env
```

The final line `Safe for implementer: yes|no` is machine-readable — future skills (e.g., `/dev-ready`) can parse it.

## Scheduled-check registration

During `/claude-code-dev-hermit:hatch` Phase 3, offer to register dev-doctor as a weekly scheduled check:

```json
{
  "id": "dev-doctor",
  "plugin": "claude-code-dev-hermit",
  "skill": "claude-code-dev-hermit:dev-doctor",
  "trigger": "interval",
  "interval_days": 7,
  "enabled": true
}
```

Add to hatch's Phase 3 AskUserQuestion:

```
{
  header: "Dev doctor",
  question: "Run a weekly automated setup check? Verifies test commands, protected branches, hook profile, and worktree support.",
  options: [
    { label: "Yes (weekly)", description: "Register dev-doctor as a scheduled check — findings flow through the reflection pipeline" },
    { label: "Skip", description: "Run /dev-doctor manually when needed" }
  ]
}
```

When accepted, add the entry to `scheduled_checks` in the config flush (Step 4). The entry fires via the core `reflect-scheduled-checks` routine and findings flow to `reflection-judge` → `proposal-triage` automatically.
