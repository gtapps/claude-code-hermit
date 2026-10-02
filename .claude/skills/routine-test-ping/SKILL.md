---
name: routine-test-ping
description: Proof-of-life for the routine monitor. Appends one timestamped line to SHELL.md under Monitoring and stops. Fired by the routine scheduler; not for operator use.
---

# Routine Test Ping

Proof-of-life for the routine monitor — confirms a routine still fires correctly. No side effects beyond a log line.

## Steps

Append one line to `.hermit/sessions/SHELL.md` under `## Monitoring`:

```
[HH:MM] routine-test-ping: fired.
```

Stop. No channel send, no further checks.
