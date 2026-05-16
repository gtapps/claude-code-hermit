from __future__ import annotations

import json
from unittest.mock import patch

import pytest

from ha_agent_lab.cli import main
from ha_agent_lab.ha_api import HomeAssistantError


def test_get_automation_config_ok(capsys, make_mock_config) -> None:
    cfg = make_mock_config()
    config_payload = {"id": "my_automation", "alias": "My Automation", "trigger": [], "action": []}
    with patch("ha_agent_lab.cli.load_config", return_value=cfg), \
         patch("ha_agent_lab.cli.HomeAssistantClient") as MockClient:
        instance = MockClient.return_value
        instance.get.return_value = config_payload
        result = main(["ha", "get-automation-config", "my_automation"])

    assert result == 0
    out = json.loads(capsys.readouterr().out)
    assert out["ok"] is True
    assert out["domain"] == "automation"
    assert out["config_id"] == "my_automation"
    assert out["config"] == config_payload
    instance.get.assert_called_once_with("/api/config/automation/config/my_automation")


def test_get_script_config_ok(capsys, make_mock_config) -> None:
    cfg = make_mock_config()
    config_payload = {"id": "garage_gate", "alias": "Garage Gate", "sequence": [{"enabled": True}]}
    with patch("ha_agent_lab.cli.load_config", return_value=cfg), \
         patch("ha_agent_lab.cli.HomeAssistantClient") as MockClient:
        instance = MockClient.return_value
        instance.get.return_value = config_payload
        result = main(["ha", "get-script-config", "garage_gate"])

    assert result == 0
    out = json.loads(capsys.readouterr().out)
    assert out["ok"] is True
    assert out["domain"] == "script"
    assert out["config_id"] == "garage_gate"
    assert out["config"] == config_payload
    instance.get.assert_called_once_with("/api/config/script/config/garage_gate")


@pytest.mark.parametrize("command", ["get-automation-config", "get-script-config"])
def test_get_config_not_found_exits_nonzero(command, capsys, make_mock_config) -> None:
    cfg = make_mock_config()
    with patch("ha_agent_lab.cli.load_config", return_value=cfg), \
         patch("ha_agent_lab.cli.HomeAssistantClient") as MockClient:
        instance = MockClient.return_value
        instance.get.side_effect = HomeAssistantError(
            "Home Assistant request failed.", status_code=400,
            payload='{"message":"Resource not found"}',
        )
        result = main(["ha", command, "nonexistent"])

    assert result == 1
    out = json.loads(capsys.readouterr().out)
    assert out["ok"] is False
    assert out["message"] == "Resource not found"


def test_get_automation_config_yaml_mode_403(capsys, make_mock_config) -> None:
    cfg = make_mock_config()
    with patch("ha_agent_lab.cli.load_config", return_value=cfg), \
         patch("ha_agent_lab.cli.HomeAssistantClient") as MockClient:
        instance = MockClient.return_value
        instance.get.side_effect = HomeAssistantError(
            "Forbidden: Home Assistant is in YAML mode (REST config API unavailable).",
            status_code=403,
            payload="",
        )
        result = main(["ha", "get-automation-config", "my_auto"])

    assert result == 1
    out = json.loads(capsys.readouterr().out)
    assert out["ok"] is False
    assert "YAML mode" in out["message"]
