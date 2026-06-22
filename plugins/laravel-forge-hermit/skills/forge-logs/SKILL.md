---
name: forge-logs
description: Read site deployment logs, server logs, and specific deployment logs from Laravel Forge. Includes a triage mode that bundles recent logs with deployment history for rapid incident analysis. Triggers on "show logs", "read logs", "deployment log", "server log", "what happened to the deployment", "triage failing site".
---

# Forge Logs

Read deployment and server logs from Forge.

---

## Latest deployment log for a site

```bash
php ${CLAUDE_PLUGIN_ROOT}/php/forge.php logs <server> <site>
```

Fetches the most recent deployment and returns its full log.

## Specific deployment log

```bash
php ${CLAUDE_PLUGIN_ROOT}/php/forge.php deploy-log <server> <site> <deploy-id>
```

Use `deploy-history` first to find the deployment ID.

## Server log

```bash
php ${CLAUDE_PLUGIN_ROOT}/php/forge.php server-log <server> <key>
```

Common keys: `php`, `nginx`, `mysql`, `cron`, `daemon`. Key list depends on the server's installed services.

---

## Triage mode

When the operator says something like "what's wrong with myapp.com" or "triage the failing site", bundle context automatically:

1. `php ${CLAUDE_PLUGIN_ROOT}/php/forge.php site <server> <site>` — confirm the site is reachable and check status fields.
2. `php ${CLAUDE_PLUGIN_ROOT}/php/forge.php deploy-history <server> <site>` — surface the last few deployments and their statuses.
3. `php ${CLAUDE_PLUGIN_ROOT}/php/forge.php logs <server> <site>` — fetch the latest deployment log.
4. Synthesize: identify the failure type (build error, composer error, migration error, timeout), highlight the relevant log section, and suggest a remedy.

---

## Secret hygiene

**Deployment and server logs may contain env dumps, database credentials, and API keys.** Apply these rules to every log-reading flow:

- **Never paste raw log output into the channel.** Always summarize or excerpt.
- **Never write raw log content to `compiled/` or `raw/`** — scrub any credential values to `[REDACTED]` before persistence.
- If asked to share a log, review it first and redact any secret-pattern lines.

---

## Notes

- `<server>` and `<site>` accept name, hostname, or numeric ID.
- For a failed deployment you triggered via `forge-deploy`, the `deploy-incident` artifact (written by `forge-deploy` when its watch Monitor sees a failed terminal status) already contains the scrubbed log tail — check `compiled/deploy-incident-<site>-<date>.md` before re-fetching.
