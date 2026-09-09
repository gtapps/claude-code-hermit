---
name: hatch
description: One-time Laravel Forge hermit setup. Installs the Forge PHP SDK, verifies credentials, and wires the estate scan into config.json. Run once per project after /claude-code-hermit:hatch.
disable-model-invocation: true
---

# Hatch — laravel-forge-hermit

Idempotent setup wizard for the Laravel Forge plugin. Run **after** `/claude-code-hermit:hatch` has been completed.

---

## Step 1 — Prerequisite check

Check whether `.claude-code-hermit/config.json` exists.

If it does not:

Print this block and stop:

```markdown
## ▶ Next step — type this now

    /claude-code-hermit:hatch

I can't run setup wizards for you (they're operator-run by design).
After it finishes, come back and type `/laravel-forge-hermit:hatch`.
```

If it does exist, run `.claude-code-hermit/bin/hermit-run domain-hatch preflight laravel-forge-hermit` and parse the JSON verdict. Branch on `action`:

- **`upgrade-core-package` / `upgrade-core-applied`** → relay the `remedy` string verbatim to the operator and stop.
- **`verify`** → say:

  > "laravel-forge-hermit {self_version} is already installed. Reply 'verify' to re-run checks only, or 'full' to re-run the full wizard."

  Use `AskUserQuestion`: "(verify / full)" — **verify** → skip to Step 4; **full** → continue from Step 2.
- **`full`** → continue from Step 2.
- **`ok: false`** → relay `message` and stop.

---

## Step 2 — PHP/Composer preflight + SDK install

**Check PHP version.** Run `php -r 'echo PHP_VERSION;'` via Bash. Parse the output. If `php` is not found or the version is below 8.5.0, relay this and stop:

