---
name: monitor
description: Session-aware monitoring loop. Wraps /loop with SHELL.md bookkeeping. Use to set up recurring checks during a session.
---
# Monitor

Set up a session-aware monitoring loop that periodically checks something and logs findings to SHELL.md.

## Usage

Start monitoring:
```
/claude-code-hermit:monitor check if the deploy succeeded — every 5m
/claude-code-hermit:monitor watch error rate in logs — every 2m
/claude-code-hermit:monitor check sensor readings — every 15m
```

Stop monitoring:
```
/claude-code-hermit:monitor stop
```

## Plan

### Starting a monitor

1. Parse the monitoring instruction and interval from the operator's message
   - Default interval: 5 minutes if not specified
   - The instruction is free-form text describing what to check
2. Verify an active session exists (`.claude-code-hermit/sessions/SHELL.md` must exist)
   - If no active session: "No active session. Run `/claude-code-hermit:session` first."
3. Add a monitoring entry to the `## Monitoring` section in SHELL.md:
   ```
   - [ACTIVE] <instruction> (every <interval>, started HH:MM)
   ```
4. Invoke `/loop <interval> <instruction>` with additional context:
   - "After each check, append findings with timestamp to `.claude-code-hermit/sessions/SHELL.md` under the Progress Log section, prefixed with `[monitor]`."
   - "If something critical is found and a channel is active, send a notification."

### Stopping a monitor

1. Read the `## Monitoring` section in SHELL.md
2. Update the entry status from `[ACTIVE]` to `[STOPPED]`
3. Terminate the `/loop`

## Notes

- Multiple monitors can run simultaneously — each gets its own entry in the Monitoring section
- On idle transition (`/session-close` in always-on mode): active monitors continue running — same `/loop` mechanism as heartbeat, they persist within the process lifetime
- On full shutdown (`/session-close --shutdown` or `hermit-stop`): all active monitors should be stopped and marked `[STOPPED]` in the Monitoring section
- Monitor findings appear in `/claude-code-hermit:pulse` output via the Progress Log
- This is a convenience wrapper around `/loop` — if `/loop` is unavailable, the operator can run checks manually
