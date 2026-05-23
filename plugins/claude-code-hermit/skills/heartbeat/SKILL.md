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

Execute one heartbeat tick.

1. Run the precheck:
   ```
   node ${CLAUDE_PLUGIN_ROOT}/scripts/heartbeat-precheck.js .claude-code-hermit
   ```
2. Read the verdict (first line of output):
   - Starts with `SKIP|` → emit `HEARTBEAT_SKIP (<reason>)`. No channel notification. No SHELL.md write. Stop.
   - `OK` → emit `HEARTBEAT_OK`. If `heartbeat.show_ok` is `true` in config, notify the operator. Stop.
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
7. **Resume check.** If the previous tick was a SKIP and this tick is not: append to SHELL.md `## Monitoring`: `[HH:MM] Heartbeat: resumed (was inactive)`.
8. Evaluate each checklist item against available information. Generate alerts with semantic keys (taxonomy in reference.md).
9. Determine if anything needs operator attention.
10. Apply alert deduplication and write `state/alert-state.json` (procedure in reference.md).
    **Do NOT write `total_ticks` — it was already incremented by the precheck.**
11. If `total_ticks % 20 === 0` (read from updated `state/alert-state.json`): run self-evaluation (procedure in reference.md).

### start

Start a recurring heartbeat tick using `CronCreate`.

1. Read `heartbeat.every` from config (default: `"2h"`).
2. Convert the interval to a 5-field cron expression using an off-minute (never `:00`, never `:30`) so a fleet of hermits doesn't cluster on the same wall-clock moment:
   - `30m` → `7,37 * * * *`
   - `Nh` (N≥1) → `7 */N * * *` (e.g. `1h` → `7 * * * *`, `2h` → `7 */2 * * *`)
   - `Nd` → `7 4 */N * *`
   - Any other `Nm` value: use `*/N * * * *` and proceed — `CronCreate` accepts non-clean steps without error.
3. Call `CronList` and delete any existing task whose prompt is `/claude-code-hermit:heartbeat run` (via `CronDelete`). Idempotent: safe to re-run from `heartbeat-restart` to reset the 7-day expiry.
4. Call `CronCreate` with `cron` set to the expression from step 2, `prompt` set to `/claude-code-hermit:heartbeat run`, and `recurring: true`.
5. Append to SHELL.md Monitoring: `[HH:MM] Heartbeat: started (every <interval>, cron <expr>, task <id>)`.

We use `CronCreate` directly rather than `/loop` because Claude Code 2.1.150 added an operator-facing "Cloud schedule vs This session only" prompt inside `/loop` that blocks the always-on bootstrap. `CronCreate` is the same local in-session scheduler `/loop` wraps — same runtime semantics, no prompt.

### stop

1. Call `CronList`. Delete every task whose prompt is `/claude-code-hermit:heartbeat run` via `CronDelete`.
2. Append to SHELL.md Monitoring: `[HH:MM] Heartbeat: stopped`.

### status

Report current heartbeat state:
- Call `CronList` and find the task whose prompt is `/claude-code-hermit:heartbeat run`. Report: running (yes/no), cron expression, task ID, configured interval, active hours window, last tick time and result, show_ok setting.

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
- `balanced`: start via `/claude-code-hermit:session-start`.
- `autonomous`: start, notify on completion.

**The following only when `idle_behavior: "discover"`:**

- **Idle task pickup:** read `.claude-code-hermit/IDLE-TASKS.md`. Pick first unchecked item. Record provenance in `runtime.json` `idle_task` (`text`, `line`, `picked_at`). Start via `/claude-code-hermit:session-start --task '<text>'`, cost-capped at `idle_budget`. Run at `escalation: conservative`. Maximum one task per tick.
- **Priority alignment:** check OPERATOR.md + `.claude/cost-log.jsonl`. Alert if deadlines or budgets need attention.

All time comparisons use `timezone` from config.json.

---

Morning/evening routines are handled by `/claude-code-hermit:hermit-routines`. Manage routines with `/claude-code-hermit:hermit-settings routines`.
