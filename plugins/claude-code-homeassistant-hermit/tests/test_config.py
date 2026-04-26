from pathlib import Path

from ha_agent_lab.config import load_config, save_env_file
from ha_agent_lab.policy import _load_policy_overrides, classify_entity


def _write_env(root: Path, **kwargs: str) -> None:
    save_env_file(root, kwargs)


def test_env_var_priority_over_env_file(tmp_path: Path, monkeypatch) -> None:
    _write_env(tmp_path, HOMEASSISTANT_URL="http://from-file:8123")
    monkeypatch.setenv("HOMEASSISTANT_URL", "http://from-env:8123")
    config = load_config(tmp_path)
    assert config.ha_url == "http://from-env:8123"


def test_env_file_fallback_when_env_var_absent(tmp_path: Path, monkeypatch) -> None:
    _write_env(tmp_path, HOMEASSISTANT_URL="http://from-file:8123")
    monkeypatch.delenv("HOMEASSISTANT_URL", raising=False)
    config = load_config(tmp_path)
    assert config.ha_url == "http://from-file:8123"


def test_safe_entities_override_bypasses_sensitive_domain(tmp_path: Path) -> None:
    _write_env(tmp_path, HA_SAFE_ENTITIES="cover.garage_door")
    _load_policy_overrides.cache_clear()
    sensitive, _ = classify_entity("cover.garage_door", tmp_path)
    assert not sensitive
    _load_policy_overrides.cache_clear()


def test_extra_sensitive_domains_blocks_new_domain(tmp_path: Path) -> None:
    _write_env(tmp_path, HA_EXTRA_SENSITIVE_DOMAINS="vacuum")
    _load_policy_overrides.cache_clear()
    sensitive, _ = classify_entity("vacuum.roomba", tmp_path)
    assert sensitive
    _load_policy_overrides.cache_clear()


def test_extra_sensitive_keywords_blocks_matching_entity(tmp_path: Path) -> None:
    _write_env(tmp_path, HA_EXTRA_SENSITIVE_KEYWORDS="pool")
    _load_policy_overrides.cache_clear()
    sensitive, _ = classify_entity("switch.pool_pump", tmp_path)
    assert sensitive
    _load_policy_overrides.cache_clear()
