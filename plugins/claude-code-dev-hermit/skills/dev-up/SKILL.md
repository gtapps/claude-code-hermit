---
name: dev-up
description: Boot a session-scoped dev server via the core Monitor tool. Reads commands.dev_start, dev_required_ports, dev_health_url, dev_auth_check, and dev_expected_listeners from .claude-code-hermit/config.json. Run before browser-testing or any task that exercises the running app.
---

# /dev-up

Boot the project's dev server in a Monitor-managed subprocess so its stdout/stderr stream into the conversation as notifications. **The dev server is session-scoped**: it stops on `/session-close` and on the next session-start (per `claude-code-hermit:watch` SKILL.md:149-152). For a long-lived server, run it in your own tmux/systemd/foreman and treat the agent as a client.

Operator-invoked. Not auto-triggered. If you want it to fire on browser-testing tasks, add a project memory rule (`Whenever I start a browser-testing task, invoke /dev-up first`).

## Prerequisites

- Verify `.claude-code-hermit/sessions/` exists. If not: tell the operator to run `/claude-code-hermit:hatch` and `/claude-code-dev-hermit:hatch`, then exit.
- Read `.claude-code-hermit/config.json` once at start. Cache `claude-code-dev-hermit.commands.dev_start`, `commands.dev_stop`, `dev_required_ports`, `dev_expected_listeners`, `dev_health_url`, `dev_health_timeout_secs`, `dev_auth_check`, and `dev_log_path_pattern` for use across gates.

## Plan

### Gate 0 — `commands.dev_start` configured

If `commands.dev_start` is null or empty:

```
commands.dev_start not configured — run /claude-code-dev-hermit:dev-adapt
```

FAIL.

### Gate 1 — idempotency

**Idempotency is within-session only.** The runtime registry clears at session-start, so the first `/dev-up` of a fresh session always boots even if a previous session left a dev-server running externally.

Read `.claude-code-hermit/state/monitors.runtime.json`. If an entry with `id: "dev-server"` exists:

1. **Liveness check first** — Monitor self-exit notifications usually sweep the registry, but there's a race window where the process died and the notification hasn't been processed yet. If the registry entry has a `pid`, run `kill -0 <pid> 2>/dev/null`; if the pid does not exist, treat the entry as stale: remove it from the registry, log to SHELL.md `## Monitoring` `- [STALE-CLEARED] dev-server`, and continue to Gate 2 as if no entry existed. (If the entry has no pid recorded, fall through to step 2 — we cannot verify, must trust.)

2. **Health probe** — if `dev_health_url` is set: probe it once via `node ${CLAUDE_PLUGIN_ROOT}/scripts/lib/health-poll.js "$dev_health_url" 5`. If 2xx, return PASS-with-noop:

   ```
   dev-up
     monitor:  dev-server already registered (pid <pid> alive)
     health:   200 OK at <url>
     status:   already up
   ```

3. **No health probe configured** — if `dev_health_url` is unset and the liveness check passed, return PASS-with-noop with the explicit caveat:

   ```
   dev-up
     monitor:  dev-server already registered (pid <pid> alive)
     status:   already up (no health probe — process exists, application readiness not verified)
   ```

4. **Health probe failed but pid is alive** — registry has the entry, process is up, but the URL is not 2xx. Surface and stop:

   ```
   dev-server is registered (pid <pid> alive) but health probe failed at <url>: <error>
   recovery: /dev-down then /dev-up, OR investigate the existing process
   ```

If no entry exists (or the stale-clear branch ran): continue to Gate 2.

### Gate 2 — auth probe (optional)

If `dev_auth_check` is set, run it via `bash -c "$dev_auth_check"`. If exit code is non-zero:

```
auth probe failed: <stderr tail>
the dev server may also fail to authenticate; fix before booting
```

FAIL.

> Note: a passing auth probe is a positive signal, not a guarantee. The probe and the spawned dev-server inherit env from the same shell, but if your secret loader (Infisical, op, direnv) caches per-process tokens or shells, the probe and server may diverge. Treat a green auth probe as "necessary, not sufficient."

### Gate 3 — ports free or allowlisted

If `dev_required_ports` is empty: skip with `PASS  ports: not configured`.

