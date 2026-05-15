---
name: session-start
description: "[Renamed in v1.1.0] Alias for /steer. Initializes or resumes the live focus dashboard. Activates on messages like 'let's start', 'good morning', 'what's on deck'."
---
# Session-Start (Alias for /steer)

`/session-start` was renamed to `/steer` in v1.1.0 as part of the session-model retirement (see PROP-031). This skill is preserved as a backwards-compat alias for one minor version (retiring in v1.2.0).

## Workflow

1. Tell the operator (one line, non-blocking): `Note: /session-start renamed to /steer. Update your shortcuts.`
2. Invoke `/claude-code-hermit:steer`, forwarding all arguments verbatim (the positional focus text).
3. Return whatever /steer returns.

No additional behavior here — `/steer` is the source of truth.