> "PHP 8.5+ is required but not found (got: {version or 'not found'}).
>
> - **Docker**: re-run `/docker-setup` after the core base image is updated to Ubuntu 26.04 (which ships PHP 8.5 natively). If the core base is still 24.04, the Docker path is blocked pending that upgrade.
> - **Bare-metal**: install `php8.5-cli` and `php8.5-curl` (or your distro's equivalent)."

**Check Composer.** Run `composer --version`. If not found, relay this and stop:

> "Composer is not found. Install it from https://getcomposer.org/."

**Install the Forge SDK into project space.** The SDK goes into `.claude-code-hermit/forge-runtime/` (hermit-owned, isolated from your app's own `composer.json`/`vendor/`).

Run these Bash commands:

```bash
mkdir -p .claude-code-hermit/forge-runtime
cp "${CLAUDE_PLUGIN_ROOT}/php/composer.json" .claude-code-hermit/forge-runtime/composer.json
cp "${CLAUDE_PLUGIN_ROOT}/php/composer.lock" .claude-code-hermit/forge-runtime/composer.lock
```

**Idempotent install check**: if `.claude-code-hermit/forge-runtime/vendor/` exists and the staged `composer.lock` content matches `${CLAUDE_PLUGIN_ROOT}/php/composer.lock`, skip the install. Otherwise run:

```bash
composer install --no-dev --no-interaction --working-dir=.claude-code-hermit/forge-runtime
```

If composer exits non-zero, surface the error. Common cause: egress blocked — `packagist.org`, `repo.packagist.org`, `api.github.com`, `codeload.github.com` must be reachable. In Docker, verify the DNS allowlist in DOCKER.md is present.

---

## Step 3 — Verify .env + consumer .gitignore

Credential verification belongs to `forge.php check` in Step 4. Do not read `.env` into context.

Tell the operator:

> "Add your Forge API credentials to `.env` in the project root:
>
> ```
> FORGE_API_TOKEN=your-forge-api-token
> FORGE_ORG=your-org-slug        # optional if you have exactly one org
> ```
>
> Get your token at https://forge.laravel.com/profile/api. Reply 'done' when set, or 'skip' to continue (credential check happens in Step 4)."

Use `AskUserQuestion`: "(done / skip)"

**Read the consumer's `.gitignore`** (this file is not a secret — only the `.env` content is). Check if `.env` and `.env.*` patterns are present. If missing, offer to add them:

```
.env
.env.*
```

Append any missing patterns via Edit.

---

## Step 4 — CLI probe (credential check)

Run: `php ${CLAUDE_PLUGIN_ROOT}/php/forge.php check`

- **`missing`** → tell the operator to add `FORGE_API_TOKEN` to `.env` and re-run Step 3.
- **`invalid`** → token found but API rejected it; tell the operator to check the token at https://forge.laravel.com/profile/api.
- **`unreachable`** → token present but the API could not be reached (network/egress blocked). In Docker, verify the DNS allowlist in DOCKER.md (`forge.laravel.com`). Re-run once connectivity is confirmed.
- **`ok`** → continue.

If `php` is not found at this point: re-run Step 2.

---

## Step 5 — CLAUDE.md / CLAUDE.local.md inject

**Resolve target file**: Step 1's preflight already returned `target`, `target_file`, `target_default` and `needs_target_question`.

If `needs_target_question` is true, ask with `AskUserQuestion` (header: "Visibility") — `target_default` at position 0 with `(recommended)`: **`.local` files** (gitignored, operator-personal) / **Committed files** (shared with teammates). Then record it:

```bash
.claude-code-hermit/bin/hermit-run domain-hatch ensure-target laravel-forge-hermit --target <choice>
```

Then write the block:

```bash
.claude-code-hermit/bin/hermit-run domain-hatch sync-block laravel-forge-hermit
```

It appends the `<!-- laravel-forge-hermit: Forge Workflow -->` block when the marker is absent and skips when it is already present; `hermit-evolve` handles replacement on upgrade.

---

## Step 6 — Knowledge-schema extension

Read `.claude-code-hermit/knowledge-schema.md`.

Check for `deploy-incident:` in the file. If absent, append under `## Work Products`:

```
- deploy-incident: per-failure deployment record with scrubbed log tail and resolution. Producer: forge-deploy skill on a failed terminal deploy status. location: compiled/deploy-incident-<site>-<YYYY-MM-DD>.md
```

Use Edit. Skip if already present (idempotent).

---

## Step 7 — Stamp + register in config.json

Re-read `.claude-code-hermit/config.json` now — the wizard has been running since Step 1 and the on-disk file may have changed. Apply the merges below to that fresh copy.

**Stamp version**: set `_hermit_versions["laravel-forge-hermit"]` to `self_version` from Step 1's preflight.

**Merge the failed-deployment routine**

Merge these entries into `config.routines` by id. Create the array if absent. Append each missing id; skip any existing id, preserving operator edits and all other config fields. No prompt is needed for these read-only analyses.

```json
{"id": "forge-failed-deploys", "schedule": "5 9 * * *", "skill": "claude-code-hermit:reflect --check-id forge-failed-deploys --check laravel-forge-hermit:forge-failed-deploys", "run_during_waiting": true, "enabled": true}
```

Each routine owns its cadence and passes findings through reflection gates into the proposal pipeline.

**Register runtime dir**: ensure `config.storage_drift` exists and `config.storage_drift.ignore` is an array that includes `"forge-runtime"`. If the key is absent, add `"storage_drift": {"ignore": ["forge-runtime"]}`. If the array exists but does not include `"forge-runtime"`, append it. Skip if already present.

Write the updated `config.json` via Write tool (full file replacement for valid JSON).

---

## Native approval rules

Resolve the project settings target through `.claude-code-hermit/bin/hermit-run domain-hatch preflight laravel-forge-hermit`. Map `target` (or `target_default` when absent): `local` to `.claude/settings.local.json`, `committed` to `.claude/settings.json`. Its `target_file` is the instruction destination, not the settings file.

Run `bun ${CLAUDE_PLUGIN_ROOT}/scripts/native-permissions.ts <resolved-settings-file>`. This installs the fixed native ask rules, preserves existing denies and unrelated settings, and is safe to repeat. Do not pass `--migrate` during ordinary hatch. Native asks follow Claude Code's permission mode; bypass mode does not provide an operator checkpoint.

## Step 8 — Final report

```
laravel-forge-hermit {version} setup complete.

Installation summary:
  ✓ Prerequisite: claude-code-hermit {base_version} confirmed
  ✓ PHP 8.5+ found: {php_version}
  ✓ Composer found
  ✓ Forge SDK installed → .claude-code-hermit/forge-runtime/vendor/
  ✓ .env: FORGE_API_TOKEN present, API check: ok
  ✓ .gitignore: .env covered
  ✓ CLAUDE.md: Forge Workflow block injected (or already present)
  ✓ knowledge-schema.md: deploy-incident type added (or already present)
  ✓ config.json: _hermit_versions stamped, forge-failed-deploys routine registered

Next steps:
  - Restart Claude Code so the updated CLAUDE.md loads.
  - Run /claude-code-hermit:hermit-routines load to activate the daily estate scan.
  - In Docker: the forge-runtime/ vendor is in your project tree (bind-mounted/persistent) — it survives container restarts.

Installed skills:
  /laravel-forge-hermit:forge-servers        — list / detail / reboot servers
  /laravel-forge-hermit:forge-sites          — list / detail sites
  /laravel-forge-hermit:forge-deploy         — preview → approve → deploy
  /laravel-forge-hermit:forge-logs           — read site / server / deployment logs
  /laravel-forge-hermit:forge-failed-deploys — daily estate scan (daily routine)

Security reminder: FORGE_API_TOKEN is in .env — verify it is gitignored before any git push.
```

---

## Docker network requirements

Read by `/claude-code-hermit:docker-security` when the operator enables LAN containment + DNS policy.

### Domains (DNS allowlist)

- forge.laravel.com
- packagist.org
- repo.packagist.org
- api.github.com
- codeload.github.com