Otherwise, probe via the helper:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/port-check.js" "$(jq -nc --argjson ports "$ports_json" --argjson exp "$expected_json" '{ports:$ports,expected:$exp}')"
```

(or compose the JSON inline; the helper accepts a single JSON-string arg.)

The helper returns one record per port: `free` / `allowed` (matched an `dev_expected_listeners[].process_match`) / `held` (occupied by an unexpected process).

- **`free` or `allowed`** → record for the report.
- **`held`** → FAIL:

  ```
  port <port> held by <process> (pid <pid>) — dev server cannot bind
    if this listener is expected (e.g., a daemon that coexists with the dev server),
    add to claude-code-dev-hermit.dev_expected_listeners:
      { "port": <port>, "process_match": "<process>" }
    via /dev-adapt or by editing config.json directly
  ```

### Gate 4 — required tools available

If `dev_required_ports` is non-empty: at least one of `lsof` or `ss` must be in PATH. The helper detects automatically; if it returns `error: "no probing tool available"`, FAIL with `install lsof or iproute2`.

If `dev_health_url` is set: `curl` must be in PATH (or skip Gate 6 — the health-poll helper uses Node's `http`/`https` modules, so `curl` is not strictly required; this gate is informational only). Helper-only path: no extra dependency.

### Gate 5 — register the Monitor entry

The dev server's stdout/stderr stream as conversation notifications via the Monitor tool. We do NOT wrap with grep — the dev server's natural output flows through. Error-pattern filtering against log files is the job of `/dev-log-watch`, which runs as a separate Monitor entry.

We need a stable id `dev-server` so `/dev-down` can find this entry. The `/watch` skill's ad-hoc form auto-generates `adhoc-<epoch>-...` ids (see `claude-code-hermit:watch` SKILL.md "Starting an ad-hoc watch"), so we invoke the Monitor tool directly and append the registry entry ourselves with the chosen id — same recipe as `/watch`'s ad-hoc steps 5–8, but with our id.

Steps:

1. Invoke the Monitor tool with all four required params:
   - `description`: `"dev-server: <commands.dev_start>"` (shown in every notification)
   - `command`: `commands.dev_start` verbatim
   - `timeout_ms`: 300000 (required by tool schema; ignored when persistent)
   - `persistent`: true
2. Read `.claude-code-hermit/state/monitors.runtime.json` (create if missing per the watch skill's contract).
3. Append:
   ```json
   {
     "id": "dev-server",
     "task_id": "<returned by Monitor>",
     "description": "dev-server: <commands.dev_start>",
     "started_at": "<ISO 8601>",
     "source": "adhoc",
     "class": "stream"
   }
   ```
4. Write the registry back.
5. Append to SHELL.md `## Monitoring`: `- [ACTIVE] dev-server (started HH:MM)`.

If the Monitor invocation errors, FAIL and surface the error. Do not partially append to the registry.

### Gate 6 — health probe (optional)

If `dev_health_url` is unset: skip with `PASS  health: not configured`.

Otherwise, run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/health-poll.js" "$dev_health_url" "${dev_health_timeout_secs:-30}"
```

Helper returns JSON `{ ok, status, elapsedMs, error? }` and exits 0 on 2xx, 1 on timeout.

- 2xx within timeout → record `200 OK after Ns`.
- Timeout / non-2xx → FAIL:

  ```
  health probe failed at <url> after <elapsedMs>ms: <error>
    the dev server may still be coming up; tail recent notifications for errors
    or run /dev-down to stop the partially-booted process
  ```

## Output

```
dev-up
  start:    npm run dev (commands.dev_start)
  ports:    3000 free, 4000 held by encore (allowed via dev_expected_listeners)
  monitor:  dev-server registered (session-scoped)
  health:   200 OK at http://localhost:3000/api/health (after 4123ms)
  status:   up
```

On Gate 1 short-circuit:

```
dev-up
  monitor:  dev-server already registered
  health:   200 OK at <url>
  status:   already up
```

On any FAIL: emit the gate name, the failure reason, and the recovery hint. No partial-success reports.

## Rules

- **Session-scoped.** Document this in CLAUDE-APPEND.md and don't promise otherwise to operators.
- **Operator-invoked only.** Do not auto-fire from session-start, browser-task triggers, or implementer flows.
- **Helper modules are the single source of truth** for resolve/port/health logic. SKILL prose describes intent; node helpers implement parsing and probing. Bug fixes go in the helpers, not duplicated in the prose.
- **Never SIGKILL anything from `/dev-up`.** Stale processes from a prior session were already killed by session-close (per `watch` SKILL.md:149); if Gate 1 sees a registry entry that's stale (process gone), the Monitor's own self-exit notification removes it. Do not race with that.
- **Idempotency is within-session.** Surface this in the SKILL output when relevant.
