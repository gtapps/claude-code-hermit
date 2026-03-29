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

**Skip tracking procedure** (referenced by steps 2 and 4): Read `.claude-code-hermit/.heartbeat-skips`. If it exists and the reason matches, increment the count and update the last_skip_time. Otherwise write `reason:count:first_time-last_time` (e.g., `outside_active_hours:1:08:00-08:00`). This file is read on resume (step 6) to produce a summary line.

1. Read `.claude-code-hermit/HEARTBEAT.md`
2. If the file is missing or empty (only whitespace, blank lines, or headers with no checklist items):
   - Track the skip (reason: `empty_checklist`) using the skip tracking procedure above.
   - Respond "HEARTBEAT_SKIP" and stop.
3. Read `.claude-code-hermit/config.json` for heartbeat settings
4. Check `active_hours` — if the current time is outside the configured window:
   - Track the skip (reason: `outside_active_hours`) using the skip tracking procedure above.
   - Respond "HEARTBEAT_SKIP (outside active hours)" and stop.
5. **Stale session check.** Read SHELL.md Status field. If Status is `in_progress`:
   - Read the last `## Progress Log` entry timestamp. If no progress entry exists, use the session start time from SHELL.md header.
   - Calculate elapsed time since that timestamp. Read `heartbeat.stale_threshold` from config (default: `"2h"`).
   - If elapsed > stale_threshold: alert "Session appears stale — no progress logged for {elapsed}. Process may have died or be stuck in a rate limit."
   - Append to SHELL.md `## Monitoring`: `[HH:MM] Heartbeat: STALE WARNING — no progress for {elapsed}`
   - Send to channel if configured.
   - Do NOT take action — operator decides whether to restart.
6. **Skip receipt resume check.** If `.claude-code-hermit/.heartbeat-skips` exists:
   - Read the file (format: `reason:count:first_time-last_time`).
   - Append to SHELL.md `## Monitoring`: `[HH:MM] Heartbeat: resumed after {count} skips ({first_time}–{last_time}, {reason})`
   - Delete `.heartbeat-skips`.
7. **Maintain .status file.** Read SHELL.md Status. If it differs from the current `.claude-code-hermit/.status` content, write the new value. Valid values: `idle`, `in_progress`. (The `shutdown` value is written by `hermit-stop.py` only.)
8. Read `.claude-code-hermit/sessions/SHELL.md` for current task context
9. Evaluate each checklist item against available information (session state, files, proposals directory)
10. Determine: does anything need operator attention?

**If nothing actionable:**
- Append to SHELL.md `## Monitoring` section: `[HH:MM] Heartbeat: OK`
- Read config `heartbeat.show_ok`:
  - If `true` AND channels are configured: send "Heartbeat OK" to channel
  - If `false` (default): no channel message — silent acknowledgment
- Respond "HEARTBEAT_OK"

**If something found:**
- Append findings to SHELL.md `## Monitoring` section with timestamp
- If channels are configured: send a concise alert (under 5 lines, channel-friendly):
  ```
  Heartbeat alert:
  - Step 3 may be unblocked: test environment is now reachable
  - PROP-018 has been open for 3 sessions without review
  ```
- Respond with the alert content

**Important:** Do NOT take action on findings — only report. The operator or the next session decides what to do.

**After evaluating the checklist (always, regardless of findings):**

11. Increment `heartbeat.total_ticks` in `.claude-code-hermit/config.json`
12. Read `heartbeat.self_eval_interval` from config (default: 20). If `self_eval_interval` is 0: skip self-evaluation.
13. If `total_ticks % self_eval_interval == 0` and `self_eval_interval > 0`: run **self-evaluation** (see below)

### Self-Evaluation

Triggered every N ticks (configured by `heartbeat.self_eval_interval`, default 20). The tick counter persists in `config.json` so it survives session boundaries.

**Steps:**

