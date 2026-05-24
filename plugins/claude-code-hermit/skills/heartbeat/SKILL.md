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

## Subcommands

### run

This subcommand is the handler for `HEARTBEAT_EVALUATE` notifications emitted by the heartbeat Monitor. It's also runnable manually for ad-hoc ticks. The Monitor uses `precheck --peek` for polling; this handler re-runs precheck without `--peek` so the mutating tick (`total_ticks` increment, alert-state write) happens exactly once per noteworthy tick.

1. Run the precheck:
   ```
   node ${CLAUDE_PLUGIN_ROOT}/scripts/heartbeat-precheck.js .claude-code-hermit
   ```
2. Read the verdict (first line of output):
   - Starts with `SKIP|` → emit `HEARTBEAT_SKIP (<reason>)`. No channel notification. No SHELL.md write. Stop.
   - `OK` → emit `HEARTBEAT_OK`. Stop.
   - `AUTO_CLOSE` → SHELL.md mtime exceeded 12h. Run the auto-close sequence, then stop:
     1. Append to SHELL.md `## Monitoring`: `[HH:MM] Heartbeat: auto-closed after 12h quiet.` (Step 2 replaces SHELL.md with a fresh template, so a later append would miss the archived report.)
     2. Invoke `/claude-code-hermit:session-close --auto` (skips summary-gathering, reflect, heartbeat-stop; passes `Closed Via: auto` to session-mgr).
     3. Notify the operator per CLAUDE-APPEND.md § Operator Notification: "Auto-closed S-NNN after 12h quiet."
     4. Emit `HEARTBEAT_AUTO_CLOSED`. Stop. Do NOT run the EVALUATE flow — the session is being archived; generating stale-session alerts for a closing session would create phantom dedup entries.
   - `EVALUATE` → continue to step 3.
3. Read `${CLAUDE_PLUGIN_ROOT}/skills/heartbeat/reference.md` for the semantic key taxonomy, alert deduplication procedure, self-evaluation steps, and output format.
4. Read `.claude-code-hermit/HEARTBEAT.md`, `config.json`, `state/runtime.json`, `.claude-code-hermit/sessions/SHELL.md`.
5. **Stale session check.** If `session_state` is `waiting`: skip. If `in_progress`:
   - Read the last `## Progress Log` entry timestamp from SHELL.md. Use session start time if none.
   - If elapsed > `heartbeat.stale_threshold` (default `"2h"`): generate alert with key `stale-session`.
6. **Waiting timeout check.** If `session_state` is `waiting` and `heartbeat.waiting_timeout` is set:
   - If elapsed > `waiting_timeout` with no channel activity: update `runtime.json` `session_state` to `idle`, update SHELL.md Status to `idle`, notify the operator.
7. Evaluate each checklist item against available information. Generate alerts with semantic keys (taxonomy in reference.md).
8. Determine if anything needs operator attention.
9. Apply alert deduplication and write `state/alert-state.json` (procedure in reference.md).
   **Do NOT write `total_ticks` — it was already incremented by the precheck.**
10. If `total_ticks % 20 === 0` (read from updated `state/alert-state.json`): run self-evaluation (procedure in reference.md).

### start

Start the heartbeat as a persistent CC Monitor subprocess.

1. Read `heartbeat.every` from config (default: `"2h"`). Parse to seconds (`"30m"` → 1800, `"2h"` → 7200, etc).
2. Resolve the script path: `${CLAUDE_PLUGIN_ROOT}/scripts/heartbeat-monitor.sh` (resolve at skill execution time — not available inside the subprocess).
3. Sweep any pre-existing CronCreate entry for the old recurring-cron approach: `CronList` → if an entry's `prompt` matches `/claude-code-hermit:heartbeat run`, `CronDelete` it. Idempotent.
4. If a Monitor with description `heartbeat-monitor` exists (TaskList), TaskStop it. Also remove any prior entry from `state/heartbeat-monitor.runtime.json`.
5. Register a new Monitor:
   - `description`: `heartbeat-monitor` (reserved slot — operators must not reuse this description for ad-hoc `/watch` entries)
   - `command`: `bash <abs_script_path> <interval_seconds> $PWD/.claude-code-hermit`
   - `timeout_ms`: 86400000  (24h; re-armed daily by `heartbeat-restart`)
   - `persistent`: true
