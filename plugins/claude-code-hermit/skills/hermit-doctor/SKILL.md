---
name: hermit-doctor
description: Returns a fifteen-check health report on the hermit installation — runtime (bun presence/version), config validity, hook registration, state file integrity, cost visibility, proposal health, sibling dependency ranges, file permissions, docker-security overlay drift, archival health, reflect loop health, scheduler/background-task health, watchdog health, heartbeat liveness, sandbox capability. Use when diagnosing an install, before a release, or after suspicious behavior. Activates on messages like "/hermit-doctor", "health check", "diagnose the hermit", "what's wrong", "run diagnostic".
---

# Hermit Doctor

Runs fifteen read-only health checks against the current hermit install and surfaces the
summary. Safe to run at any time. Produces no side effects beyond writing
`.claude-code-hermit/state/doctor-report.json` and appending a summary block to SHELL.md.

## Steps

1. Run the check script:
   ```bash
   bun ${CLAUDE_PLUGIN_ROOT}/scripts/doctor-check.ts .claude-code-hermit
   ```
   The script writes `.claude-code-hermit/state/doctor-report.json` and prints the same
   JSON to stdout. It exits 0 unconditionally — on any internal failure the failing
   check reports `status: "fail"` in its own entry rather than crashing the report.

2. Parse the JSON. For each of the fourteen checks in the report (`runtime`, `config`, `hooks`, `state`, `cost`,
   `proposals`, `dependencies`, `permissions`, `docker-security`, `archive`, `reflect`, `scheduler`, `watchdog`, `heartbeat`), emit one line using this format:
   - `✓ <id> — <detail>` when `status: ok`
   - `⚠ <id> — <detail>` when `status: warn`
   - `✗ <id> — <detail>` when `status: fail`

