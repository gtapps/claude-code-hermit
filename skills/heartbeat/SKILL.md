---
name: heartbeat
description: Executes the heartbeat checklist from HEARTBEAT.md. Reads the checklist, evaluates each item, and reports findings or acknowledges with HEARTBEAT_OK. Supports run/start/stop/status/edit subcommands.
---
# Heartbeat

Background health checker that periodically evaluates a checklist and surfaces anything that needs operator attention. Inspired by OpenClaw's heartbeat pattern.

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

Execute one heartbeat tick immediately. Useful for testing the checklist.

1. Read `.claude-code-hermit/HEARTBEAT.md`
2. If the file is missing or empty (only whitespace, blank lines, or headers with no checklist items):
   - Respond "HEARTBEAT_SKIP" and stop.
3. Read `.claude-code-hermit/config.json` for heartbeat settings
4. Check `active_hours` — if the current time is outside the configured window:
   - Respond "HEARTBEAT_SKIP (outside active hours)" and stop.
5. **Stale session check.** Read `session_state` from `state/runtime.json` (the single source of lifecycle truth — never parse SHELL.md `Status:` for decisions). If `session_state` is `waiting`: skip this check entirely (agent is intentionally blocked). If `session_state` is `in_progress`:
   - Read the last `## Progress Log` entry timestamp from SHELL.md. If no progress entry exists, use the session start time from SHELL.md header.
   - Calculate elapsed time since that timestamp. Read `heartbeat.stale_threshold` from config (default: `"2h"`).
   - If elapsed > stale_threshold: generate alert with key `stale-session` and text "No progress for {elapsed}. Process may have died or be stuck in a rate limit."
6. **Waiting timeout check.** If `session_state` is `waiting` (from runtime.json) and `heartbeat.waiting_timeout` is set (not null):
   - Calculate how long the session has been `waiting` (from last Progress Log entry or status change).
   - If elapsed > `waiting_timeout` with no channel activity: update runtime.json `session_state` to `idle`, update SHELL.md Status to `idle` (cosmetic), notify the operator: "No operator response for {timeout}. Transitioning to idle."
7. **Resume check.** If the previous tick was a HEARTBEAT_SKIP (outside active hours or empty checklist) and this tick is not: append to SHELL.md `## Monitoring`: `[HH:MM] Heartbeat: resumed (was inactive)`.
9. Read `.claude-code-hermit/sessions/SHELL.md` for current task context
10. Evaluate each checklist item against available information (session state, files, proposals directory). For each item that generates an alert, produce a **semantic key** and human-readable **text** (they are not the same thing).
11. Determine: does anything need operator attention?

**Semantic key taxonomy** for built-in checks:
- Stale session: `stale-session`
- Checklist item: `checklist:<first-8-chars-of-item-normalized>`
- Proposal pending: `proposal-pending:<PROP-NNN>`
- Waiting timeout: `waiting-timeout`
- Stale routine queue: `routine-stale:<id>`
- Custom/freeform: `custom:<first-100-chars-normalized>` — fallback only

#### Alert deduplication

Before appending any alert to SHELL.md Monitoring, run this procedure:

1. Read `.claude-code-hermit/state/alert-state.json`. If missing, initialize: `{"alerts": {}, "last_digest_date": null, "self_eval": {}}`.
2. Look up the alert's semantic key in `alerts`:
   - **Not found:** Add entry with `count: 1, consecutive_clean: 0, suppressed: false, first_seen: today, last_seen: today, text: <alert text>`. Append to Monitoring normally.
   - **count < 5:** Increment count, reset `consecutive_clean` to 0, update `last_seen`. Append to Monitoring normally.
   - **count === 5:** Increment count, set `suppressed: true`, reset `consecutive_clean` to 0. Append once: `[HH:MM] Heartbeat: above alert suppressed after 5 fires (first: {first_seen}). Daily digest only.` Notify the operator.
   - **count > 5:** Increment count, reset `consecutive_clean` to 0, update `last_seen`. Do NOT append to Monitoring.
3. **Resolution detection:** After evaluating all checklist items, check for alerts that did NOT fire this tick. For each such entry: increment `consecutive_clean`. If `consecutive_clean >= 2`: resolve the alert and remove entry from state.
   - **Not suppressed:** Append `[HH:MM] Heartbeat: resolved — {text}`. Remove entry.
   - **Suppressed:** Resolve silently — remove entry, omit from next daily digest. Don't add noise announcing the absence of noise.
4. **Daily digest:** First tick of each day where `last_digest_date` is not today: if any suppressed alerts exist, notify the operator: `Suppressed alert digest: {list with counts and ages}`. Set `last_digest_date` to today.
5. **Stale queue check:** Read `.claude-code-hermit/state/routine-queue.json`. For any entry where `queued_since` is older than one heartbeat interval AND current status is `idle` or `waiting`: append to Monitoring: `[HH:MM] Heartbeat: routine '{id}' has been queued since {queued_date} — dispatch may have failed.` Use semantic key `routine-stale:<id>` for dedup.
6. Write `state/alert-state.json`.
7. Call `node ${CLAUDE_PLUGIN_ROOT}/scripts/generate-summary.js .claude-code-hermit/state/`.

