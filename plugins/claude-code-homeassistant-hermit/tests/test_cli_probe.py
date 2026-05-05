from __future__ import annotations

import json
from unittest.mock import patch

import pytest

from ha_agent_lab.cli import main
from ha_agent_lab.ha_api import HomeAssistantError


def test_probe_success(capsys, make_mock_config) -> None:
    response = {"id": "123", "alias": "Test automation", "trigger": []}
    cfg = make_mock_config()

    with patch("ha_agent_lab.cli.load_config", return_value=cfg), \
         patch("ha_agent_lab.cli.HomeAssistantClient") as MockClient:
        instance = MockClient.return_value
        instance.get.return_value = response
        result = main(["ha", "probe", "/api/config/automation/config/123"])

    assert result == 0
    captured = capsys.readouterr()
    assert json.loads(captured.out) == response
    instance.get.assert_called_once_with("/api/config/automation/config/123")


def test_probe_404_exits_nonzero(capsys, make_mock_config) -> None:
    cfg = make_mock_config()

    with patch("ha_agent_lab.cli.load_config", return_value=cfg), \
         patch("ha_agent_lab.cli.HomeAssistantClient") as MockClient:
        instance = MockClient.return_value
        instance.get.side_effect = HomeAssistantError(message="not found", status_code=404, payload="Not Found")
        result = main(["ha", "probe", "/api/config/automation/config/999"])

    assert result == 1
    captured = capsys.readouterr()
    assert "404" in captured.err