2.5. **Sandbox capability check** (fifteenth check, run after step 2):

   Architectural note: this check is computed by the skill orchestrator, not by `doctor-check.ts`. `state/doctor-report.json` therefore contains only the fourteen checks emitted in step 2; the sandbox line is appended to the rendered summary and to SHELL.md but is not present in the JSON report. Tools that consume `doctor-report.json` programmatically should call `scripts/sandbox-probe.ts` separately if they need the sandbox status.

   Determine the sandbox enabled state: read `.claude/settings.json` and `.claude/settings.local.json`; the last file that explicitly declares `sandbox.enabled` wins (Claude Code's merge order). Treat non-bool values as undeclared.

   - If sandbox is **not enabled** (no declaration, or last declaration is `false`): emit `✓ sandbox — disabled (not configured)`. Do not run the probe.
   - **If running inside a container** (`/.dockerenv` or `/run/.containerenv` exists): emit `✓ sandbox — enabled, in container (enableWeakerNestedSandbox auto-managed by hermit-start)`. Do not run the probe — `unshare --user --pid true` fails unconditionally in unprivileged containers, producing a spurious WARN. Hermit-start writes `enableWeakerNestedSandbox: true` to settings.local.json for this case, which sidesteps the kernel restriction.
   - Otherwise, run:
     ```bash
     bun ${CLAUDE_PLUGIN_ROOT}/scripts/sandbox-probe.ts
     ```
     Branch on `status`:
     - `pass`: emit `✓ sandbox — enabled, deps OK.`
     - `warn`: emit `⚠ sandbox — enabled but: <message>`.
     - `fail`: emit `✗ sandbox — enabled but: <message>. Fix: <install_hint>`.

   Add this as the fifteenth line to the summary.

3. Append a summary section to `.claude-code-hermit/sessions/SHELL.md` under a new
   `## Doctor Report (<ts>)` heading. Use the same fifteen lines from steps 2 and 2.5. Place it
   above the `## Monitoring` section so it sits with session-level context, not
   with monitoring chatter.

4. Return the fifteen lines to the caller. Cap total output at 30 lines.

## Silence policy

- If every check is `ok`, return only: `All fifteen checks passed.` Do not notify via
  channel (Tier 0). Still append to SHELL.md so the run is traceable.
- If any check is `warn` or `fail`, return the full fifteen-line summary. Channel
  notification follows the usual § Operator Notification policy in CLAUDE.md —
  `fail` warrants a proactive ping; `warn` alone does not unless the operator asked.

## What each check looks at

| id | What it verifies | Status rules |
|---|---|---|
| `runtime` | Runs `bun --version` and compares against `required_bun_version` in the plugin's `hermit-meta.json`. | `fail` if bun is absent or below the required version; `ok` with the detected version otherwise. |
| `config` | Runs `validate-config.ts` against `.claude-code-hermit/config.json`. | `fail` on any error; `warn` on any warning. |
| `hooks` | Parses `hooks/hooks.json`; verifies each referenced script file exists on disk. | `fail` if any script is missing. |
| `state` | `JSON.parse` every `.claude-code-hermit/state/*.json`; warns if expected files missing. | `fail` on unparseable file; `warn` if any expected file (`alert-state.json`, `reflection-state.json`, `runtime.json`, `monitors.runtime.json`) is absent. |
| `cost` | Sums today's `estimated_cost_usd` and `total_tokens` from `.claude/cost-log.jsonl`; reports today's spend, token count, and cache-read tokens for efficiency diagnosis. | `ok` with today's spend + tokens; `warn` if cost-log absent. |
| `proposals` | Counts `proposals/PROP-*.md` with `status: open`; ages via `created:` frontmatter. | `warn` if any open PROP > 30 days, or if more than 10 open. |
| `dependencies` | Reads `required_core_version` from each sibling plugin's `plugin.json` and verifies the installed core version satisfies the range. Sibling plugins live next to core under `plugins/<name>/` (monorepo) or in the marketplace cache (legacy). | `warn` if any sibling declares a `required_core_version` that the running core version doesn't satisfy. Unrecognized range forms (e.g. `^`, `~`, `||`) are treated as ok. |
| `permissions` | `fs.statSync(p).mode & 0o777` on `config.json`, `state/*.json`, and `proposals/`. | `warn` if any world-readable (`mode & 0o004 ≠ 0`). |
| `docker-security` | Cross-references `docker.security.*` in `config.json` against the presence of `docker-compose.security.yml` at the project root. Two-state presence check; no YAML parsing. | `warn` if posture is declared but overlay missing (re-run `/docker-security`), or if overlay is present but no posture is declared (likely a manual edit). `ok` when both match or neither is configured. |
| `archive` | Reads `state/runtime.json`. Detects sessions that should have been archived but weren't. | `warn` if `session_state ∈ {in_progress, waiting}` with `updated_at` >2 days old (stale active session) or `session_state: idle` with non-null `session_id` >2 days old (orphaned). `ok` when runtime missing (covered by `state` check) or all timestamps fresh. |
| `reflect` | Reads `state/reflection-state.json` counters. Flags an unproductive reflect loop. | `warn` if `total_runs ≥ 10` AND `empty_runs / total_runs > 0.80` AND `proposals_created == 0`. `ok` below 10 runs (insufficient sample) or when the loop produces output. |
| `scheduler` | Reads `state/cc-stop-snapshot.json` (written by stop-pipeline.ts at each Stop). Reports armed cron count, background-task count, and snapshot age. | `ok` if snapshot present with counts and `captured_at`; `ok` (not yet captured) if snapshot absent (first run post-upgrade); `warn` if `session_crons` or `background_tasks` state is `unsupported_or_unreachable` (old CC build or registry unreachable — never reported as "0 crons"). |
| `watchdog` | Reads `config.watchdog`, `state/watchdog-state.json`, and `state/watchdog-events.jsonl`; summarizes restarts/nudges/re-arms over the last 7 days. | `ok` when disabled or quiet; `warn` if any restart in the last 7 days or a stale cycle is in progress. |
| `heartbeat` | Reads `config.heartbeat`, `state/runtime.json`, `state/heartbeat-liveness.json`, and `state/heartbeat-monitor.runtime.json`. Verifies the monitor loop is actually running by checking the liveness timestamp written on every poll iteration. | `ok` when disabled, no active session, liveness is fresh, or monitor is within startup grace period; `fail` when liveness is stale or absent beyond 3× the configured interval (Monitor subprocess spawn blocked). |
| `sandbox` | Runs `scripts/sandbox-probe.ts` and cross-references with `sandbox.enabled` in settings files. | `fail` if sandbox enabled and deps (bwrap/socat) missing; `warn` if deps present but user-namespaces disabled; `ok` if disabled or fully operational. |

No automatic fixes. Doctor reports; the operator acts.

## Notes

- The check logic lives in `scripts/doctor-check.ts` so it can be unit-tested without
  invoking the model.
- Re-runs are cheap. No locking needed.
- Doctor does not ping external APIs (Discord, Telegram, Anthropic). Everything is
  local filesystem reads.
