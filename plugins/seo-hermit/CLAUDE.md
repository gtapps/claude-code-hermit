# seo-hermit

An SEO/site-health domain layer for `claude-code-hermit`: a weekly watcher over Google Search
Console, broken links, and Core Web Vitals, with a judgment layer that correlates regressions with
site-repo commits and drafts mechanical fixes.

## This Repo is a Plugin

This repo is structured as a Claude Code plugin. It is NOT a standalone project — it gets installed
into other projects via:

```
claude plugin marketplace add gtapps/claude-code-hermit
claude plugin install seo-hermit@claude-code-hermit --scope local
```

After install, run `/seo-hermit:hatch` in the target project. The core hermit
(`claude-code-hermit` ≥1.2.14) must be installed and hatched first — `hatch` will prompt if it isn't.

## Plugin Structure

- `skills/hatch/` — one-time setup wizard (`/seo-hermit:hatch`)
- `skills/site-health-check/` — weekly routine: pull deltas, diff the ledger, report changes
- `skills/site-regression-triage/` — correlate a flagged regression with recent site-repo commits
- `skills/site-draft-fix/` — draft a mechanical fix on a branch, behind an approval gate
- `scripts/site-api.ts` — zero-dep Bun client for Search Console + PageSpeed Insights
- `state-templates/CLAUDE-APPEND.md` — SEO Workflow block injected into the consumer's CLAUDE.md by `hatch`
- `docs/knowledge-schema.md` — work-product types and retention rules
- `settings.json` — pre-approved permissions for the site-api script and read-class git
- `.claude-plugin/plugin.json` / `hermit-meta.json` — manifests

## Hatch target routing

`/hatch` Step 6 reads `.claude-code-hermit/state/hatch-options.json` (`target` field) to route the
CLAUDE-APPEND block: `"local"` → `CLAUDE.local.md`, `"committed"` → `CLAUDE.md`. If no
`hatch-options.json` exists, it detects `core_install_scope` from `claude plugin list --json` and
stamps the canonical 5-field schema.

## Core Rules

- **Never Read the service-account JSON.** It holds an RSA private key. Check credential state with
  `site-api.ts check` (self-reports `missing`/`invalid`/`unreachable`/`ok`); verify the key file's
  *existence* only.
- **Credentials never touch a command line.** `site-api.ts` loads them from `.env` /
  `SEO_HERMIT_GSC_CREDENTIALS`. The four `SEO_HERMIT_*` var names deliberately avoid the
  `TOKEN`/`SECRET`/`API_KEY` deny substrings so `.env` can be read with the Read tool.
- **Read-only toward Google.** No writes to Search Console or search-facing config, ever.
- **Site-repo writes are approval-gated.** All fixes go through `site-draft-fix`: draft on a branch,
  show the diff, wait for approval, never push, never touch a protected branch.
- **URL Inspection is budgeted.** Per-URL index checks respect a weekly budget (~2,000/day/property
  quota), rotating the sitemap via the ledger `inspect_cursor`.

## Memory Conventions

- `state/site-health-ledger.json` — rolling machine-readable diff state (search history, broken
  links, CWV history, index sample, inspect cursor). Permanent, trimmed in place.
- `raw/` — ephemeral API pulls, aged out per `knowledge.raw_retention_days`.
- `compiled/` — durable dated reports (`site-health-*`, `site-triage-*`, `site-fix-*`).

Do NOT create subdirectories inside `raw/` or `compiled/`. Flat layout only (base hermit storage contract).

## `site-api.ts` subcommands

| Subcommand | Purpose |
|------------|---------|
| `check` | Credential probe. Prints `missing`/`invalid`/`unreachable`/`ok` (+ optional `psi:<status>`). |
| `search-analytics --start --end [--dimensions] [--row-limit]` | Search Console query → `{ok,data:{rows,totals}}`. |
| `sitemap` / `link-check` / `psi` / `inspect` / `ledger` | Weekly-routine data pulls + the diff engine (see `site-health-check`). |

## Routines

The weekly `site-health-weekly` routine invokes the `site-health-check` **skill directly**
(`{"skill": "seo-hermit:site-health-check", ...}`), the core `weekly-review` pattern — not a
`prompt_file` drop. Routine logic lives in the shipped skill so it upgrades with the plugin and is
covered by `skill-structure.test.ts`; a dropped prompt file would be install-once and never receive
upgrades.

## Development

Test locally against a target project without publishing:

```
cd /path/to/target-project
claude --plugin-dir /path/to/plugins/seo-hermit
```

Under `--plugin-dir`, `${CLAUDE_PLUGIN_ROOT}` is NOT substituted — use the absolute plugin path in
commands. `${CLAUDE_PLUGIN_ROOT}` is never a runtime env var; the script self-resolves its own dir.

Run tests (from inside the plugin dir):

```
bash tests/run-all.sh      # bun site-api + skill-structure tests
```

Typecheck from the repo root: `bunx tsc` (strict; `plugins/**/*.ts` is included).

## Development constraints

- `tests/skill-structure.test.ts` hardcodes the `SKILLS` array — add a skill → update that array.
- No runtime dependencies: `site-api.ts` imports only the standard library and Bun/`node:*` built-ins.
- The base hermit deny-patterns hook blocks any Bash arg containing `TOKEN`/`SECRET`/`API_KEY`. Keep
  credential values off command lines.
- CLAUDE-APPEND must not restate `config.json` values (routine schedules, flags). Describe behaviors.
