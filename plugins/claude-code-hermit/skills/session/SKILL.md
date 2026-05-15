---
name: session
description: "[Renamed in v1.1.0] Alias for /done. Clears the current focus without shutting down. Activates on messages like 'task done', 'wrap this up', 'finish and pick next'."
disable-model-invocation: true
---
# Session (Alias for /done)

`/session` was the idle-transition flow that closed a task and waited for the next. In v1.1.0 the session-model retired (PROP-031) and `/done` replaced both `/session` and `/session-close`. The non-shutdown variant maps to `/done` without flags; the shutdown variant maps to `/done --shutdown` (see `/session-close` shim). Preserved for one minor version (retiring in v1.2.0).

## Workflow

1. Tell the operator (one line, non-blocking): `Note: /session renamed to /done. Update your shortcuts.`
2. Invoke `/claude-code-hermit:done`, forwarding all arguments verbatim.
3. Return whatever /done returns.

No additional behavior here — `/done` is the source of truth.
