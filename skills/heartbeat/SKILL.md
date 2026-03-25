---
name: heartbeat
description: Executes the heartbeat checklist from HEARTBEAT.md. Reads the checklist, evaluates each item, and reports findings or acknowledges with HEARTBEAT_OK. Supports run/start/stop/status/edit subcommands.
disable-model-invocation: true
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

1. Read `.claude/.claude-code-hermit/HEARTBEAT.md`
2. If the file is missing or empty (only whitespace, blank lines, or headers with no checklist items): respond "HEARTBEAT_SKIP" and stop. This costs zero evaluation tokens.
3. Read `.claude/.claude-code-hermit/config.json` for heartbeat settings
4. Check `active_hours` — if the current time is outside the configured window: respond "HEARTBEAT_SKIP (outside active hours)" and stop
5. Read `.claude/.claude-code-hermit/sessions/SHELL.md` for current task context
6. Evaluate each checklist item against available information (session state, files, proposals directory)
7. Determine: does anything need operator attention?

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

8. Increment `heartbeat.total_ticks` in `.claude/.claude-code-hermit/config.json`
9. Read `heartbeat.self_eval_interval` from config (default: 20). If `self_eval_interval` is 0: skip self-evaluation.
10. If `total_ticks % self_eval_interval == 0` and `self_eval_interval > 0`: run **self-evaluation** (see below)

### Self-Evaluation

Triggered every N ticks (configured by `heartbeat.self_eval_interval`, default 20). The tick counter persists in `config.json` so it survives session boundaries.

**Steps:**

1. Read recent heartbeat entries from SHELL.md `## Monitoring` section — collect all `[HH:MM] Heartbeat:` lines in the current session
2. For each checklist item in HEARTBEAT.md: check how many recent ticks flagged it vs how many were OK
3. **Stale check detection:** If a specific checklist item was OK for all ticks in the evaluation window, suggest to the operator:
   > "Heartbeat self-check: the item '[check description]' has been OK for [N] consecutive ticks. Consider removing it to save tokens, or reducing heartbeat frequency."
4. **Missing check suggestion:** Scan `.claude/.claude-code-hermit/proposals/` for recent auto-detected proposals about recurring issues. If a proposal describes a problem that could be caught by a heartbeat check, suggest:
   > "PROP-NNN identified a recurring [issue]. Consider adding a [relevant check] to HEARTBEAT.md."
5. Append self-evaluation findings to SHELL.md `## Monitoring` with timestamp:
   ```
   [HH:MM] Heartbeat self-eval: [summary of suggestions]
   ```
6. If channels are configured: send self-eval findings as a notification
7. Do NOT auto-modify HEARTBEAT.md — suggest only. The operator decides what to check. Offer to make the edit if the operator agrees.
8. After the operator acts on a suggestion (adds or removes a check): reset `heartbeat.total_ticks` to 0 in config.json

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

Open `.claude/.claude-code-hermit/HEARTBEAT.md` for the operator to modify.
- Read the current checklist and display it
- Ask the operator what to add, remove, or change
- Suggest additions based on current project context (e.g., if there are open proposals, suggest a check for them)
- Write the updated checklist back

## Relationship to /monitor

| | Heartbeat | /monitor |
|---|---|---|
| Triggered by | Always-on loop via boot script | User-invoked per task |
| Checklist | HEARTBEAT.md (persistent, reusable) | Inline instruction (one-off) |
| Lifecycle | Runs until stop or shutdown | Runs until stop or session close |
| Quiet mode | Yes — suppresses OK by default | No — always logs |
| Active hours | Yes — respects configured window | No — runs whenever invoked |
| Purpose | Background health + proactive surfacing | Specific task monitoring |

Both append findings to SHELL.md. Both send alerts via channels. They coexist without interference.

## Always-On Persistence

The heartbeat loop persists across task boundaries. When a task completes and the session transitions to `idle`:

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

### NEXT-TASK.md auto-pickup

During idle state, the heartbeat checklist can include a check for `sessions/NEXT-TASK.md`. If found (e.g., from a proposal accepted via channel on another device), the heartbeat should alert: "NEXT-TASK.md detected — starting task automatically." Then invoke `/claude-code-hermit:session-start` to transition idle → active.

This makes the proposal → task pipeline fully automated for always-on agents. The operator accepts a proposal (via `/proposal-act`), which creates NEXT-TASK.md, and the next heartbeat tick picks it up.