**If nothing actionable:**
- Do NOT append to SHELL.md (the tick is already recorded via `total_ticks` in config.json)
- Read config `heartbeat.show_ok`:
  - If `true`: notify the operator with "Heartbeat OK"
  - If `false` (default): no channel message — silent acknowledgment
- Respond "HEARTBEAT_OK"

**If something found:**
- Append findings to SHELL.md `## Monitoring` section with timestamp (subject to alert dedup above)
- Notify the operator with a concise alert (under 5 lines):
  ```
  Heartbeat alert:
  - Step 3 may be unblocked: test environment is now reachable
  - PROP-018 has been open for 3 sessions without review
  ```
- Respond "HEARTBEAT_ALERT"

**Important:** Do NOT implement fixes — only report. The operator or the next session decides what to do. If a finding suggests a reusable improvement, create a proposal via `/claude-code-hermit:proposal-create` — proposals are documentation, not action.

**After evaluating the checklist (always, regardless of findings):**

12. Increment `heartbeat.total_ticks` in `.claude-code-hermit/config.json`
13. Self-eval interval is 20 ticks (constant). If `total_ticks % 20 == 0`: run **self-evaluation** (see below)

### Self-Evaluation

Triggered every 20 ticks. The tick counter persists in `config.json` so it survives session boundaries.

**Steps:**

1. Read `state/alert-state.json`.
2. For each HEARTBEAT.md item: count alert lines referencing that item in the evaluation window (last 20 ticks). If zero alerts → increment `clean_ticks` in `self_eval` entry and update `sessions_seen` / `last_session_id`. If alert fired → reset `clean_ticks` to 0.

   **`sessions_seen` definition:** Number of distinct session IDs (read from SHELL.md `**ID:**` field) during which this item was evaluated. Incremented only when the current session ID differs from `last_session_id`.

   **Self-eval entry schema:**
   ```json
   {
     "text": "Check if CI is passing",
     "clean_ticks": 23,
     "sessions_seen": 4,
     "last_session_id": "S-005",
     "first_observed": "2026-03-28",
     "proposed": false
   }
   ```

2b. **Dismissal cleanup:** Scan `proposals/` for PROP-NNN files where all of the following are true: `source` is `auto-detected`, `status` is `dismissed`, and `self_eval_key` is present and non-null in frontmatter. For each such proposal, look up the matching entry in `self_eval` by `self_eval_key` (not by text). If found and `proposed: true`: reset `proposed: false` and clear `clean_ticks` to 0. This runs on every self-eval pass. Heartbeat owns its own state cleanup — no dependency on reflect or proposal-act timing.

3. **Checklist weight:** Count items in HEARTBEAT.md. If > 10: track in `self_eval` with text `"Checklist weight: {N} items"`.

4. **Proposal threshold check:** For each `self_eval` entry where `proposed: false`:
   - `clean_ticks >= 20` AND `sessions_seen >= 3` → create proposal via `/claude-code-hermit:proposal-create` with category `capability`, `source: auto-detected`, `self_eval_key: <item_key>`, evidence: `"Item '{text}' has been clean for {clean_ticks} consecutive ticks across {sessions_seen} sessions. Consider removing it from HEARTBEAT.md to reduce token cost."`
   - Set `proposed: true`.
   - Checklist weight violation uses same threshold: 20 ticks + 3 sessions with > 10 items.

5. **No channel message. No SHELL.md append.** Output only flows through the proposal pipeline.
6. Write `state/alert-state.json`.

### start

Start a recurring heartbeat loop using `/loop`.

1. Read config for `heartbeat.every` (default: "2h")
2. Invoke `/loop <interval> /claude-code-hermit:heartbeat run`
3. The loop handles scheduling — each cycle invokes `run` which checks active hours and evaluates the checklist

If a heartbeat loop is already running, cancel it first before creating a new one, then start fresh. This is safe to call from a routine — it resets the 3-day `/loop` expiry without losing any state.

### stop

Stop the recurring heartbeat loop.

1. Stop the active `/loop`
2. Append to SHELL.md Monitoring section: `[HH:MM] Heartbeat: stopped`

### status

Report current heartbeat state:
- Is the heartbeat loop running? (yes/no)
- Configured interval (from config)
- Active hours window (from config)
- Last tick time and result (from SHELL.md Monitoring section — find most recent "Heartbeat:" entry)
- Show_ok setting

### edit

