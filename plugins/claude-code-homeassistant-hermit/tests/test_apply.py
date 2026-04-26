from pathlib import Path
from unittest.mock import MagicMock

import pytest

from ha_agent_lab.apply import validate_and_apply
from ha_agent_lab.ha_api import HomeAssistantError
from helpers import write_artifact

SAFE_YAML = """
alias: Safe automation
actions:
  - service: light.turn_on
    target:
      entity_id: light.living_room
""".strip()

SENSITIVE_YAML = """
alias: Unsafe automation
actions:
  - service: lock.lock
    target:
      entity_id: lock.front_door
""".strip()


@pytest.fixture
def safe_root(make_ha_root):
    return make_ha_root()


def test_sensitive_yaml_is_blocked_before_network_call(make_ha_root):
    root = make_ha_root(inventory={
        "entity_index": {
            "lock.front_door": {"entity_id": "lock.front_door", "state": "locked"},
        }
    })
    artifact = write_artifact(root, SENSITIVE_YAML)
    client = MagicMock()

    result = validate_and_apply(root, client, artifact)

    assert not result.ok
    client.post.assert_not_called()


def test_config_check_failure_returns_not_ok(safe_root: Path):
    artifact = write_artifact(safe_root, SAFE_YAML)
    client = MagicMock()
    client.post.side_effect = HomeAssistantError("connection refused")

    result = validate_and_apply(safe_root, client, artifact)

    assert not result.ok
    assert not result.reload_attempted


def test_valid_yaml_with_reload_calls_reload(safe_root: Path):
    artifact = write_artifact(safe_root, SAFE_YAML)
    client = MagicMock()
    client.post.return_value = {"result": "valid"}

    result = validate_and_apply(safe_root, client, artifact, reload_domain="automation")

    assert result.ok
    assert result.reload_attempted
    client.post.assert_any_call("/api/services/automation/reload", {})


def test_invalid_reload_domain_is_blocked(safe_root: Path):
    artifact = write_artifact(safe_root, SAFE_YAML)
    client = MagicMock()
    client.post.return_value = {"result": "valid"}

    result = validate_and_apply(safe_root, client, artifact, reload_domain="shell_command")

    assert not result.ok
    assert not result.reload_attempted
    assert result.message == "reload-blocked"


def test_valid_yaml_no_reload(safe_root: Path):
    artifact = write_artifact(safe_root, SAFE_YAML)
    client = MagicMock()
    client.post.return_value = True

    result = validate_and_apply(safe_root, client, artifact)

    assert result.ok
    assert not result.reload_attempted
