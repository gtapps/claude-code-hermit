---
name: forge-servers
description: List, inspect, and reboot Laravel Forge servers. Reboot always goes through surface-then-approve (preview-reboot → confirm → server-reboot --confirm). Triggers on "list servers", "show server", "reboot server", "server status".
---

# Forge Servers

List and inspect servers in the Forge estate, or reboot a server with approval.

## List all servers

```bash
php ${CLAUDE_PLUGIN_ROOT}/php/forge.php servers
```

Output: one line per server with ID, name, and IP address.

## Show server detail

```bash
php ${CLAUDE_PLUGIN_ROOT}/php/forge.php server <server>
```

`<server>` can be a server name, IP address, or numeric ID. Ambiguous names are rejected with a list of collisions.

## Reboot a server (surface-then-approve)

**Step 1 — Preview (read-only, no action taken):**

```bash
php ${CLAUDE_PLUGIN_ROOT}/php/forge.php preview-reboot <server>
```

Resolves `<server>` to the canonical record and prints the server name, IP, and ID. Exit 0, no mutation.

**Step 2 — Relay to operator.** Show the canonical target. Ask for explicit approval.

**Step 3 — On approval only:**

```bash
php ${CLAUDE_PLUGIN_ROOT}/php/forge.php server-reboot <server> --confirm
```

A wrong reboot causes an outage. Never auto-confirm. Never skip the preview step.

## Notes

- `${CLAUDE_PLUGIN_ROOT}` is substituted in installed mode. In `--plugin-dir` dev mode, use the absolute path.
- For server logs, use `/laravel-forge-hermit:forge-logs`.
- For site-level work, use `/laravel-forge-hermit:forge-sites`.