1. Read recent heartbeat entries from SHELL.md `## Monitoring` section — collect all `[HH:MM] Heartbeat:` lines in the current session
2. For each checklist item in HEARTBEAT.md: check how many recent ticks flagged it vs how many were OK
3. **Stale check detection:** If a specific checklist item was OK for all ticks in the evaluation window, suggest to the operator:
   > "Heartbeat self-check: the item '[check description]' has been OK for [N] consecutive ticks. Consider removing it to save tokens, or reducing heartbeat frequency."
4. **Checklist weight check:** Count items in HEARTBEAT.md. If count > 10, suggest:
   > "HEARTBEAT.md has {count} items (recommended: ≤10). Consider moving periodic checks to routines (`/hermit-settings routines`) to reduce per-tick token cost. Items that only need daily/weekly checking are good routine candidates."
5. **Missing check suggestion:** Scan `.claude-code-hermit/proposals/` for recent auto-detected proposals about recurring issues. If a proposal describes a problem that could be caught by a heartbeat check, suggest:
   > "PROP-NNN identified a recurring [issue]. Consider adding a [relevant check] to HEARTBEAT.md."
6. Append self-evaluation findings to SHELL.md `## Monitoring` with timestamp:
   ```
   [HH:MM] Heartbeat self-eval: [summary of suggestions]
   ```
7. If channels are configured: send self-eval findings as a notification
8. Do NOT auto-modify HEARTBEAT.md — suggest only. The operator decides what to check. Offer to make the edit if the operator agrees.
9. After the operator acts on a suggestion (adds or removes a check): reset `heartbeat.total_ticks` to 0 in config.json

### start

Start a recurring heartbeat loop using `/loop`.

1. Read config for `heartbeat.every` (default: "30m")
2. Invoke `/loop <interval> /claude-code-hermit:heartbeat run`
3. The loop handles scheduling — each cycle invokes `run` which checks active hours and evaluates the checklist

If a heartbeat loop is already running, report that and do nothing.

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

Both append findings to SHELL.md. Both send alerts via channels. They coexist without interference.

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
- **conservative:** alert — "NEXT-TASK.md ready. Want me to start?"
- **balanced:** start it automatically via `/claude-code-hermit:session-start`
- **autonomous:** start it, notify on completion

**The following only activate when `idle_behavior` is `"discover"` in config:**

If no NEXT-TASK.md and no pending channel messages:

1. **When Idle pickup:** Read OPERATOR.md `## When Idle` section. If the section exists and has items:
   - Read SHELL.md Session Summary for `[idle] Completed:` entries. Skip already-completed items.
   - Pick the first uncompleted item from the list (sequential, top-to-bottom).
   - Start a session via `/claude-code-hermit:session-start --task '<item text>'` with cost capped at `idle_budget` from config (default: `"$0.50"`).
   - Run with `escalation: conservative` regardless of the global setting — idle tasks should never do anything risky without asking.
   - If the idle task creates a proposal, it goes through the normal proposal pipeline — no auto-implementation.
   - Maximum one idle task per heartbeat cycle — don't chain them.
   - Track completed idle tasks in SHELL.md Session Summary as: `[idle] Completed: <item> — <outcome> (cost: $X.XX)`

2. **Reflection:** If no idle task was started and `_last_reflection` is null or 4+ hours ago:
   - Invoke `/claude-code-hermit:reflect`
   - Update `heartbeat._last_reflection` to now (ISO string with timezone offset from config)

3. **Priority alignment:** Read OPERATOR.md. Think about whether current work aligns with the stated priorities and constraints. If deadlines or budgets need attention, cross-reference with `.claude/cost-log.jsonl` and alert.

**All time comparisons use the `timezone` from config.json.**

---

## Morning and Evening Routines

Morning and evening routines are handled by the **routine watcher** (`scripts/routine-watcher.sh`), not by the heartbeat. The watcher is a shell-level clock that reads `config.json` routines every 60 seconds and fires skills at exact scheduled times via tmux.

Default routines (added during init or upgrade):
- **Morning:** `brief --morning` at configured time (e.g., 08:30)
- **Evening:** `brief --evening` at configured time (e.g., 22:30)

Manage routines with `/claude-code-hermit:hermit-settings routines`. See the brief skill for `--morning` and `--evening` flag behavior.
