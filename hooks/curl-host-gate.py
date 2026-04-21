#!/usr/bin/env python3
"""PreToolUse hook: auto-approve curl/wget calls that target the HA instance.

Reads tool call JSON from stdin. If the Bash command string contains
a known HA URL (from .env or env vars), emits a JSON allow decision.
Otherwise exits silently (default permission behavior continues).

Fail-open: any exception logs to stderr and exits 0.
"""

from __future__ import annotations

import json
import os
import sys


def _load_env_file(path: str) -> dict[str, str]:
    result: dict[str, str] = {}
    try:
        with open(path) as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, _, val = line.partition("=")
                key = key.strip()
                val = val.strip().strip("'\"")
                if key:
                    result[key] = val
    except OSError:
        pass
    return result


def _build_needles() -> list[str]:
    project_dir = os.environ.get("CLAUDE_PROJECT_DIR", "")
    env_vars = _load_env_file(os.path.join(project_dir, ".env")) if project_dir else {}
    env_vars = {**env_vars, **os.environ}  # process env wins

    needles: list[str] = []
    for key in ("HOMEASSISTANT_URL", "HOMEASSISTANT_LOCAL_URL", "HOMEASSISTANT_REMOTE_URL"):
        val = env_vars.get(key, "").rstrip("/")
        if val:
            needles.append(val)

    if not needles:
        needles = [
            "http://127.0.0.1:8123",
            "http://localhost:8123",
            "http://[::1]:8123",
        ]

    return list(dict.fromkeys(needles))  # deduplicate, preserve order


def main() -> None:
    try:
        payload = json.load(sys.stdin)

        if payload.get("tool_name") != "Bash":
            sys.exit(0)

        command = payload.get("tool_input", {}).get("command", "")
        needles = _build_needles()

        if any(needle in command for needle in needles):
            print(json.dumps({
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "allow",
                    "permissionDecisionReason": "curl/wget targets Home Assistant URL",
                }
            }))

    except Exception as exc:  # noqa: BLE001
        print(f"curl-host-gate: {exc}", file=sys.stderr)

    sys.exit(0)


if __name__ == "__main__":
    main()
