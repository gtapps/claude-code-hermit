# laravel-forge-hermit

A Laravel Forge domain layer for `claude-code-hermit`: deployment skills, server/site management, estate health monitoring, and a daily failed-deployment scan — all over the official `laravel/forge-sdk` PHP v4.

## Plugin Structure

- `skills/hatch/` — one-time setup wizard: `/laravel-forge-hermit:hatch`
- `skills/forge-servers/` — server list, detail, reboot flow
- `skills/forge-sites/` — site list and detail
- `skills/forge-deploy/` — preview → approve → deploy; failure → deploy-incident artifact
- `skills/forge-logs/` — deployment + server logs, triage mode
- `skills/forge-failed-deploys/` — daily scheduled estate scan (analysis-only)
- `php/forge.php` — PHP dispatch script: read-only generic dispatch, curated commands, write-confirmation gate
- `php/composer.json` + `php/composer.lock` — shipped; `php/vendor/` is gitignored (hatch installs SDK into project space)
- `hooks/write-confirm-gate.ts` — PreToolUse Bash hook: blocks deploy/server-reboot without `--confirm`
- `state-templates/CLAUDE-APPEND.md` — Forge Workflow block injected by hatch
- `settings.json` — pre-approved Bash and hermit-state permissions
- `DOCKER.md` — apt deps + DNS allowlist for `/docker-setup`
- `.claude-plugin/plugin.json` — plugin manifest
- `.claude-plugin/hermit-meta.json` — hermit-internal fields (`required_core_version`, `requires`)

## Architecture

The agent calls `php ${CLAUDE_PLUGIN_ROOT}/php/forge.php <command>` directly via Bash. The SDK handles all HTTP — no hand-rolled API client, no bun CLI, no bridge process.

The vendor tree is **not committed to this repo** — hatch installs `laravel/forge-sdk` `--no-dev` via Composer into the consumer project's `.claude-code-hermit/forge-runtime/vendor/` (persistent, bind-mounted in Docker, isolated from the app's own `composer.json`/`vendor/`).

## Hatch target routing

`/hatch` Step 6 reads `.claude-code-hermit/state/hatch-options.json` (`target` field) to route the CLAUDE-APPEND block: `"local"` → `CLAUDE.local.md`, `"committed"` → `CLAUDE.md`.

## Core Rules

- **Surface-then-approve on every write.** Preview first, relay canonical target, wait for explicit approval, re-run with `--confirm`. No exceptions.
- The write-confirm-gate hook and the in-PHP `--confirm` gate are two independent layers. Neither is optional.
- **Never echo, cat, or Read `.env`** — check credential state with `forge.php check` (self-reports `missing`/`invalid`/`ok`). The `TOKEN` substring in `FORGE_API_TOKEN` triggers the base hermit deny-pattern hook.
- **Deployment and server logs may contain secrets.** Scrub before relay and before persistence — see CLAUDE-APPEND secret-hygiene rule.
- Generic dispatch (`forge.php call <method>`) is read-only by design (closed allowlist). Write ops only go through the curated `deploy` / `server-reboot` commands.

## Development

Test locally without publishing:

```
cd /path/to/target-project
claude --plugin-dir /path/to/plugins/laravel-forge-hermit
```

Under `--plugin-dir`, `${CLAUDE_PLUGIN_ROOT}` is NOT substituted — use the absolute plugin path in commands.

For tests, first install the SDK into a local vendor tree:

```bash
cd plugins/laravel-forge-hermit
composer install --working-dir=php
bun test
php php/tests/run.php
```

## Development constraints

- The `tests/skill-structure.test.ts` expects exactly 6 skills, each with a matching `name` field in frontmatter. Add a new skill → update the `SKILLS` array in that file.
- The deny-pattern hook blocks any Bash arg containing literal `TOKEN`. Never put `FORGE_API_TOKEN` on a command line.
- When aligning with a new core version, sweep `skills/`, `state-templates/`, `docs/` for stale hermit-facing terms.
