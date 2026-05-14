from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

import pytest

from ha_agent_lab.boot import save_boot_preferences
from ha_agent_lab.config import load_config
from ha_agent_lab.ha_api import HomeAssistantClient, HomeAssistantError, select_home_assistant_url


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_client(tmp_path: Path) -> HomeAssistantClient:
    """Return a HomeAssistantClient whose URL probe is bypassed."""
    save_boot_preferences(tmp_path, url="http://ha.local:8123", token="fake-token")
    config = load_config(tmp_path)
    with patch("ha_agent_lab.ha_api.select_home_assistant_url", return_value=("http://ha.local:8123", "test")):
        return HomeAssistantClient(config)


_T0 = datetime(2026, 5, 1, 0, 0, 0, tzinfo=timezone.utc)
_T1 = datetime(2026, 5, 8, 0, 0, 0, tzinfo=timezone.utc)


# ---------------------------------------------------------------------------
# get_history — response mapping
# ---------------------------------------------------------------------------

def test_get_history_returns_dict_keyed_by_entity_from_response(tmp_path: Path) -> None:
    client = _make_client(tmp_path)
    response = [
        [{"entity_id": "light.kitchen", "state": "on"}, {"entity_id": "light.kitchen", "state": "off"}],
        [{"entity_id": "switch.fan", "state": "on"}],
    ]
    with patch.object(client, "get", return_value=response):
        result = client.get_history(["light.kitchen", "switch.fan"], _T0, _T1)
    assert set(result.keys()) == {"light.kitchen", "switch.fan"}
    assert result["light.kitchen"] == response[0]
    assert result["switch.fan"] == response[1]


def test_get_history_raises_on_empty_entity_ids(tmp_path: Path) -> None:
    client = _make_client(tmp_path)
    with pytest.raises(HomeAssistantError, match="entity_ids"):
        client.get_history([], _T0, _T1)


def test_get_history_omits_entities_with_no_events_from_response(tmp_path: Path) -> None:
    client = _make_client(tmp_path)
    # HA omits entities that had no events — only light.kitchen returned
    response = [[{"entity_id": "light.kitchen", "state": "on"}]]
    with patch.object(client, "get", return_value=response):
        result = client.get_history(["light.kitchen", "switch.fan"], _T0, _T1)
    assert "light.kitchen" in result
    assert "switch.fan" not in result


def test_get_history_resilient_to_response_reordering(tmp_path: Path) -> None:
    client = _make_client(tmp_path)
    # Response arrives in reverse order from what we requested
    response = [
        [{"entity_id": "switch.fan", "state": "on"}],
        [{"entity_id": "light.kitchen", "state": "off"}],
    ]
    with patch.object(client, "get", return_value=response):
        result = client.get_history(["light.kitchen", "switch.fan"], _T0, _T1)
    assert result["light.kitchen"] == response[1]
    assert result["switch.fan"] == response[0]


def test_get_history_returns_empty_dict_on_non_list_response(tmp_path: Path) -> None:
    client = _make_client(tmp_path)
    with patch.object(client, "get", return_value={"error": "unexpected"}):
        result = client.get_history(["light.kitchen"], _T0, _T1)
    assert result == {}


# ---------------------------------------------------------------------------
# get_history — URL construction
# ---------------------------------------------------------------------------

def test_get_history_url_encodes_iso8601_plus_sign_and_colons(tmp_path: Path) -> None:
    client = _make_client(tmp_path)
    captured: list[str] = []

    def _fake_get(path: str) -> list:
        captured.append(path)
        return []

    with patch.object(client, "get", side_effect=_fake_get):
        client.get_history(["light.x"], _T0, _T1)

    path = captured[0]
    # Colons and plus signs must be percent-encoded in the ISO timestamp
    assert ":" not in path.split("?")[0]  # start_iso in path segment
    assert "%3A" in path  # encoded colon
    assert "%2B" in path  # encoded plus sign from UTC offset


def test_get_history_uses_bare_flag_query_string(tmp_path: Path) -> None:
    client = _make_client(tmp_path)
    captured: list[str] = []

    with patch.object(client, "get", side_effect=lambda p: captured.append(p) or []):
        client.get_history(["light.x"], _T0, _T1)

    path = captured[0]
    assert "&minimal_response" in path
    assert "minimal_response=true" not in path
    assert "&significant_changes_only" in path
    assert "significant_changes_only=true" not in path
    assert "&end_time=" in path


def test_get_history_requires_explicit_end_time(tmp_path: Path) -> None:
    client = _make_client(tmp_path)
    with pytest.raises(Exception):
        client.get_history(["light.x"], _T0, None)  # type: ignore[arg-type]


# ---------------------------------------------------------------------------
# select_home_assistant_url (pre-existing tests)
# ---------------------------------------------------------------------------

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
