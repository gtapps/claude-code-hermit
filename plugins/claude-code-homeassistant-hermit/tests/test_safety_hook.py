import json
import subprocess
import sys
from pathlib import Path

HOOK = Path(__file__).parent.parent / "hooks" / "mcp-safety-gate.py"


def _run(payload: dict | str) -> subprocess.CompletedProcess:
    data = payload if isinstance(payload, str) else json.dumps(payload)
    return subprocess.run(
        [sys.executable, str(HOOK)],
        input=data,
        capture_output=True,
        text=True,
    )


def test_sensitive_entity_is_blocked():
    result = _run({"tool_input": {"entity_id": "lock.front_door"}})
    assert result.returncode == 2
    assert "lock.front_door" in result.stderr


def test_alarm_entity_is_blocked():
    result = _run({"tool_input": {"entity_id": "alarm_control_panel.home"}})
    assert result.returncode == 2


def test_safe_entity_is_allowed():
    result = _run({"tool_input": {"entity_id": "light.living_room"}})
    assert result.returncode == 0


def test_target_dict_sensitive_entity_is_blocked():
    result = _run({"tool_input": {"target": {"entity_id": "lock.garage"}}})
    assert result.returncode == 2


def test_target_dict_safe_entity_is_allowed():
    result = _run({"tool_input": {"target": {"entity_id": "fan.bedroom"}}})
    assert result.returncode == 0


def test_list_of_entities_blocks_if_any_sensitive():
    result = _run({"tool_input": {"entity_id": ["light.kitchen", "lock.front_door"]}})
    assert result.returncode == 2


def test_no_entities_is_blocked():
    # Fail-closed: no resolvable entity_ids means we cannot verify safety.
    result = _run({"tool_input": {}})
    assert result.returncode == 2
    assert "Cannot verify target safety" in result.stderr


def test_malformed_json_is_blocked():
    result = _run("not-json")
    assert result.returncode == 2


def test_missing_tool_input_is_blocked():
    # Fail-closed: missing tool_input also yields no entity IDs.
    result = _run({})
    assert result.returncode == 2
    assert "Cannot verify target safety" in result.stderr
