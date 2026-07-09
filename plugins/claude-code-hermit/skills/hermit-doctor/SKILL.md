---
name: hermit-doctor
description: Returns a twenty-two-check health report on the hermit installation (runtime, config, hooks, state-file integrity, cost, proposals, deps, version currency, permissions, docker/sandbox, archival, reflect loop, scheduler, watchdog, context age, opus-wake spend, heartbeat, raw storage size, credential expiry, model pricing, channel liveness). Use when diagnosing an install, before a release, or after suspicious behavior. Activates on messages like "/hermit-doctor", "health check", "diagnose the hermit", "what's wrong", "run diagnostic".
---

# Hermit Doctor

Runs twenty-one read-only health checks against the current hermit install (`channel-liveness`
is the only one that performs outbound API calls — see Notes) and surfaces the summary. Safe
to run at any time. Produces no side effects beyond writing
`.claude-code-hermit/state/doctor-report.json` and appending a summary block to SHELL.md.

## Steps

1. Run the check script:
   ```bash
   bun ${CLAUDE_PLUGIN_ROOT}/scripts/doctor-check.ts .claude-code-hermit
   ```
   The script writes `.claude-code-hermit/state/doctor-report.json` and prints the same
   JSON to stdout. It exits 0 unconditionally — on any internal failure the failing
   check reports `status: "fail"` in its own entry rather than crashing the report.

2. Parse the JSON. For each of the twenty-one checks in the report (`runtime`, `config`, `hooks`, `state`, `cost`,
   `proposals`, `dependencies`, `version-currency`, `permissions`, `docker-security`, `archive`, `reflect`, `scheduler`, `watchdog`,
   `context-age`, `opus-wake`, `heartbeat`, `raw-size`, `credential-expiry`, `model-pricing-known`, `channel-liveness`), emit one line using this format:
   - `✓ <id> — <detail>` when `status: ok`
   - `⚠ <id> — <detail>` when `status: warn`
   - `✗ <id> — <detail>` when `status: fail`

2.5. **Sandbox capability check** (twenty-second check, run after step 2):

   Architectural note: this check is computed by the skill orchestrator, not by `doctor-check.ts`. `state/doctor-report.json` therefore contains only the twenty-one checks emitted in step 2; the sandbox line is appended to the rendered summary and to SHELL.md but is not present in the JSON report. Tools that consume `doctor-report.json` programmatically should call `scripts/sandbox-probe.ts` separately if they need the sandbox status.

   Determine the sandbox enabled state: read `.claude/settings.json` and `.claude/settings.local.json`; the last file that explicitly declares `sandbox.enabled` wins (Claude Code's merge order). Treat non-bool values as undeclared.

   - **If running inside a container** (`/.dockerenv` or `/run/.containerenv` exists): do not run the probe (`unshare --user --pid true` fails unconditionally in unprivileged containers, producing a spurious WARN). Branch on the enabled state read above:
     - enabled `true`: emit `⚠ sandbox — enabled inside container; recommended off. The container is the isolation boundary; on Ubuntu 24.04+ hosts bwrap can't start in-container and heartbeat/watch monitors fail. Run /claude-code-hermit:hermit-evolve or set sandbox.enabled:false.`
     - otherwise: emit `✓ sandbox — off in container (the container is the isolation boundary)`.
   - If sandbox is **not enabled** (no declaration, or last declaration is `false`): emit `✓ sandbox — disabled (not configured)`. Do not run the probe.
   - Otherwise, run:
     ```bash
     bun ${CLAUDE_PLUGIN_ROOT}/scripts/sandbox-probe.ts
     ```
     Branch on `status`:
     - `pass`: emit `✓ sandbox — enabled, deps OK.`
     - `warn`: emit `⚠ sandbox — enabled but: <message>`.
     - `fail`: emit `✗ sandbox — enabled but: <message>. Fix: <install_hint>`.

   Add this as the twenty-second line to the summary.

3. Append a summary section to `.claude-code-hermit/sessions/SHELL.md` under a new
   `## Doctor Report (<ts>)` heading. Use the same twenty-two lines from steps 2 and 2.5. Place it
   above the `## Monitoring` section so it sits with session-level context, not
   with monitoring chatter.

4. Return the twenty-two lines to the caller. Cap total output at 30 lines.

5. **Escalation & dedup.** Build the failing set: every JSON check from step 2 with
   `status: warn|fail`, plus the step-2.5 sandbox line when it rendered ⚠/✗ (id `sandbox`).

   Read `.claude-code-hermit/state/alert-state.json` `alerts{}` and compute:
   - `new_entries`: for each failing check whose `doctor:<id>` key is absent from `alerts{}` —
     `{"doctor:<id>": {"first_seen": "<ISO now>", "status": "<warn|fail>", "detail": "<check detail>"}}`.
   - `resolved_keys`: every existing `doctor:*` key in `alerts{}` whose check is now `ok` or no
     longer present in the failing set.

   Do not touch heartbeat-owned fields (`self_eval_updates`, `last_clean_eval_at`). If either
   `new_entries` or `resolved_keys` is non-empty, persist via the same stdin API heartbeat uses:
   ```bash
   bun ${CLAUDE_PLUGIN_ROOT}/scripts/update-alert-state.ts .claude-code-hermit/state/alert-state.json <<'HERMIT_ALERT_JSON'
   {"new_entries": {...}, "updated_entries": {}, "resolved_keys": [...]}
   HERMIT_ALERT_JSON
   ```

   **Channel message — only when `new_entries` is non-empty.** Send one message covering all
   newly-failing checks, in plain language with a named next action, no PROP-/S-NNN vocabulary,
   no raw check ids. Example: "I can't reach Telegram — the bot token was rejected. Regenerate
   it with @BotFather, then run /channel-setup." A check already alerted (its `doctor:<id>` key
   still present) stays silent on subsequent runs until it resolves — resolving just deletes the
   key, there is no "recovered" ping in v1.

