---
name: forge-deploy
description: Deploy a site on Laravel Forge. Always surface-then-approve (preview-deploy first, then deploy --confirm on explicit approval). Optionally watches until done and writes a deploy-incident on failure. Triggers on "deploy", "trigger deployment", "deploy site", "run deployment", "check deployment status".
---

# Forge Deploy

Trigger a deployment on a Forge site. **Always preview before deploying.** A wrong deploy targets the wrong site — preview eliminates that risk.

---

## Surface-then-approve flow

### Step 1 — Preview (read-only, never mutates)

```bash
php ${CLAUDE_PLUGIN_ROOT}/php/forge.php preview-deploy <server> <site>
```

Resolves `<server>` and `<site>` to their canonical SDK records and prints:

```
--- Deploy preview (no action taken) ---
Server: prod-web-01 (ID: 12345, IP: 1.2.3.4)
Site:   myapp.com (ID: 67890)
```

Exit 0. No network write. The hook does not gate this command.

### Step 2 — Relay canonical target to operator

Show the canonical server name, IP, site name, and IDs. Ask for explicit approval.

> "Deploy to **myapp.com** on **prod-web-01** (1.2.3.4)? Reply 'yes' to confirm or 'no' to cancel."

Never auto-confirm. If the operator says anything other than an unambiguous affirmative, cancel.

### Step 3 — On approval only

```bash
php ${CLAUDE_PLUGIN_ROOT}/php/forge.php deploy <server> <site> --confirm
```

Or with watch (polls until the deployment reaches a terminal state):

```bash
php ${CLAUDE_PLUGIN_ROOT}/php/forge.php deploy <server> <site> --confirm --watch
```

`--watch` polls every 5 seconds (max 10 minutes). It exits 0 on `finished`, exits 2 on `failed`/`failed-build`/`cancelled`.

---

## Deployment history

```bash
php ${CLAUDE_PLUGIN_ROOT}/php/forge.php deploy-history <server> <site>
```

Lists recent deployments with ID, status, and commit message.

## Fetch a specific deployment log

```bash
php ${CLAUDE_PLUGIN_ROOT}/php/forge.php deploy-log <server> <site> <deploy-id>
```

---

## On --watch failure: write a deploy-incident

If `deploy --watch` exits 2 (deployment failed/cancelled), write a `deploy-incident` artifact:

**File**: `compiled/deploy-incident-<site-name>-<YYYY-MM-DD>.md`

**Content template**:
```
---
title: Deploy incident — <site-name> <YYYY-MM-DD>
created: <ISO timestamp>
type: deploy-incident
tags: [deploy, failure, <site-name>]
---

## Incident

- Site: <site-name> (ID: <site-id>)
- Server: <server-name> (ID: <server-id>, IP: <ip>)
- Deployment ID: <deploy-id>
- Status: <failed|failed-build|cancelled>
- Detected: <timestamp>

## Commit

<commit message, if available>

## Log tail (scrubbed)

<last ~50 lines of the deployment log, **scrubbed of any credentials, env vars, or secrets**>

## Resolution

(fill in after incident is resolved)
```

**Secret hygiene (critical):** deployment logs frequently contain env dumps, DB connection strings, and API keys. **Never paste raw log content** — always scrub before writing. Fetch the log with `deploy-log`, review it, then excerpt only the error-relevant lines with any credential values redacted (`[REDACTED]`).

---

## Notes

- `<server>` and `<site>` accept name, hostname, URL hostname, or numeric ID. Ambiguous names are rejected.
- The `--confirm` flag is checked by both the in-PHP gate and the `write-confirm-gate.ts` PreToolUse hook. Omitting it always fails — there is no bypass.
- For reading logs without a deploy action, use `/laravel-forge-hermit:forge-logs`.
