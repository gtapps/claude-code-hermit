from __future__ import annotations

import json
from unittest.mock import patch

import pytest

from ha_agent_lab.cli import main
from ha_agent_lab.ha_api import HomeAssistantError


def test_delete_automation_ok(capsys, make_mock_config) -> None:
    cfg = make_mock_config()
    with patch("ha_agent_lab.cli.load_config", return_value=cfg), \
         patch("ha_agent_lab.cli.HomeAssistantClient") as MockClient:
        instance = MockClient.return_value
        instance.delete.return_value = {"result": "ok"}
        result = main(["ha", "delete-automation", "my_automation"])

    assert result == 0
    out = json.loads(capsys.readouterr().out)
    assert out["ok"] is True
    assert out["config_id"] == "my_automation"
    assert out["domain"] == "automation"
    instance.delete.assert_called_once_with("/api/config/automation/config/my_automation")


def test_delete_script_ok(capsys, make_mock_config) -> None:
    cfg = make_mock_config()
    with patch("ha_agent_lab.cli.load_config", return_value=cfg), \
         patch("ha_agent_lab.cli.HomeAssistantClient") as MockClient:
        instance = MockClient.return_value
        instance.delete.return_value = {"result": "ok"}
        result = main(["ha", "delete-script", "my_script"])

    assert result == 0
    out = json.loads(capsys.readouterr().out)
    assert out["ok"] is True
    assert out["config_id"] == "my_script"
    assert out["domain"] == "script"
    instance.delete.assert_called_once_with("/api/config/script/config/my_script")


def test_delete_automation_not_found_exits_nonzero(capsys, make_mock_config) -> None:
    cfg = make_mock_config()
    with patch("ha_agent_lab.cli.load_config", return_value=cfg), \
         patch("ha_agent_lab.cli.HomeAssistantClient") as MockClient:
        instance = MockClient.return_value
        instance.delete.side_effect = HomeAssistantError(
            "Home Assistant request failed.", status_code=400,
            payload='{"message":"Resource not found"}',
        )
        result = main(["ha", "delete-automation", "nonexistent"])

    assert result == 1
    out = json.loads(capsys.readouterr().out)
    assert out["ok"] is False
    assert out["message"] == "Resource not found"


def test_list_automations_ok(capsys, make_mock_config) -> None:
    cfg = make_mock_config()
    states = [
        {"entity_id": "automation.lights_on", "attributes": {"id": "lights_on", "friendly_name": "Lights On"}, "state": "on", "last_changed": "2026-05-05T10:00:00Z"},
        {"entity_id": "light.living_room", "attributes": {}, "state": "off", "last_changed": "2026-05-05T10:00:00Z"},
    ]
    with patch("ha_agent_lab.cli.load_config", return_value=cfg), \
         patch("ha_agent_lab.cli.HomeAssistantClient") as MockClient:
        instance = MockClient.return_value
        instance.get.return_value = states
        result = main(["ha", "list-automations"])

    assert result == 0
    items = json.loads(capsys.readouterr().out)
    assert len(items) == 1
    assert items[0]["entity_id"] == "automation.lights_on"
    assert items[0]["id"] == "lights_on"
    assert items[0]["alias"] == "Lights On"


def test_list_scripts_filters_correctly(capsys, make_mock_config) -> None:
    cfg = make_mock_config()
    states = [
        {"entity_id": "script.welcome", "attributes": {"id": "welcome", "friendly_name": "Welcome"}, "state": "off", "last_changed": "2026-05-05T10:00:00Z"},
        {"entity_id": "automation.lights_on", "attributes": {"id": "lights_on", "friendly_name": "Lights On"}, "state": "on", "last_changed": "2026-05-05T10:00:00Z"},
    ]
    with patch("ha_agent_lab.cli.load_config", return_value=cfg), \
         patch("ha_agent_lab.cli.HomeAssistantClient") as MockClient:
        instance = MockClient.return_value
        instance.get.return_value = states
        result = main(["ha", "list-scripts"])

    assert result == 0
    items = json.loads(capsys.readouterr().out)
    assert len(items) == 1
    assert items[0]["entity_id"] == "script.welcome"
