---
name: forge-failed-deploys
description: "Interval scheduled check — scans the Forge estate for sites whose latest deployment is in a failure state. Runs daily via the scheduled-checks routine; findings are routed through the proposal pipeline as Evidence Source: scheduled-check/forge-failed-deploys."
---

# Forge Failed Deploys

Scheduled-check skill: scans the org-wide site list and flags any sites whose latest deployment status is `failed`, `failed-build`, or `cancelled`.

**Contract:** idempotent, read-only, no self-scheduling, short-running. Returns findings or silence — never creates proposals itself.

---

## Steps

1. **Run the estate scan.**

   ```bash
   php ${CLAUDE_PLUGIN_ROOT}/php/forge.php failed-deploys --json
   ```

   This pages through the org-wide site list via `organizationSites()->lazy()` and fetches the `deployment_status` field on each site. For sites in a failure state it fetches the latest `deployments()` detail. Rate limiting (429) is handled internally with conservative pacing.

2. **Parse the JSON output.** Each entry in the array has: `site_id`, `site_name`, `server_id`, `status`, optionally `deploy_id`, `deploy_status`, `commit`.

3. **Output the findings block.** Always output to stdout, regardless of outcome. `reflect-scheduled-checks` classifies the result.

   **Failures found:**
   ```
   forge-failed-deploys findings — <YYYY-MM-DD>
   Failed deployments: <N>
   - [deploy-failure] <site_name> (server: <server_id>): status <status><commit line if available>
   ```
   One bullet per failed site.

   **No failures:**
   ```
   forge-failed-deploys findings — <YYYY-MM-DD>
   No actionable findings.
   ```

4. **Do not fetch deployment logs.** This scan surfaces sites with failures; the `forge-logs` or `forge-deploy` skills handle remediation. Fetching logs per failure during the scan would hit rate limits on large estates.

---

## Notes

- **This skill writes no artifact.** All output goes to stdout for `reflect-scheduled-checks`.
- **Registered by `/laravel-forge-hermit:hatch`** step 8 via a `scheduled_checks` config entry (`interval_days: 1`). The core daily `scheduled-checks` routine fires `reflect-scheduled-checks`, which picks it up once 1+ day has elapsed since `last_run`.
- **No channel notifications** — this is analysis-only. Findings surface as `[reliability]` proposals via the normal pipeline.
- **scope**: if `organizationSites()` does not carry `deployment_status` in your Forge plan/API version, the scan will report zero findings (not an error). Scope to `watched_sites` (set at hatch step 6) if org-wide scan is unavailable.
- **Rate limit**: Forge allows ~60 req/min. The scan paces conservatively; if a 429 is returned mid-scan it waits 30 seconds and the scan exits with an error — the check will retry on the next scheduled run.