## Silence policy

- If every check is `ok`, return only: `All twenty-two checks passed.` Do not notify via
  channel (Tier 0). Still resolve any stale `doctor:*` alert-state keys (step 5) and still
  append to SHELL.md so the run is traceable.
- If any check is `warn` or `fail`, return the full twenty-two-line summary. Channel notification
  is governed by step 5's escalation-and-dedup logic, not a blanket per-run ping: only newly
  appearing findings message the channel, and only once until they resolve.

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
| `version-currency` | Compares this install's `.claude-plugin/plugin.json` version against the same plugin's entry in the local marketplace-cache `marketplace.json` (the file `claude plugin marketplace update` refreshes — there is no automatic background refresh, so the cache is only as current as the last explicit update). Silent no-op in a monorepo/dev checkout (no marketplace cache to compare against). | `warn` if the marketplace cache lists a newer version than installed, naming both versions and the cache's mtime — wording escalates ("includes Fixed entries") if any CHANGELOG section in the gap has a `### Fixed` heading; remediation is `/plugin marketplace update` → `/plugin update` → `/claude-code-hermit:hermit-evolve`. `ok` when current, when the cache has no comparable entry, or when there's no cache to compare against. |
| `permissions` | `fs.statSync(p).mode & 0o777` on `config.json`, `state/*.json`, and `proposals/`. | `warn` if any world-readable (`mode & 0o004 ≠ 0`). |
| `docker-security` | Cross-references `docker.security.*` in `config.json` against the presence of `docker-compose.security.yml` at the project root. Two-state presence check; no YAML parsing. | `warn` if posture is declared but overlay missing (re-run `/docker-security`), or if overlay is present but no posture is declared (likely a manual edit). `ok` when both match or neither is configured. |
| `archive` | Reads `state/runtime.json`. Detects sessions that should have been archived but weren't. | `warn` if `session_state ∈ {in_progress, waiting}` with `updated_at` >2 days old (stale active session) or `session_state: idle` with non-null `session_id` >2 days old (orphaned). `ok` when runtime missing (covered by `state` check) or all timestamps fresh. |
| `reflect` | Reads `state/reflection-state.json` counters. Flags an unproductive reflect loop. | `warn` if `total_runs ≥ 10` AND `empty_runs / total_runs > 0.80` AND `proposals_created == 0`. `ok` below 10 runs (insufficient sample) or when the loop produces output. |
| `scheduler` | Reads `state/cc-stop-snapshot.json` (written by stop-pipeline.ts at each Stop). Reports armed cron count, background-task count, and snapshot age. | `ok` if snapshot present with counts and `captured_at`; `ok` (not yet captured) if snapshot absent (first run post-upgrade); `warn` if `session_crons` or `background_tasks` state is `unsupported_or_unreachable` (old CC build or registry unreachable — never reported as "0 crons"). |
| `watchdog` | Reads `config.watchdog`, `config.post_close_clear`, `config.context_hygiene.compact.enabled`, `state/watchdog-state.json` (`last_run` liveness + `consecutive_stale` + `last_hygiene_eval`), `state/runtime.json` (`runtime_mode`, `session_state`, shutdown stamps), and `state/watchdog-events.jsonl`. Steps 0a-0c (post-close clear, emergency clear, routine-hygiene compact) run independent of `watchdog.enabled`, so the check treats any of those as "active" even when the restart tier is off. First checks for a shutdown stamp on a still-alive session (bricks both hygiene and restart recovery until the next `hermit-start`), then liveness: the watchdog stamps `last_run` on every invocation before any gate, so a fresh stamp proves the scheduler/loop is firing. If stale (>20m) or missing, summarizes restarts/nudges/re-arms/clears/compacts over the last 7 days plus the most recent hygiene skip/fire reason otherwise. | `ok` when nothing is active (restart tier off and no hygiene feature on), or firing and quiet (appends "last tick Nm ago", or "restart tier disabled, hygiene tier active" when only hygiene runs); `warn` if a stamp is stuck on an alive session, if `last_run` is stale/missing — "enabled but not firing" with remediation keyed to `runtime_mode` (`tmux` → `bin/hermit-watchdog install`; `docker` → recreate the container; unknown → both hints) — or, when firing, if any restart in the last 7 days or a stale cycle is in progress. |
| `context-age` | Reads `config.context_hygiene.compact` (threshold), `state/runtime.json` (active session + session id, with the idle-phase fallback to `sessions/.status.json` used by the hygiene tiers), the active session's last cost-log entry (`max_prompt_tokens` — the real per-call context-size peak), and `state/watchdog-events.jsonl` for the most recent `context-compact`/`context-clear`/`post-close-clear` event. A symptom tripwire for the whole context-hygiene-disabled failure class, not a specific root cause. | `warn` if the active session's context exceeds `min_context_tokens` and no hygiene event fired in the last 24h; `ok` if the compact tier is off, no active session, context is under threshold, the latest turn lacks a real context-size metric (multi-call, pre-`max_prompt_tokens`), or hygiene fired recently. |
| `opus-wake` | Scans `.claude/cost-log.jsonl` for the last 7 days for automated (heartbeat/routine) turns billed on Opus. | `warn` if any found — names the count and cost, since automated wakes are the usual source of tier-drift spend; `ok` otherwise. |
| `heartbeat` | Reads `config.heartbeat`, `state/runtime.json`, `state/heartbeat-liveness.json`, and `state/heartbeat-monitor.runtime.json`. Verifies the monitor loop is actually running by checking the liveness timestamp written on every poll iteration. A tick older than the monitor's `started_at` is ignored (leftover from a prior session). | `ok` when disabled, no active session, the trusted tick is fresh, or the monitor is within a short startup grace (~2m); `fail` when a trusted tick is older than 3× the configured interval, or no trusted tick exists past the startup grace (Monitor subprocess spawn blocked). |
| `raw-size` | Sums file sizes in `raw/` (plus `raw/.archive/`) and checks `runtime.json.last_raw_archive_at`. | `warn` if `raw/` exceeds 50 MB, or if raw files exist and the archive routine hasn't run in >14 days (or never); `ok` otherwise. |
| `credential-expiry` | Reads `claudeAiOauth.expiresAt` from `$CLAUDE_CONFIG_DIR/.credentials.json` (fallback `~/.claude/.credentials.json`). | `ok` if the file is absent (API-key/keychain auth), the field is unrecognized, or expiry is >2h away; `warn` if expired (the ~8h re-login trap) or expiring within 2h, or if the file is unreadable. |
| `model-pricing-known` | Compares `config.model`, each `routines[].model`, and `config.heartbeat.model` against the pricing table (`scripts/lib/pricing.ts`); also scans `.claude/cost-log.jsonl` for the last 7 days (inert today — cost-log model strings are pre-collapsed to `haiku\|sonnet\|opus` before logging, so this only activates once raw model ids persist). | `warn` naming every unpriced model and where it's configured — cost tracking silently falls back to sonnet pricing for unknowns; `ok` if every configured model is known. |
| `channel-liveness` | For each enabled channel in `config.channels`, resolves its bot token from `<state_dir>/.env` and makes one token-authed liveness call (Telegram `getMe`, Discord `/users/@me`) with a 5s timeout. The only check that leaves the machine. | `ok` if reachable or no channels configured; `warn` if unreachable (timeout/network error) or no token configured; `fail` if the platform rejects the token (401/403 — bot token invalid or revoked). |
| `sandbox` | Runs `scripts/sandbox-probe.ts` and cross-references with `sandbox.enabled` in settings files. | `fail` if sandbox enabled and deps (bwrap/socat) missing; `warn` if deps present but user-namespaces disabled; `ok` if disabled or fully operational. |

No automatic fixes. Doctor reports; the operator acts.

## Notes

- The check logic lives in `scripts/doctor-check.ts` so it can be unit-tested without
  invoking the model.
- Re-runs are cheap. No locking needed.
- `channel-liveness` is the only check that leaves the machine: one token-authed liveness
  call per already-configured, enabled channel, 5s timeout, fail-soft. Disabling a channel
  disables its probe — there is no per-check opt-out in v1. Every other check is a local
  filesystem read.
