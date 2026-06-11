from pathlib import Path

import pytest


@pytest.fixture
def make_ha_config(tmp_path: Path):
    """Factory fixture: writes ha_safety_mode to .claude-code-hermit/config.json."""
    def _make(mode: str) -> Path:
        cfg_dir = tmp_path / ".claude-code-hermit"
        cfg_dir.mkdir(parents=True, exist_ok=True)
        (cfg_dir / "config.json").write_text(f'{{"ha_safety_mode": "{mode}"}}')
        return tmp_path
    return _make
