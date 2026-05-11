import json
import subprocess
import sys
from pathlib import Path

HOOK = Path(__file__).parent.parent / "hooks" / "mcp-safety-gate.py"


def _run(payload: dict | str, cwd: Path | None = None) -> subprocess.CompletedProcess:
    data = payload if isinstance(payload, str) else json.dumps(payload)
    return subprocess.run(
        [sys.executable, str(HOOK)],
        input=data,
        capture_output=True,
        text=True,
        cwd=cwd,
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


def test_alarm_prompts_operator_in_ask_mode(make_ha_config):
    root = make_ha_config("ask")
    result = _run({"tool_input": {"entity_id": "alarm_control_panel.home"}}, cwd=root)
    assert result.returncode == 0
    out = json.loads(result.stdout)
    assert out["hookSpecificOutput"]["permissionDecision"] == "ask"
    assert "alarm_control_panel.home" in out["hookSpecificOutput"]["permissionDecisionReason"]


def test_lock_prompts_operator_in_ask_mode(make_ha_config):
    root = make_ha_config("ask")
    result = _run({"tool_input": {"entity_id": "lock.front_door"}}, cwd=root)
    assert result.returncode == 0
    out = json.loads(result.stdout)
    assert out["hookSpecificOutput"]["permissionDecision"] == "ask"
    assert "lock.front_door" in out["hookSpecificOutput"]["permissionDecisionReason"]


def test_no_entities_blocked_in_ask_mode(make_ha_config):
    """Fail-closed branch stays exit 2 even in ask mode — dial only relaxes domain checks."""
    root = make_ha_config("ask")
    result = _run({"tool_input": {}}, cwd=root)
    assert result.returncode == 2
    assert "Cannot verify target safety" in result.stderr


def test_safe_entity_in_ask_mode_passes_silently(make_ha_config):
    """Non-sensitive entities still exit 0 with no stdout output under ask mode."""
    root = make_ha_config("ask")
    result = _run({"tool_input": {"entity_id": "light.living_room"}}, cwd=root)
    assert result.returncode == 0
    assert result.stdout == ""
