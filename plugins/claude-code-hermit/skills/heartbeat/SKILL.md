---
name: heartbeat
description: Executes the heartbeat checklist from HEARTBEAT.md. Reads the checklist, evaluates each item, and reports findings or acknowledges with HEARTBEAT_OK. Supports run/start/stop/status/edit subcommands.
---
# Heartbeat

Background health checker that periodically evaluates a checklist and surfaces anything that needs operator attention.

## Usage

```
/claude-code-hermit:heartbeat run      — execute one tick immediately
/claude-code-hermit:heartbeat start    — start the recurring tick
/claude-code-hermit:heartbeat stop     — stop the recurring tick
/claude-code-hermit:heartbeat status   — show last result and schedule state
/claude-code-hermit:heartbeat edit     — modify the checklist
```

## Step 0 — Channel reply

If this skill was invoked from a channel-arrived message (the inbound prompt contains a `<channel source="...">` tag), reply via that channel's reply tool. Otherwise emit to conversation. The only interactive ask here is the `edit` subcommand's free-form "what to add, remove, or change" — on a channel-tagged turn deliver it via the reply tool as an ordinary over-channel exchange (it's open-ended, so no micro-proposal entry is queued). **Never call `AskUserQuestion` on a channel-tagged turn** — it renders in the terminal, invisible to a remote operator.

## Subcommands

### run

This subcommand is the handler for `HEARTBEAT_EVALUATE` notifications emitted by the heartbeat Monitor. It's also runnable manually for ad-hoc ticks. The Monitor uses `precheck --peek` for polling; this handler re-runs precheck without `--peek` so the mutating tick (`total_ticks` increment, alert-state write) happens exactly once per noteworthy tick.

1. Run the precheck:
   ```
   bun ${CLAUDE_PLUGIN_ROOT}/scripts/heartbeat-precheck.ts .claude-code-hermit
   ```
2. Read the verdict (first line of output):
   - Starts with `SKIP|` → emit `HEARTBEAT_SKIP (<reason>)`. No channel notification. No SHELL.md write. Stop.
   - `OK` → emit `HEARTBEAT_OK`. Stop.
   - `AUTO_CLOSE` → operator inactivity exceeded the threshold (12h of no operator action, or 10-min lull after a `daily-auto-close` queued at midnight). Run the auto-close sequence, then stop:
     1. Append to SHELL.md `## Monitoring`: `[HH:MM] Heartbeat: auto-closed.` (Step 2 replaces SHELL.md with a fresh template, so a later append would miss the archived report.)
     2. Invoke `/claude-code-hermit:session-close --auto` (skips summary-gathering, reflect, heartbeat-stop; passes `Closed Via: auto` to session-mgr; clears `state/pending-close.json` after archive succeeds).
     3. Notify the operator per CLAUDE-APPEND.md § Operator Notification: "Auto-closed S-NNN."
     4. Emit `HEARTBEAT_AUTO_CLOSED`. Stop. Do NOT run the EVALUATE flow — the session is being archived; generating stale-session alerts for a closing session would create phantom dedup entries.
   - `EVALUATE` → continue to step 3.
3. **Waiting-timeout check** (main session, pre-dispatch). Read `state/runtime.json`. If `session_state === 'waiting'` and `heartbeat.waiting_timeout` is set (not null) in config: compute elapsed since `waiting_since` in runtime.json. If `waiting_since` is absent, skip the timeout check. If elapsed > `waiting_timeout`: write `runtime.json` `session_state: idle`, clear `waiting_reason`, notify the operator (`Waiting timeout reached after {waiting_timeout} — session returning to idle.`). Continue to step 4.
4. **Read `heartbeat.model` from `.claude-code-hermit/config.json`** (default `"haiku"` when the key is absent). **Dispatch via the Agent tool** (`subagent_type: "claude-code-hermit:skill-eval-runner"`) to run the report-only evaluation. Pass the `model` param per the resolved value: a concrete string (`"haiku"`/`"sonnet"`/`"opus"`) → `model: "<that value>"`; explicit `null` → **omit the `model` param entirely** so the subagent inherits the session model. This runs the evaluation in a fresh ~40k context instead of the main session's 200k–500k inherited context — the eval reads only files and needs none of that history. Instructions for the subagent:
   > Read `${CLAUDE_PLUGIN_ROOT}/skills/heartbeat/reference.md` for the complete evaluation instructions. Execute the evaluation steps in that file against `.claude-code-hermit/` in the current project directory, using the file paths described there. Return a JSON object (no prose): `{"resolved_keys": [...], "new_entries": {...}, "updated_entries": {...}, "last_clean_eval_at": "<ISO or null>", "self_eval_updates": {...}, "shell_monitoring_lines": [...], "operator_message": "<string or null>", "heartbeat_result": "OK"|"ALERT"}`. Do NOT write any files or send any notifications — the calling session handles all writes and notifications. Follow the reference.md write instructions to populate the return value instead.

   Receive the structured JSON back from the subagent.
5. **Apply writes** in the main session (to preserve cost attribution and channel/file access). First, validate the subagent return: if it cannot be parsed as JSON, or is missing any required **key** (`resolved_keys`, `new_entries`, `updated_entries`, `last_clean_eval_at`, `self_eval_updates`, `shell_monitoring_lines`, `operator_message`, `heartbeat_result`), **skip all writes and emit `HEARTBEAT_OK`** — fail-open, never corrupt persistent state. A present key with a `null` value is valid, not missing (`last_clean_eval_at` and `operator_message` are legitimately `null`). Tradeoff: a malformed return during a genuine alert condition is swallowed for this tick; the next tick re-evaluates. Never corrupting `alert-state.json` is the deliberate priority. Otherwise:
   - Write `state/alert-state.json` via the dedicated script (do NOT write `total_ticks` — owned by the precheck). Pass the subagent return on **stdin** via a quoted heredoc so free-text alert / `self_eval` values (which may contain apostrophes) can't break the command:
     ```
     bun ${CLAUDE_PLUGIN_ROOT}/scripts/update-alert-state.ts .claude-code-hermit/state/alert-state.json <<'HERMIT_ALERT_JSON'
     <subagent-return-json>
     HERMIT_ALERT_JSON
     ```
     The script merges `new_entries` and `updated_entries` into `alerts{}`, applies `resolved_keys` deletions, sets `last_clean_eval_at`, and overlays `self_eval_updates` into `self_eval{}`.
   - If `shell_monitoring_lines` is non-empty: append each line to SHELL.md `## Monitoring`.
   - If `operator_message` is non-null: notify the operator (per CLAUDE-APPEND.md § Operator Notification).
   - For each entry in `self_eval_updates` with a `proposal_args` field: invoke `/claude-code-hermit:proposal-create` with those args.
6. Respond with `HEARTBEAT_OK` or `HEARTBEAT_ALERT` per `heartbeat_result`.

### start

Start the heartbeat as a persistent CC Monitor subprocess.

1. Read `heartbeat.every` from config (default: `"2h"`). Parse to seconds (`"30m"` → 1800, `"2h"` → 7200, etc).
2. Resolve the script path: `${CLAUDE_PLUGIN_ROOT}/scripts/heartbeat-monitor.sh` (resolve at skill execution time — not available inside the subprocess).
3. Sweep any pre-existing CronCreate entry for the old recurring-cron approach: `CronList` → if an entry's `prompt` matches `/claude-code-hermit:heartbeat run`, `CronDelete` it. Idempotent.
4. Read `state/heartbeat-monitor.runtime.json` if it exists. If it contains a `task_id`, TaskStop that task — ignore not-found errors (the monitor may have already exited). Then TaskList → TaskStop any remaining task with description `heartbeat-monitor` (fallback for orphans where the runtime file was never written). Clear any prior entry from `state/heartbeat-monitor.runtime.json`. Delete `state/heartbeat-liveness.json` if it exists — this clears the previous monitor's liveness record so the doctor check does not flag stale data from the prior session during the new monitor's startup window.
5. Register a new Monitor:
   - `description`: `heartbeat-monitor` (reserved slot — operators must not reuse this description for ad-hoc `/watch` entries)
   - `command`: `bash <abs_script_path> <interval_seconds> $PWD/.claude-code-hermit`
   - `timeout_ms`: 86400000  (24h; re-armed daily by `heartbeat-restart`)
   - `persistent`: true
6. Write the new entry (description, task_id, command, interval, started_at) to `state/heartbeat-monitor.runtime.json`. Do NOT use `state/monitors.runtime.json` — that file is owned exclusively by /watch and is cleared on every session start.
7. Append to SHELL.md Monitoring: `[HH:MM] Heartbeat: monitor registered (interval: <every>) — liveness confirmed by /hermit-doctor heartbeat check`.

Safe to call from a routine — idempotent (legacy cron swept + existing Monitor stopped + state file rewritten).

The monitor's poll interval is fixed at registration from `heartbeat.every`. The `/hermit-doctor` heartbeat check derives its staleness threshold from the current `config.heartbeat.every`, so editing `every` without re-running `start` leaves the live monitor on the old cadence while the doctor judges it against the new one. Re-run `start` after changing `every` to resync.

### stop

1. Read `state/heartbeat-monitor.runtime.json`. If a `task_id` is present, TaskStop it. Fallback: TaskList → find by description `heartbeat-monitor` and TaskStop.
2. Clear `state/heartbeat-monitor.runtime.json` (write `{}`).
3. Sweep legacy CronCreate: `CronList` → `CronDelete` any entry whose `prompt` matches `/claude-code-hermit:heartbeat run`. Belt-and-suspenders.
4. Append to SHELL.md Monitoring: `[HH:MM] Heartbeat: stopped`.

### status

Report current heartbeat state by reading:
- `state/heartbeat-monitor.runtime.json` — running yes/no, registered interval, task_id, started_at
- `CronList` filtered for `/claude-code-hermit:heartbeat run` — should be empty post-migration; if present, surface as "legacy CronCreate still active — run /heartbeat start to clean up"
- `state/alert-state.json` for `total_ticks`
- `state/heartbeat-liveness.json` for `last_peek_at` (proof-of-life timestamp written by the monitor loop every interval)
- `config.json` for active hours window

Report: monitor running (yes/no), configured interval, active hours window, total ticks since last clear, last-peek-at timestamp (or "never ticked" if liveness file absent), legacy-cron warning if applicable.

### edit

Open `.claude-code-hermit/HEARTBEAT.md` for the operator to modify.
- Display current checklist with item count.
- If count > 10: note "Checklist: {count} items (recommended: ≤10). Move periodic items to routines?"
- Ask what to add, remove, or change. Suggest additions based on project context.
- Write updated checklist back.

## Idle Agency

After evaluating the checklist, if `runtime.json` `session_state` is `idle`:

**NEXT-TASK.md pickup** (both `wait` and `discover`): check `sessions/NEXT-TASK.md`. If found, act per `escalation` in config:
- `conservative`: notify operator, set SHELL.md to `waiting`, set `waiting_reason: "conservative_pickup"` in runtime.json.
- `balanced`: start via `/claude-code-hermit:session-start`.
- `autonomous`: start via `/claude-code-hermit:session-start`. On completion, run the `session` skill's Work-done flow (§6) — never send a bare notification without it: a notified-but-`in_progress` session triggers stale-session alerts and delays archival.

**The following only when `idle_behavior: "discover"`:**

- **Priority alignment:** check OPERATOR.md + `.claude/cost-log.jsonl`. Alert if deadlines need attention.

All time comparisons use `timezone` from config.json.

---

Morning/evening routines are handled by `/claude-code-hermit:hermit-routines`. Manage routines with `/claude-code-hermit:hermit-settings routines`.
