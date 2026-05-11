import json
from pathlib import Path
from unittest.mock import MagicMock

import pytest


@pytest.fixture
def make_ha_root(tmp_path: Path):
    """Factory fixture: creates a minimal HA snapshot root for tests.

    Usage: root = make_ha_root() or root = make_ha_root(inventory={...})
    """
    def _make(inventory: dict | None = None) -> Path:
        raw = tmp_path / ".claude-code-hermit" / "raw"
        raw.mkdir(parents=True)
        snapshot = inventory or {
            "entity_index": {
                "light.living_room": {"entity_id": "light.living_room", "state": "off"},
            }
        }
        (raw / "snapshot-ha-normalized-latest.json").write_text(
            json.dumps(snapshot), encoding="utf-8"
        )
        return tmp_path

    return _make


@pytest.fixture
def make_ha_config(tmp_path: Path):
    """Factory fixture: writes ha_safety_mode to .claude-code-hermit/config.json."""
    def _make(mode: str) -> Path:
        cfg_dir = tmp_path / ".claude-code-hermit"
        cfg_dir.mkdir(parents=True, exist_ok=True)
        (cfg_dir / "config.json").write_text(f'{{"ha_safety_mode": "{mode}"}}')
        return tmp_path
    return _make


@pytest.fixture
def make_mock_config(tmp_path):
    """Factory fixture: builds a MagicMock AppConfig for CLI tests."""
    def _make(url: str = "http://homeassistant.local:8123") -> MagicMock:
        cfg = MagicMock()
        cfg.root = tmp_path
        cfg.missing_ha_configuration_fields.return_value = []
        cfg.ha_token = "fake-token"
        cfg.ha_local_url = None
        cfg.ha_remote_url = None
        cfg.primary_url.return_value = url
        cfg.retry_count = 0
        cfg.timeout_seconds = 5
        return cfg
    return _make
