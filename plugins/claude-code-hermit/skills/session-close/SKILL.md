---
name: session-close
description: "[Renamed in v1.1.0] Alias for /done --shutdown. Clears focus and signals the graceful-stop path. Activates on messages like 'I'm done', 'wrap it up', 'close the session'."
---
# Session-Close (Alias for /done --shutdown)

`/session-close` was renamed to `/done` in v1.1.0 as part of the session-model retirement (see PROP-031). The shutdown framing migrated to the `--shutdown` flag — `/session-close` always implied a full shutdown, so this alias forwards that intent. Preserved for one minor version (retiring in v1.2.0).

## Workflow

1. Tell the operator (one line, non-blocking): `Note: /session-close renamed to /done --shutdown. Update your shortcuts.`
2. Invoke `/claude-code-hermit:done --shutdown`, forwarding any additional arguments.
3. Return whatever /done returns.

No additional behavior here — `/done` is the source of truth.
