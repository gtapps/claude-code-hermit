import json
from pathlib import Path

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