Open `.claude-code-hermit/HEARTBEAT.md` for the operator to modify.
- Read the current checklist and display it with item count
- If count > 10: note "Checklist: {count} items (recommended: ≤10). Move periodic items to routines?"
  - If operator agrees: suggest running `/claude-code-hermit:hermit-settings routines` to add the items as routines, then remove them from HEARTBEAT.md
- Ask the operator what to add, remove, or change
- Suggest additions based on current project context (e.g., if there are open proposals, suggest a check for them)
- Write the updated checklist back

## Relationship to /monitor

| | Heartbeat | /monitor |
|---|---|---|
| Triggered by | Boot script (always-on) or session skill (interactive idle) | User-invoked per task |
| Checklist | HEARTBEAT.md (persistent, reusable) | Inline instruction (one-off) |
| Lifecycle | Runs until stop or shutdown | Runs until stop or session close |
| Quiet mode | Yes — suppresses OK by default | No — always logs |
| Active hours | Yes — respects configured window | No — runs whenever invoked |
| Purpose | Background health + proactive surfacing | Specific task monitoring |

Both append findings to SHELL.md. Both notify the operator on actionable findings. They coexist without interference.

## Persistence Across Tasks

The heartbeat loop persists across task boundaries regardless of session mode. When a task completes and the session transitions to `idle`:

- The `/loop` that powers heartbeat keeps running — it is not stopped or restarted
- During `idle` status, heartbeat `run` still executes normally:
  - Reads HEARTBEAT.md and evaluates the checklist
  - SHELL.md still exists (with Status `idle`) so context is available
  - Monitoring entries continue to append to the same SHELL.md
- The heartbeat only dies on:
  1. Explicit `/claude-code-hermit:heartbeat stop`
  2. `hermit-stop.py` shutdown sequence
  3. Claude Code process death (tmux kill, crash, etc.)
  4. `/loop` being stopped manually

No special idle handling is needed in the `run` subcommand — it reads SHELL.md regardless of status.

**Interactive sessions:** Heartbeat is started by the session skill when transitioning to idle (if enabled in config). It runs best-effort — if the terminal closes or Claude Code exits, it dies with it. This is expected. In always-on mode (tmux), the process persists and heartbeat is guaranteed.

---

## Idle Agency

After evaluating the checklist, if SHELL.md status is `idle`:

**NEXT-TASK.md pickup** (active for both `wait` and `discover` idle behavior):

Check for `sessions/NEXT-TASK.md`. If found, respect the configured escalation level:
- **conservative:** notify the operator: "NEXT-TASK.md ready. Want me to start?" Set SHELL.md status to `waiting`.
- **balanced:** start it automatically via `/claude-code-hermit:session-start`
- **autonomous:** start it, notify the operator on completion

**Reflection** (active for both `wait` and `discover` idle behavior):

If no NEXT-TASK.md was picked up and `last_reflection` in `state/reflection-state.json` is null or 4+ hours ago:
- Invoke `/claude-code-hermit:reflect`
- Reflect writes `state/reflection-state.json` itself (heartbeat does not write this file)

**The following only activate when `idle_behavior` is `"discover"` in config:**

If no NEXT-TASK.md and no pending channel messages:

1. **Idle task pickup:** Read `.claude-code-hermit/IDLE-TASKS.md`. If the file exists and has unchecked items (`- [ ]`):
   - Pick the first unchecked item (sequential, top-to-bottom).
   - **Record provenance** before starting the session. Read-modify-write `state/runtime.json` to set:
     ```json
     "idle_task": {
       "text": "<exact checkbox text>",
       "line": <1-based line number>,
       "picked_at": "<ISO 8601>"
     }
     ```
   - Start a session via `/claude-code-hermit:session-start --task '<item text>'` with cost capped at `idle_budget` from config (default: `"$0.50"`).
   - Run with `escalation: conservative` regardless of the global setting — idle tasks should never do anything risky without asking.
   - **Do not mark [x] here.** The checkoff is handled by `session-mgr` during the idle transition, so it stays atomic with the archive.
   - If the idle task creates a proposal, it goes through the normal proposal pipeline — no auto-implementation.
   - Maximum one idle task per heartbeat cycle — don't chain them.

2. **Priority alignment:** Read OPERATOR.md for context. Think about whether current work aligns with the operator's stated priorities and constraints. If deadlines or budgets need attention, cross-reference with `.claude/cost-log.jsonl` and alert.

**All time comparisons use the `timezone` from config.json.**

---

## Morning and Evening Routines

Morning and evening routines are handled by the **routine watcher** (`scripts/routine-watcher.sh`), not by the heartbeat. The watcher is a shell-level clock that reads `config.json` routines every 60 seconds and fires skills at exact scheduled times via tmux.

Default routines (added during init or upgrade):
- **Morning:** `brief --morning` at configured time (e.g., 08:30)
- **Evening:** `brief --evening` at configured time (e.g., 22:30)

Manage routines with `/claude-code-hermit:hermit-settings routines`. See the brief skill for `--morning` and `--evening` flag behavior.
