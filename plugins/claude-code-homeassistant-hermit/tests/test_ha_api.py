from pathlib import Path
from unittest.mock import patch

import pytest

from ha_agent_lab.boot import save_boot_preferences
from ha_agent_lab.config import load_config
from ha_agent_lab.ha_api import HomeAssistantError, select_home_assistant_url


def test_select_url_dual_mode_both_unreachable_falls_back_to_local(tmp_path: Path) -> None:
    save_boot_preferences(
        tmp_path,
        local_url="http://ha.local:8123",
        remote_url="https://ha.remote.com",
        token="tok",
    )
    config = load_config(tmp_path)
    with patch("ha_agent_lab.ha_api.probe_home_assistant_url", return_value=False):
        url, source = select_home_assistant_url(config)
    assert url == "http://ha.local:8123"
    assert source == "fallback"


def test_select_url_raises_when_token_missing(tmp_path: Path) -> None:
    save_boot_preferences(tmp_path, url="http://ha.local:8123")
    config = load_config(tmp_path)
    with pytest.raises(HomeAssistantError, match="TOKEN"):
        select_home_assistant_url(config)


def test_select_url_raises_when_no_url_configured(tmp_path: Path) -> None:
    save_boot_preferences(tmp_path, token="tok")
    config = load_config(tmp_path)
    with pytest.raises(HomeAssistantError, match="URL"):
        select_home_assistant_url(config)
