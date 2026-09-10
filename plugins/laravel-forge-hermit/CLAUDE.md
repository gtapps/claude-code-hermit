# laravel-forge-hermit

A Laravel Forge domain layer for `claude-code-hermit`: deployment skills, server/site management, estate health monitoring, and a daily failed-deployment scan, all over the official `laravel/forge-sdk` PHP v4.

## Structure

- `skills/`: `hatch`, `forge-servers` (list, detail, reboot flow), `forge-sites`, `forge-deploy` (preview → approve → deploy; failure → deploy-incident artifact), `forge-logs` (deployment + server logs, triage mode), `forge-failed-deploys` (daily scheduled estate scan, analysis-only). `tests/skill-structure.test.ts` pins the `SKILLS` list; a new skill goes there too.
- `php/forge.php`: dispatch script: curated commands, generic dispatch, write-confirmation gate
- `php/forge-operation.php`: the write gateway: request capture, canonicalization, plan store, hash-checked execution
- `php/forge-lib.php`: derived predicates (`isEndpointMethod`, `takesOrgFirst`), deny tiers, policy loading, output scrubber
- `php/composer.json` + `php/composer.lock`: shipped; `php/vendor/` is gitignored
- `hooks/write-confirm-gate.ts`: PreToolUse Bash hook: blocks `deploy`/`server-reboot` without `--confirm`
- `state-templates/CLAUDE-APPEND.md`: Forge Workflow block injected by hatch; `settings.json`: pre-approved Bash and hermit-state permissions; `DOCKER.md`: apt deps + DNS allowlist for `/docker-setup`

## Architecture

Hatch registers the `forge-failed-deploys` routine with `reflect --check-id forge-failed-deploys --check laravel-forge-hermit:forge-failed-deploys`; its cadence lives in `config.routines`.

The agent calls `php ${CLAUDE_PLUGIN_ROOT}/php/forge.php <command>` directly via Bash. The SDK handles all HTTP: no hand-rolled API client, no bun CLI, no bridge process. The vendor tree is not committed; hatch installs `laravel/forge-sdk` `--no-dev` via Composer into the consumer project's `.claude-code-hermit/forge-runtime/vendor/` (persistent, bind-mounted in Docker, isolated from the app's own Composer files).

## Rules

- **Surface-then-approve on every write.** Preview first, relay the canonical target, invoke the execution command for native approval. No exceptions.
- **Two write paths, two enforcement mechanisms.** For the curated `deploy` / `server-reboot` commands the layers are the write-confirm-gate hook plus the in-PHP `--confirm` check; neither is optional. For generic dispatch the layers are the **plan hash** (code-enforced: `execute` re-captures the request and refuses unless it hashes to the approved one) and **Claude Code native approval** for `execute <plan-id>`. `--confirm` plays no part there: it only ever proved a flag was typed, and the agent types the flag. Generic dispatch also reaches `createDeployment` and `createServerAction`, so `deploy` and `server-reboot` have a second route the hook does not see; on that route the plan hash and the operator's approval are the only gate.
- **Never echo, cat, or Read `.env`.** Check credential state with `forge.php check` (self-reports `missing`/`invalid`/`unreachable`/`ok`).
- **Deployment and server logs may contain secrets.** Scrub before relay and before persistence (the CLAUDE-APPEND secret-hygiene rule).
- **Generic dispatch reaches the whole SDK minus two deny tiers** (`secrets`, `destructive`), because the Forge API token is what authorizes an operation; this plugin owns autonomy and context hygiene, not authorization. Reads go through `call`, writes through `preview` → approval → `execute <plan-id>`. Reachability is derived from the installed SDK by reflection and from the captured HTTP verb, never from a hand-maintained list. `forge.php policy` prints the effective state.
- **`php/forge-operation.php` is the security-critical file.** Capture, canonicalization, plan storage, and the hash check live there, with no CLI parsing or output formatting, so `php/tests/run.php` drives it directly. Its Blocks A and B run first in the suite for a reason: if the captured request is not what the SDK would really send, every other guarantee is decorative.

## Hatch target routing

Core's `scripts/domain-hatch.ts` owns target resolution and `hatch-options.json`. `/hatch` Step 1 runs `.claude-code-hermit/bin/hermit-run domain-hatch preflight laravel-forge-hermit`; Step 5 records any override with `domain-hatch ensure-target laravel-forge-hermit --target <choice>` and writes the block with `domain-hatch sync-block laravel-forge-hermit`.

## Development

`claude --plugin-dir /path/to/plugins/laravel-forge-hermit` from a target project. Tests: `bash tests/run-all.sh` from this directory, with PHP and Composer available; the runner installs the SDK fixture into `php/vendor/` itself, then runs `php/tests/run.php`, the hook tests, and the structural lints separately. Plain `bun test` is not a substitute: the structural files call `process.exit()` and can end its runner early.

The native-permissions installer owns `.claude-code-hermit/state/laravel-forge-hermit-native-permissions-v1.json`, a durable completion marker written only by a successful `--migrate` run. Preserve it across upgrades so later operator policy choices are not migrated again.