6. Write the new entry (description, task_id, command, interval, started_at) to `state/heartbeat-monitor.runtime.json`. Do NOT use `state/monitors.runtime.json` — that file is owned exclusively by /watch and is cleared on every session start.
7. Append to SHELL.md Monitoring: `[HH:MM] Heartbeat: monitor started (interval: <every>)`.

Safe to call from a routine — idempotent (legacy cron swept + existing Monitor stopped + state file rewritten).

### stop

1. Read `state/heartbeat-monitor.runtime.json`. If a `task_id` is present, TaskStop it. Fallback: TaskList → find by description `heartbeat-monitor` and TaskStop.
2. Clear `state/heartbeat-monitor.runtime.json` (write `{}`).
3. Sweep legacy CronCreate: `CronList` → `CronDelete` any entry whose `prompt` matches `/claude-code-hermit:heartbeat run`. Belt-and-suspenders.
4. Append to SHELL.md Monitoring: `[HH:MM] Heartbeat: stopped`.

### status

Report current heartbeat state by reading:
- `state/heartbeat-monitor.runtime.json` — running yes/no, registered interval, task_id, started_at
- `CronList` filtered for `/claude-code-hermit:heartbeat run` — should be empty post-migration; if present, surface as "legacy CronCreate still active — run /heartbeat start to clean up"
- `state/alert-state.json` for `total_ticks` and last-tick metadata
- `config.json` for active hours window

Report: monitor running (yes/no), configured interval, active hours window, total ticks since last clear, legacy-cron warning if applicable.

### edit

Open `.claude-code-hermit/HEARTBEAT.md` for the operator to modify.
- Display current checklist with item count.
- If count > 10: note "Checklist: {count} items (recommended: ≤10). Move periodic items to routines?"
- Ask what to add, remove, or change. Suggest additions based on project context.
- Write updated checklist back.

If the operator asks about idle tasks: read/write `.claude-code-hermit/IDLE-TASKS.md` instead. Warn if `idle_behavior` is `"wait"` (tasks won't be picked up automatically).

## Idle Agency

After evaluating the checklist, if SHELL.md status is `idle`:

**NEXT-TASK.md pickup** (both `wait` and `discover`): check `sessions/NEXT-TASK.md`. If found, act per `escalation` in config:
- `conservative`: notify operator, set SHELL.md to `waiting`, set `waiting_reason: "conservative_pickup"` in runtime.json.
- `balanced`: log the invocation, then start:
  ```
  bash ${CLAUDE_PLUGIN_ROOT}/scripts/log-invocation-event.sh skill-invoke /claude-code-hermit:session-start idle
  ```
  Then invoke `/claude-code-hermit:session-start`.
- `autonomous`: log the invocation (same command as balanced), start, notify on completion.

**The following only when `idle_behavior: "discover"`:**

- **Idle task pickup:** read `.claude-code-hermit/IDLE-TASKS.md`. Pick first unchecked item. Record provenance in `runtime.json` `idle_task` (`text`, `line`, `picked_at`). Log the invocation:
  ```
  bash ${CLAUDE_PLUGIN_ROOT}/scripts/log-invocation-event.sh skill-invoke /claude-code-hermit:session-start idle
  ```
  Then start via `/claude-code-hermit:session-start --task '<text>'`, cost-capped at `idle_budget`. Run at `escalation: conservative`. Maximum one task per tick.
- **Priority alignment:** check OPERATOR.md + `.claude/cost-log.jsonl`. Alert if deadlines or budgets need attention.

All time comparisons use `timezone` from config.json.

---

Morning/evening routines are handled by `/claude-code-hermit:hermit-routines`. Manage routines with `/claude-code-hermit:hermit-settings routines`.
