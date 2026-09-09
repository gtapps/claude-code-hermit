---
name: ha-snapshot-restore
description: Capture the state of a set of Home Assistant entities (lights, covers, climate, switches) to a named artifact and restore it later via scene.apply. Use to make automation testing reversible — snapshot before a risky change, restore if it misbehaves. Restore of sensitive entities is gated by ha_safety_mode.
allowed-tools:
  - Bash
  - Read
---

# HA Snapshot / Restore

## Purpose

Make changes reversible: capture an entity set's current state before testing a new automation or applying a risky change, then restore those exact states if it misbehaves. Capture is read-only; restore actuates devices in one `scene.apply` call.

## Capture (read-only)

```
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha snapshot-states --name <label> [--domains light,cover,climate,switch] [--entities <id> ...]
```

- `--name` labels the snapshot (default `snapshot`); it becomes part of the artifact filename.
- `--domains` selects which domains to capture (comma-separated; default `light,cover,climate,switch`).
- `--entities` captures an explicit list instead of whole domains.
- Writes `.claude-code-hermit/raw/snapshot-ha-states-<label>-latest.json` (plus a timestamped copy). Only restore-relevant attributes are stored.

## Restore (actuation — gated)

```
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha restore-states <artifact> [--confirm]
```

Restore is the plugin's one direct device-actuation path, so it runs through the same `ha_safety_mode` policy as every other actuation:

- **strict (explicit):** if the snapshot contains any sensitive entity (lock, alarm, security-keyworded cover/switch), restore is **blocked** and exits non-zero with `blocked:true` and a suggestion to surface it as a proposal. Non-sensitive entities (lights, climate) restore normally.
- **ask:** a snapshot touching sensitive entities requires `--confirm`. Without it, the command refuses and reports `needs_confirm:true`. Show the affected entities, then invoke with `--confirm` for native permission. The CLI itself remains non-interactive.
- A successful restore writes an audit report under `.claude-code-hermit/raw/audit-ha-restore-*`.

## Output contract

Capture prints `{ ok, name, captured, entities, report_path, message }`.

Restore prints `{ ok, blocked, needs_confirm, applied, entities, sensitive, reason, ... }`. Exit code is 0 only when `ok` is true.

## Failure modes

- HA unreachable → CLI exits non-zero with an error message.
- A snapshot with no matching entities → capture reports `captured: 0`; restore reports an error.
- Restore replays state + captured attributes via `scene.apply`; for cover position and climate setpoints the result depends on what HA's scene integration can reproduce — verify the outcome rather than assuming an exact match.
