<!-- laravel-forge-hermit: Forge Workflow -->

## Laravel Forge

This project uses `laravel-forge-hermit` for Forge operations: deployments, server/site management, and estate health monitoring.

---

### Safety rule — surface-then-approve (read this first)

**Every write operation goes through preview → relay → approve → confirm.** Never auto-confirm a deploy or reboot.

1. Run `php ${CLAUDE_PLUGIN_ROOT}/php/forge.php preview-deploy <server> <site>` (or `preview-reboot`).
2. Relay the **canonical target** (server name, IP, site name, IDs) to the operator.
3. Wait for explicit approval.
4. On approval: re-run with `--confirm`.

A wrong reboot causes an outage. A wrong deploy targets the wrong site. The `write-confirm-gate.ts` hook and the in-PHP `--confirm` gate enforce this at two layers — neither can be bypassed.

---

### Skills

| Skill | Trigger | Purpose |
|---|---|---|
| `/laravel-forge-hermit:hatch` | setup | one-time install wizard |
| `/laravel-forge-hermit:forge-servers` | "list servers", "reboot server" | server list, detail, reboot flow |
| `/laravel-forge-hermit:forge-sites` | "list sites", "show site" | site list and detail |
| `/laravel-forge-hermit:forge-deploy` | "deploy", "trigger deployment" | preview → approve → deploy; failure → deploy-incident |
| `/laravel-forge-hermit:forge-logs` | "show logs", "triage site" | deployment + server logs, triage mode |
| `/laravel-forge-hermit:forge-failed-deploys` | (scheduled, 1d) | estate scan, analysis-only |

---

### Tools

The curated `php forge.php` commands cover the hot paths. For any other SDK read — server jobs, daemons, firewall rules, certificates, database users, etc. — use read-only generic dispatch:

```bash
# Args as JSON array on stdin; org slug is prepended automatically.
echo '["<server-id>"]' | php ${CLAUDE_PLUGIN_ROOT}/php/forge.php call jobs
echo '["<server-id>", "<site-id>"]' | php ${CLAUDE_PLUGIN_ROOT}/php/forge.php call certificates
```

Only read methods on the closed allowlist are accepted — this path cannot mutate anything.

---

### Scheduled checks

| Check | Cadence | Type |
|---|---|---|
| `forge-failed-deploys` | daily | analysis-only, routes to `[reliability]` proposals |

---

### Credentials

`FORGE_API_TOKEN` lives in the gitignored `.env` at the project root.

- **Never `cat`, `echo`, `grep`, or Read `.env`** to check the token — run `php ${CLAUDE_PLUGIN_ROOT}/php/forge.php check` instead. It self-reports `missing`/`invalid`/`ok` without revealing the value.
- `TOKEN` appears in the key name: the base hermit's deny-pattern hook blocks any Bash arg containing the literal string `TOKEN`.

---

### Secret hygiene

Deployment and server logs may contain env dumps, database credentials, and API keys. This rule applies to **channel relay AND persistence**:

- Never paste raw log output into a channel message.
- Never write raw log content to `compiled/` or `raw/`.
- Always scrub credential-pattern lines to `[REDACTED]` before sharing or persisting.

---

### Proposal categories

| Prefix | Meaning |
|---|---|
| `[reliability]` | recurring failure pattern across the estate |
| `[hygiene]` | estate drift detected from API signals |
| `[deploy-safety]` | workflow risk on the deploy or reboot path |

---

<!-- /laravel-forge-hermit: Forge Workflow -->
