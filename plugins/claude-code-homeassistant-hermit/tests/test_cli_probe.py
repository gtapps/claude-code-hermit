from __future__ import annotations

import json
import sys
from io import StringIO
from unittest.mock import MagicMock, patch

import pytest

from ha_agent_lab.cli import main
from ha_agent_lab.ha_api import HomeAssistantError


def _make_config(url: str = "http://homeassistant.local:8123") -> MagicMock:
    cfg = MagicMock()
    cfg.root = MagicMock()
    cfg.missing_ha_configuration_fields.return_value = []
    cfg.ha_token = "fake-token"
    cfg.ha_local_url = None
    cfg.ha_remote_url = None
    cfg.primary_url.return_value = url
    cfg.retry_count = 0
    cfg.timeout_seconds = 5
    return cfg


def test_probe_success(capsys) -> None:
    response = {"id": "123", "alias": "Test automation", "trigger": []}
    cfg = _make_config()

    with patch("ha_agent_lab.cli.load_config", return_value=cfg), \
         patch("ha_agent_lab.cli.HomeAssistantClient") as MockClient:
        instance = MockClient.return_value
        instance.get.return_value = response
        result = main(["ha", "probe", "/api/config/automation/config/123"])

    assert result == 0
    captured = capsys.readouterr()
    assert json.loads(captured.out) == response
    instance.get.assert_called_once_with("/api/config/automation/config/123")


def test_probe_404_exits_nonzero(capsys) -> None:
    cfg = _make_config()

    with patch("ha_agent_lab.cli.load_config", return_value=cfg), \
         patch("ha_agent_lab.cli.HomeAssistantClient") as MockClient:
        instance = MockClient.return_value
        instance.get.side_effect = HomeAssistantError(message="not found", status_code=404, payload="Not Found")
        result = main(["ha", "probe", "/api/config/automation/config/999"])

    assert result == 1
    captured = capsys.readouterr()
    assert "404" in captured.err
