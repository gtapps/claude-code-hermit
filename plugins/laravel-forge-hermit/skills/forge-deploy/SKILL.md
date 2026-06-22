---
name: forge-deploy
description: Deploy a site on Laravel Forge. Always surface-then-approve (preview-deploy first, then deploy --confirm on explicit approval). Watches via the hermit /watch registry and writes a deploy-incident on failure. Triggers on "deploy", "trigger deployment", "deploy site", "run deployment", "check deployment status".
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

### Step 3 — On approval only: fire the deployment

```bash
php ${CLAUDE_PLUGIN_ROOT}/php/forge.php deploy <server> <site> --confirm
```

This triggers the deployment and returns immediately (no blocking wait):

```
Deployment started: deploy-id=991 server-id=12345 site-id=67890 status=queued
Watch with: forge.php deploy-status 12345 67890 991
```

Capture the canonical `deploy-id`, `server-id`, and `site-id` — Step 4 needs them.

### Step 4 — Watch via the hermit watch registry (non-blocking)

Do **not** poll in a foreground Bash call: a real deploy can outlast the Bash tool timeout, which would kill the wait and skip the incident. Arm a hermit watch instead — it runs detached, notifies you on each status change and on the terminal state at zero token cost while quiet, and is tracked in `monitors.runtime.json` (visible via `/claude-code-hermit:watch status`, cancellable via `/claude-code-hermit:watch stop`, and cleaned up at session-close).

**Requires an active hermit session** — `/claude-code-hermit:watch` refuses without one. If there is no session, ask the operator to run `/claude-code-hermit:session` first (or, as a fallback, run `deploy-status` manually).

Resolve `${CLAUDE_PLUGIN_ROOT}` to its **absolute path now** (at skill-execution time): the variable is NOT available inside the watch subprocess. Then arm the watch by invoking `/claude-code-hermit:watch` with this command (substitute the absolute path and the three IDs):

```bash
prev=""; n=0
while [ "$n" -lt 180 ]; do
  st=$(php /ABS/php/forge.php deploy-status <server-id> <site-id> <deploy-id> 2>/dev/null || true)
  [ -n "$st" ] && [ "$st" != "$prev" ] && echo "deploy <deploy-id>: $st"
  case "$st" in
    finished) echo "TERMINAL deploy=<deploy-id> server-id=<server-id> site-id=<site-id> status=finished"; exit 0;;
    failed|failed-build|cancelled) echo "TERMINAL deploy=<deploy-id> server-id=<server-id> site-id=<site-id> status=$st"; exit 0;;
  esac
  prev="$st"; n=$((n+1)); sleep 5
done
echo "TERMINAL deploy=<deploy-id> server-id=<server-id> site-id=<site-id> status=timeout"
```

The `TERMINAL` line carries only numeric IDs (never display names) — Forge server names can contain spaces, which would break the space-delimited fields.

`/claude-code-hermit:watch` registers this as an ad-hoc watch (`persistent: true`, so the tool's own timeout is ignored). The loop therefore self-caps after ~15 min (180 × 5 s) and emits a `timeout` terminal line — it never becomes an unbounded watch. It is otherwise quiet, emitting only on status change. On any `TERMINAL` line the command exits and core clears the registry entry automatically; that line carries everything Step 5 needs.

### Step 5 — On the terminal watch event

When the `TERMINAL …` notification arrives:

- **`status=finished`** → tell the operator the deploy succeeded, via the **Operator Notification protocol in CLAUDE.md** (core resolves the channel; falls back to a push). No artifact.
- **`status=failed` / `failed-build` / `cancelled`** → (1) fetch the log with `deploy-log <server-id> <site-id> <deploy-id>` using the numeric IDs from the `TERMINAL` line, **scrub it**, and write a `deploy-incident` artifact (template below); (2) notify the operator of the failure via the **Operator Notification protocol in CLAUDE.md**, including the incident path.
- **`status=timeout`** → the watch hit its ~15 min cap without reaching a terminal state. Notify the operator (via the **Operator Notification protocol in CLAUDE.md**) that the deploy is still unresolved and point them at `deploy-history` / `deploy-status` to follow up. No incident — a timeout is not a confirmed failure.

Scrubbing happens here, in this step — never in the watch command. The watcher only emits metadata, so no raw log line is ever written by the unattended subprocess.

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

## deploy-incident artifact (written in Step 5 on a failed terminal status)

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
