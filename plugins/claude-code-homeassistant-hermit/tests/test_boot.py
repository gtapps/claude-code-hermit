from pathlib import Path
from unittest.mock import patch

import pytest

from ha_agent_lab.boot import boot_status, read_language, save_boot_preferences, write_language, _command_prefix
from ha_agent_lab.config import load_config
from ha_agent_lab.ha_api import HomeAssistantClient, HomeAssistantError, select_home_assistant_url


def _write_launcher(root: Path) -> None:
    launcher = root / "bin" / "ha-agent-lab"
    launcher.parent.mkdir(parents=True, exist_ok=True)
    launcher.write_text("#!/usr/bin/env bash\n", encoding="utf-8")


def test_language_roundtrip(tmp_path: Path) -> None:
    write_language(tmp_path, "pt-PT")
    assert read_language(tmp_path) == "pt-PT"


def test_boot_preferences_store_operator_context(tmp_path: Path) -> None:
    save_boot_preferences(
        tmp_path,
        language="en",
        local_url="http://ha.local:8123",
        remote_url="https://ha.example.com",
        token="secret-token",
    )
    config = load_config(tmp_path)
    assert config.ha_local_url == "http://ha.local:8123"
    assert config.ha_remote_url == "https://ha.example.com"
    assert config.ha_token == "secret-token"
    assert read_language(tmp_path) == "en"


def test_boot_status_detects_missing_context(tmp_path: Path) -> None:
    write_language(tmp_path, "en")
    config = load_config(tmp_path)
    status = boot_status(config, probe=False)
    assert status.language == "en"
    assert status.needs_context_refresh
    assert not status.context_exists


def test_boot_status_reports_missing_required_setup(tmp_path: Path) -> None:
    _write_launcher(tmp_path)
    status = boot_status(load_config(tmp_path), probe=False)
    fields = {item["field"] for item in status.setup_hints}
    assert "Language" in fields
    assert "HOMEASSISTANT_URL" in fields
    assert "HOMEASSISTANT_TOKEN" in fields
    assert status.command_prefix.endswith("/bin/ha-agent-lab")
    assert not status.can_refresh_context


def test_command_prefix_returns_absolute_plugin_launcher() -> None:
    prefix = _command_prefix()
    assert prefix.endswith("/bin/ha-agent-lab")
    assert Path(prefix).is_absolute()


def test_boot_status_exposes_single_pass_setup_checklist(tmp_path: Path) -> None:
    _write_launcher(tmp_path)
    status = boot_status(load_config(tmp_path), probe=False)
    checklist = {item["field"]: item for item in status.setup_checklist}
    assert checklist["Language"]["status"] == "missing"
    assert checklist["Home Assistant endpoint"]["status"] == "missing"
    assert checklist["HOMEASSISTANT_TOKEN"]["status"] == "missing"
    assert checklist["Context snapshot"]["status"] == "missing"
    assert checklist["HOMEASSISTANT_REMOTE_URL"]["status"] == "optional"


def test_home_assistant_client_reports_exact_missing_configuration(tmp_path: Path) -> None:
    _write_launcher(tmp_path)
    with pytest.raises(HomeAssistantError) as excinfo:
        HomeAssistantClient(load_config(tmp_path))

    message = str(excinfo.value)
    assert "HOMEASSISTANT_URL" in message
    assert "HOMEASSISTANT_TOKEN" in message
    assert "./bin/ha-agent-lab boot status --probe" in message


def test_home_assistant_client_distinguishes_missing_token_from_missing_endpoint(tmp_path: Path) -> None:
    _write_launcher(tmp_path)
    save_boot_preferences(tmp_path, local_url="http://ha.local:8123")

    with pytest.raises(HomeAssistantError) as excinfo:
        HomeAssistantClient(load_config(tmp_path))

    message = str(excinfo.value)
    assert "HOMEASSISTANT_TOKEN" in message
    assert "HOMEASSISTANT_URL" not in message


def test_boot_preferences_store_url(tmp_path: Path) -> None:
    save_boot_preferences(tmp_path, url="https://myha.nabu.casa")
    config = load_config(tmp_path)
    assert config.ha_url == "https://myha.nabu.casa"
    assert config.has_ha_endpoint
    assert config.primary_url() == "https://myha.nabu.casa"


def test_select_url_single_mode(tmp_path: Path) -> None:
    save_boot_preferences(tmp_path, url="https://myha.nabu.casa", token="tok")
    config = load_config(tmp_path)
    with patch("ha_agent_lab.ha_api.probe_home_assistant_url", return_value=True):
        url, source = select_home_assistant_url(config)
    assert url == "https://myha.nabu.casa"
    assert source == "single"


def test_select_url_backcompat_local_url(tmp_path: Path) -> None:
    save_boot_preferences(tmp_path, local_url="http://ha.local:8123", token="tok")
    config = load_config(tmp_path)
    with patch("ha_agent_lab.ha_api.probe_home_assistant_url", return_value=True):
        url, source = select_home_assistant_url(config)
    assert url == "http://ha.local:8123"
    assert source == "single"


def test_select_url_dual_mode_falls_back_to_remote(tmp_path: Path) -> None:
    save_boot_preferences(tmp_path, local_url="http://ha.local:8123", remote_url="https://ha.remote.com", token="tok")
    config = load_config(tmp_path)
    with patch("ha_agent_lab.ha_api.probe_home_assistant_url", side_effect=[False, True]):
        url, source = select_home_assistant_url(config)
    assert url == "https://ha.remote.com"
    assert source == "remote"
