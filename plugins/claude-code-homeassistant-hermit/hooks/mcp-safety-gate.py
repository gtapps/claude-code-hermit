#!/usr/bin/env python3
"""PreToolUse hook: block mcp__homeassistant__* calls targeting sensitive entities.

Reads tool call JSON from stdin. Extracts entity references from the
tool input parameters. Checks each against ha_agent_lab.policy.

Exit codes:
  0 — allow
  2 — block (reason on stderr)

Fail-safe: blocks on any parse error to avoid accidental actuation.
"""

from __future__ import annotations

import json
import sys

from ha_agent_lab.policy import is_sensitive_entity


def extract_entity_ids(tool_input: dict) -> list[str]:
    """Pull entity_id values from MCP tool parameters."""
    ids: list[str] = []
    for key in ("entity_id", "device_id"):
        val = tool_input.get(key)
        if isinstance(val, str) and "." in val:
            ids.append(val)
        elif isinstance(val, list):
            ids.extend(v for v in val if isinstance(v, str) and "." in v)
    target = tool_input.get("target")
    if isinstance(target, dict):
        eid = target.get("entity_id")
        if isinstance(eid, str) and "." in eid:
            ids.append(eid)
        elif isinstance(eid, list):
            ids.extend(v for v in eid if isinstance(v, str) and "." in v)
    return ids


def main() -> None:
    try:
        payload = json.load(sys.stdin)
    except (json.JSONDecodeError, ValueError):
        print("Failed to parse hook input", file=sys.stderr)
        sys.exit(2)

    tool_input = payload.get("tool_input", {})
    if not isinstance(tool_input, dict):
        tool_input = {}

    entity_ids = extract_entity_ids(tool_input)

    if not entity_ids:
        print(
            "Cannot verify target safety: no resolvable entity IDs found "
            "(area_id / device_id targets are not evaluated). Use a proposal instead.",
            file=sys.stderr,
        )
        sys.exit(2)

    blocked = []
    for eid in entity_ids:
        if is_sensitive_entity(eid):
            blocked.append(eid)

    if blocked:
        reason = f"Blocked sensitive entities: {', '.join(blocked)}. Use a proposal instead."
        print(reason, file=sys.stderr)
        sys.exit(2)

    sys.exit(0)


if __name__ == "__main__":
    main()
