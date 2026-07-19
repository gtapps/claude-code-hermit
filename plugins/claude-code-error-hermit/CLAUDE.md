# claude-code-error-hermit

A production-error domain layer for `claude-code-hermit`: watches a Sentry/GlitchTip project, triages new error groups against a noise ledger, correlates regressions with releases, and (in later phases) reproduces, bisects, and drafts fixes. All over a zero-dependency Bun `fetch` client — no SDK, no MCP server.

## This Repo is a Plugin

Installed into a target project (the app you want to watch) via:

```
claude plugin marketplace add gtapps/claude-code-hermit
claude plugin install claude-code-error-hermit@claude-code-hermit --scope local
```

After install, run `/claude-code-error-hermit:hatch`. The core hermit (`claude-code-hermit` ≥1.2.14) must be installed and hatched first — `hatch` prompts if it isn't.

## Plugin Structure

- `skills/hatch/` — one-time setup wizard (`/claude-code-error-hermit:hatch`)
- `skills/error-triage/` — watch-loop triage (routine-driven): classify new/regression/noise, correlate releases, DM or queue
- `skills/error-reproduce/` — worktree checkout at the offending SHA, failing test from the stack, `git bisect`
- `skills/error-draft-fix/` — fix on an `error-fix/<shortId>` branch; push/PR delegated to dev-hermit, never improvised
- `skills/error-incident-summary/` — post-incident writeup linked from the noise ledger
- `skills/error-digest/` — overnight digest draining the triage queue into one channel message
- `scripts/error-api-lib.ts` — pure helpers: `resolveConfig`, `apiRequest`, `redact`, `summarizeIssue`/`summarizeEvent`, query/path builders. Imported by the CLI, the precheck, and the tests so all exercise the same code.
- `scripts/error-api.ts` — CLI: `check`, `issues`, `issue`, `latest-event`, `resolve --confirm`, `mute --confirm`
- `scripts/error-precheck.ts` — zero-token watch gate: reads the cursor, prints `SKIP`/`EVALUATE`/`ERROR`, never writes
- `hooks/write-confirm-gate.ts` — PreToolUse Bash hook: blocks `resolve`/`mute` without `--confirm`
- `state-templates/CLAUDE-APPEND.md` — Error Watch block injected by hatch
- `state-templates/compiled/error-noise-ledger.md` — the classification-memory template hatch drops
- `docs/knowledge-schema.md` — work-product types and retention
- `.claude-plugin/plugin.json` — plugin manifest
- `.claude-plugin/hermit-meta.json` — hermit-internal fields (`required_core_version`, `requires`)

## Architecture

The agent calls `bun ${CLAUDE_PLUGIN_ROOT}/scripts/error-api.ts <command>` via Bash. The script reads `.env` at the project root (`loadEnv`, `process.env` wins) and talks to the tracker over stdlib `fetch` with a `Bearer` header. **GlitchTip implements the Sentry `/api/0/` API shape, so one client covers both backends** — the endpoint set is the minimal intersection both support.

**lib/CLI split.** `error-api-lib.ts` is pure (no `process.exit`, no argv). The tests spawn the CLI against a local `Bun.serve` fixture server and also unit-test the lib parsers directly. No live backend is needed to test; `hatch` runs the live `check` at operator setup time.

**Write gating is two independent layers.** The in-CLI `--confirm` refusal (authoritative — sends no request without it) and the `write-confirm-gate.ts` PreToolUse hook (defense-in-depth, fail-open). Neither is optional.

**Cursor rule.** `state/error-cursor.json` is read by `error-precheck.ts` and written only by the `error-triage` skill after a successful run. The precheck never mutates it — a broken precheck must never silently advance the cursor.

## Core Rules

- **Never echo, cat, grep, or Read `.env`** — check credentials with `error-api.ts check`. `ERROR_HERMIT_TOKEN` contains the literal `TOKEN`, which trips the base hermit deny-pattern hook.
- **The token is never printed.** All error text passes through `redact()` before any output. Keep it that way.
- **Event payloads may contain secrets.** Scrub before relay and before persistence — see the CLAUDE-APPEND secret-hygiene rule.
- **resolve/mute are surface-then-approve.** Never mutate the tracker autonomously.
- No persona, agent name, or sign-off copy — those live in the consumer's `config.json`.

## Deliberately omitted in v1

- **`domain-brainstorm` hook-in.** Fitness ships one; this plugin does not, to keep the surface minimal. Add later if the brainstorm contract proves valuable here.

## Development

Test locally against a target project without publishing:

```
cd /path/to/target-project
claude --plugin-dir /path/to/plugins/claude-code-error-hermit
```

Under `--plugin-dir`, `${CLAUDE_PLUGIN_ROOT}` is NOT substituted — use the absolute plugin path in commands.

Run the suite from the plugin dir:

```bash
bash tests/run-all.sh   # skill-structure + hook + api-client (all offline)
```

## Development constraints

- `tests/skill-structure.test.ts` holds a hardcoded `SKILLS` array. Add a skill → add its entry (with expected Gate count).
- The deny-pattern hook blocks any Bash arg containing literal `TOKEN`. Never put `ERROR_HERMIT_TOKEN` on a command line.
- When aligning with a new core version, sweep `skills/`, `state-templates/`, `docs/` for stale hermit-facing terms.
