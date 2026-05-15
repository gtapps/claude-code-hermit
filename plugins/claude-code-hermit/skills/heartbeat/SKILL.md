---
name: heartbeat
description: Executes the heartbeat checklist from HEARTBEAT.md. Reads the checklist, evaluates each item, and reports findings or acknowledges with HEARTBEAT_OK. Supports run/start/stop/status/edit subcommands.
---
# Heartbeat

Background health checker that periodically evaluates a checklist and surfaces anything that needs operator attention.

## Usage

```
/claude-code-hermit:heartbeat run      — execute one tick immediately
/claude-code-hermit:heartbeat start    — start the recurring loop
/claude-code-hermit:heartbeat stop     — stop the recurring loop
/claude-code-hermit:heartbeat status   — show last result and loop state
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
   - `EVALUATE` → continue to step 3.
3. Read `${CLAUDE_PLUGIN_ROOT}/skills/heartbeat/reference.md` for the semantic key taxonomy, alert deduplication procedure, self-evaluation steps, and output format.
4. Read `.claude-code-hermit/HEARTBEAT.md`, `config.json`, `state/runtime.json`, `.claude-code-hermit/sessions/SHELL.md`.
5. **Stale focus check.** If `session_state` is `waiting`: skip (operator answer is pending; stale-focus signal would be noise). If `in_progress`:
   - Read the last `## Progress Log` entry timestamp from SHELL.md. Use focus start time (from runtime.json `created_at`) if Progress Log is empty.
   - If elapsed > `heartbeat.stale_threshold` (default `"2h"`): generate alert with key `stale-focus`.
6. **Resume check.** If the previous tick was a SKIP and this tick is not: append to SHELL.md `## Monitoring`: `[HH:MM] Heartbeat: resumed (was inactive)`.
7. Evaluate each checklist item against available information. Generate alerts with semantic keys (taxonomy in reference.md).
8. Determine if anything needs operator attention.
9. Apply alert deduplication and write `state/alert-state.json` (procedure in reference.md).
    **Do NOT write `total_ticks` — it was already incremented by the precheck.**
10. If `total_ticks % 20 === 0` (read from updated `state/alert-state.json`): run self-evaluation (procedure in reference.md).

### start

Start a recurring heartbeat loop using `/loop`.

1. Read `heartbeat.every` from config (default: `"2h"`).
2. Invoke `/loop <interval> /claude-code-hermit:heartbeat run`.

If a heartbeat loop is already running, cancel it first then start fresh. Safe to call from a routine — resets the 3-day `/loop` expiry without losing any state.

### stop

1. Stop the active `/loop`.
2. Append to SHELL.md Monitoring: `[HH:MM] Heartbeat: stopped`.

### status

Report current heartbeat state:
- Loop running (yes/no), configured interval, active hours window, last tick time and result, show_ok setting.

### edit

Open `.claude-code-hermit/HEARTBEAT.md` for the operator to modify.
- Display current checklist with item count.
- If count > 10: note "Checklist: {count} items (recommended: ≤10). Move periodic items to routines?"
- Ask what to add, remove, or change. Suggest additions based on project context.
- Write updated checklist back.

If the operator asks about idle tasks: read/write `.claude-code-hermit/IDLE-TASKS.md` instead. Warn if `idle_behavior` is `"wait"` (tasks won't be picked up automatically).

## Idle Agency

After evaluating the checklist, if `session_state == idle` AND SHELL.md `## Focus` is empty/placeholder:

**NEXT-TASK.md pickup** (both `wait` and `discover`): check `sessions/NEXT-TASK.md`. If found, act per `escalation` in config:
- `conservative`: notify operator, set `session_state` to `waiting` (the operator's reply provides the answer).
- `balanced`: start via `/claude-code-hermit:steer '<text>'`.
- `autonomous`: start, notify on completion.

**The following only when `idle_behavior: "discover"`:**

- **Idle task pickup:** read `.claude-code-hermit/IDLE-TASKS.md`. Pick first unchecked item. Record provenance in `runtime.json` `idle_task` (`text`, `line`, `picked_at`). Start via `/claude-code-hermit:steer '<text>'`, cost-capped at `idle_budget`. Run at `escalation: conservative`. Maximum one task per tick.
- **Priority alignment:** check OPERATOR.md + `.claude/cost-log.jsonl`. Alert if deadlines or budgets need attention.

All time comparisons use `timezone` from config.json.

---

Morning/evening routines are handled by `/claude-code-hermit:hermit-routines`. Manage routines with `/claude-code-hermit:hermit-settings routines`.
