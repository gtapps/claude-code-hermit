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

### Tools

Skills self-advertise through their own `SKILL.md` descriptions — they are not catalogued here. The curated `php forge.php` commands cover the hot paths. For any other SDK read — server events, firewall rules, databases, scheduled jobs, certificates, etc. — use read-only generic dispatch:

```bash
# Args as JSON array on stdin; the org slug is prepended automatically
# (except global methods like `organizations` and `sites`).
echo '["<server-id>"]' | php ${CLAUDE_PLUGIN_ROOT}/php/forge.php call databases
echo '["<server-id>", "<site-id>"]' | php ${CLAUDE_PLUGIN_ROOT}/php/forge.php call deployments
```

Only read methods on the closed allowlist are accepted — this path cannot mutate anything.

---

### Scheduled checks & notifications

The `forge-failed-deploys` scheduled check is analysis-only: it surfaces sites whose latest deployment failed and routes findings through the normal proposal pipeline as `[reliability]` proposals. It sends no channel messages itself.

Anything operator-facing (deploy success/failure, escalations) is relayed via the **Operator Notification protocol in CLAUDE.md** — do not build a separate notification path.

---

### Credentials

`FORGE_API_TOKEN` lives in the gitignored `.env` at the project root.

- **Never `cat`, `echo`, `grep`, or Read `.env`** to check the token — run `php ${CLAUDE_PLUGIN_ROOT}/php/forge.php check` instead. It self-reports `missing`/`invalid`/`unreachable`/`ok` without revealing the value.
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
