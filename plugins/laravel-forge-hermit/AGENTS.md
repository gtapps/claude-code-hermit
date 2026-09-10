# Laravel Forge Hermit

`php/forge.php` calls the official `laravel/forge-sdk` directly. Preserve the SDK boundary; do not add a second HTTP client, Bun bridge, or manually maintained endpoint registry.

## Write and credential boundaries

- Forge writes follow preview, explicit operator approval of the canonical target/request, then execution. This is the shipped Forge workflow, not a restriction on local source edits.
- Curated `deploy`, `server-reboot`, and generic `execute <plan-id>` request Claude Code native approval through project permission rules. Keep previews before execution.
- `php/forge-operation.php` owns request capture, canonicalization, stored plans, and execution-time hash checks. A plan hash binds the request; operator approval supplies authority. Neither substitutes for the other.
- `php/forge-lib.php` derives SDK reachability and policy from reflection and the captured HTTP verb. Preserve the secrets/destructive deny tiers and supported operator policy overrides; `forge.php policy` reports the effective policy.
- Use `forge.php check` for credential status, never read or print `.env`. Scrub deployment/server logs before relay or persistence.

## Runtime and verification

Hatch installs the SDK into the consumer's `.claude-code-hermit/forge-runtime/vendor/`, isolated from the app's Composer files. Ship `php/composer.json` and its lock; never commit a vendor tree.

Run `bash tests/run-all.sh` from this plugin directory with the PHP version/extensions required by `php/composer.json` and Composer available. The runner installs the local SDK fixture, executes `php/tests/run.php`, runs the permission tests, and invokes structural lints separately. Do not substitute bare `bun test`: structural files call `process.exit()` and can terminate its runner early.

Request-capture and canonicalization checks (Blocks A/B in `php/tests/run.php`) are essential when changing the write gateway. When adding a skill, update the explicit `SKILLS` list in `tests/skill-structure.test.ts`.

The native-permissions installer adds missing project ask rules without changing operator settings. Existing legacy marker files are unused and remain untouched.
