#!/usr/bin/env python3
"""PreToolUse hook: gate mcp__homeassistant__* calls targeting sensitive entities.

Reads tool call JSON from stdin. Extracts entity references from the tool input
parameters and checks each against ha_agent_lab.policy.

Behavior depends on `ha_safety_mode` in .claude-code-hermit/config.json:
  - "strict" (default): sensitive entities → exit 2 (block, reason on stderr)
  - "ask": sensitive entities → emit `permissionDecision: "ask"` JSON so Claude Code
    prompts the operator before allowing the call

Fail-safe: blocks (exit 2) on any parse error or unresolvable target. The dial
does NOT relax this — it only changes how concrete sensitive entity IDs are handled.
"""

from __future__ import annotations

import json
import sys

from ha_agent_lab.policy import Severity, classify_entity


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

    hits: list[tuple[str, Severity]] = []
    for eid in entity_ids:
        sev, _ = classify_entity(eid)
        if sev != Severity.ALLOW:
            hits.append((eid, sev))

    if not hits:
        sys.exit(0)

    # All hits share the same severity under the two-tier model — the current
    # mode applies uniformly to every sensitive entity in this call.
    current_sev = hits[0][1]
    names = ", ".join(e for e, _ in hits)

    if current_sev == Severity.BLOCK:
        print(f"Blocked sensitive entities: {names}. Use a proposal instead.", file=sys.stderr)
        sys.exit(2)

    print(
        json.dumps(
            {
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "ask",
                    "permissionDecisionReason": f"Sensitive entities: {names}",
                }
            }
        )
    )
    sys.exit(0)


if __name__ == "__main__":
    main()
