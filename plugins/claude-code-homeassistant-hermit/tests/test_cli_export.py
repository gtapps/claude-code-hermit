from __future__ import annotations

import json
from unittest.mock import patch

import pytest
import yaml

from ha_agent_lab.cli import main
from ha_agent_lab.ha_api import HomeAssistantError


_SAMPLE_CONFIG = {
    "id": "kitchen_lights",
    "alias": "Kitchen lights at sunset",
    "trigger": [{"platform": "sun", "event": "sunset"}],
    "action": [{"service": "light.turn_on", "target": {"entity_id": "light.kitchen"}}],
}


def test_export_automation_ok(capsys, make_mock_config) -> None:
    cfg = make_mock_config()
    with patch("ha_agent_lab.cli.load_config", return_value=cfg), \
         patch("ha_agent_lab.cli.HomeAssistantClient") as MockClient:
        instance = MockClient.return_value
        instance.get.return_value = _SAMPLE_CONFIG
        result = main(["ha", "export-automation", "kitchen_lights"])

    assert result == 0
    out = json.loads(capsys.readouterr().out)
    assert out["ok"] is True
    assert out["domain"] == "automation"
    assert out["config_id"] == "kitchen_lights"
    assert out["path"] == ".claude-code-hermit/raw/automation-kitchen_lights.yaml"

    instance.get.assert_called_once_with("/api/config/automation/config/kitchen_lights")

    written = (cfg.root / ".claude-code-hermit" / "raw" / "automation-kitchen_lights.yaml").read_text()
    loaded = yaml.safe_load(written)
    assert loaded == _SAMPLE_CONFIG
    # Key order preserved (sort_keys=False).
    assert list(loaded.keys()) == ["id", "alias", "trigger", "action"]


def test_export_script_ok(capsys, make_mock_config) -> None:
    cfg = make_mock_config()
    with patch("ha_agent_lab.cli.load_config", return_value=cfg), \
         patch("ha_agent_lab.cli.HomeAssistantClient") as MockClient:
        instance = MockClient.return_value
        instance.get.return_value = {"alias": "Welcome", "sequence": []}
        result = main(["ha", "export-script", "welcome"])

    assert result == 0
    out = json.loads(capsys.readouterr().out)
    assert out["domain"] == "script"
    assert out["path"] == ".claude-code-hermit/raw/script-welcome.yaml"
    instance.get.assert_called_once_with("/api/config/script/config/welcome")


@pytest.mark.parametrize(
    "bad_id",
    ["automation.kitchen_lights", "sensor.kitchen_temp", "light.foo"],
)
def test_export_rejects_entity_id_shape(capsys, make_mock_config, bad_id) -> None:
    """Any `.` is treated as entity-id-shaped, regardless of domain prefix."""
    cfg = make_mock_config()
    with patch("ha_agent_lab.cli.load_config", return_value=cfg), \
         patch("ha_agent_lab.cli.HomeAssistantClient"):
        result = main(["ha", "export-automation", bad_id])

    assert result == 1
    assert "looks like an entity_id" in capsys.readouterr().err


def test_export_not_found_returns_nonzero(capsys, make_mock_config) -> None:
    cfg = make_mock_config()
    with patch("ha_agent_lab.cli.load_config", return_value=cfg), \
         patch("ha_agent_lab.cli.HomeAssistantClient") as MockClient:
        instance = MockClient.return_value
        instance.get.side_effect = HomeAssistantError(
            "Home Assistant request failed.", status_code=400,
            payload='{"message":"Resource not found"}',
        )
        result = main(["ha", "export-automation", "nonexistent"])

    assert result == 1


def test_export_filename_slugified_for_hostile_id(capsys, make_mock_config) -> None:
    cfg = make_mock_config()
    hostile_id = "weird/id with spaces"
    with patch("ha_agent_lab.cli.load_config", return_value=cfg), \
         patch("ha_agent_lab.cli.HomeAssistantClient") as MockClient:
        instance = MockClient.return_value
        instance.get.return_value = {"id": hostile_id, "alias": "weird"}
        result = main(["ha", "export-automation", hostile_id])

    assert result == 0
    out = json.loads(capsys.readouterr().out)
    # Path must not contain the original separator or space.
    assert "/" not in out["path"].split("/")[-1]  # filename component only
    assert " " not in out["path"]
    assert "slugified" in out["message"]
    # HA call still uses the original id.
    instance.get.assert_called_once_with(f"/api/config/automation/config/{hostile_id}")


def test_exported_yaml_roundtrips_through_policy_check(tmp_path, make_mock_config) -> None:
    """The exported YAML should be readable by simulate.evaluate_yaml_policy."""
    from ha_agent_lab.simulate import evaluate_yaml_policy

    cfg = make_mock_config()
    with patch("ha_agent_lab.cli.load_config", return_value=cfg), \
         patch("ha_agent_lab.cli.HomeAssistantClient") as MockClient:
        instance = MockClient.return_value
        instance.get.return_value = _SAMPLE_CONFIG
        main(["ha", "export-automation", "kitchen_lights"])

    yaml_path = cfg.root / ".claude-code-hermit" / "raw" / "automation-kitchen_lights.yaml"
    entities, services, decision = evaluate_yaml_policy(yaml_path)
    assert "light.kitchen" in entities
    assert decision.severity.value == "allow"
