from pathlib import Path

import pytest

from ha_agent_lab.cli import main
from ha_agent_lab.policy import (
    Severity,
    can_reload_domain,
    check_entity,
    classify_entity,
    evaluate_references,
    is_sensitive_entity,
    safety_mode,
)


def test_sensitive_entity_detection() -> None:
    assert is_sensitive_entity("lock.front_door")
    assert is_sensitive_entity("cover.garage_door")
    assert not is_sensitive_entity("light.kitchen_counter")


def test_policy_blocks_sensitive_references() -> None:
    decision = evaluate_references(
        ["light.kitchen", "cover.garage_door"],
        ["light.turn_on", "lock.unlock"],
    )
    assert decision.blocked
    assert len(decision.reasons) == 2


def test_reload_allowlist() -> None:
    assert can_reload_domain("automation")
    assert not can_reload_domain("light")


def test_check_entity_sensitive() -> None:
    result = check_entity("lock.front_door")
    assert result["sensitive"] is True
    assert result["entity_id"] == "lock.front_door"
    assert len(result["reasons"]) > 0


def test_check_entity_safe() -> None:
    result = check_entity("light.kitchen")
    assert result["sensitive"] is False
    assert result["reasons"] == []


def test_check_entity_conditional() -> None:
    result = check_entity("cover.garage_door")
    assert result["sensitive"] is True
    assert "garage" in result["reasons"][0].lower()


def test_policy_check_cli_entity(capsys) -> None:
    exit_code = main(["ha", "policy-check", "light.kitchen"])
    assert exit_code == 0
    captured = capsys.readouterr()
    assert '"sensitive": false' in captured.out


def test_policy_check_cli_sensitive_entity(capsys) -> None:
    exit_code = main(["ha", "policy-check", "lock.front_door"])
    assert exit_code == 1
    captured = capsys.readouterr()
    assert '"sensitive": true' in captured.out


def test_safe_entity_override(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    (tmp_path / ".env").write_text("HA_SAFE_ENTITIES=lock.test_door,cover.main_gate\n")
    monkeypatch.chdir(tmp_path)
    assert not is_sensitive_entity("lock.test_door")
    assert not is_sensitive_entity("cover.main_gate")
    assert is_sensitive_entity("lock.other_door")  # no regression on unlisted entities


def test_extra_sensitive_domain(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    (tmp_path / ".env").write_text("HA_EXTRA_SENSITIVE_DOMAINS=vacuum\n")
    monkeypatch.chdir(tmp_path)
    assert is_sensitive_entity("vacuum.roomba")
    assert not is_sensitive_entity("light.kitchen")  # no regression


def test_extra_sensitive_keyword(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    (tmp_path / ".env").write_text("HA_EXTRA_SENSITIVE_KEYWORDS=pool\n")
    monkeypatch.chdir(tmp_path)
    assert is_sensitive_entity("switch.pool_pump")
    assert not is_sensitive_entity("switch.living_room")  # no regression


def test_safety_mode_defaults_to_strict(tmp_path: Path) -> None:
    assert safety_mode(tmp_path) == "strict"


def test_safety_mode_reads_ask_from_config(make_ha_config) -> None:
    root = make_ha_config("ask")
    assert safety_mode(root) == "ask"


def test_safety_mode_invalid_value_defaults_to_strict(make_ha_config) -> None:
    root = make_ha_config("bogus")
    assert safety_mode(root) == "strict"


def test_safety_mode_permissive_no_longer_valid(make_ha_config) -> None:
    """`permissive` was removed in favour of two-tier strict/ask. Falls back to strict."""
    root = make_ha_config("permissive")
    assert safety_mode(root) == "strict"


def test_classify_strict_blocks_sensitive(make_ha_config) -> None:
    root = make_ha_config("strict")
    sev, reasons = classify_entity("alarm_control_panel.home", root=root)
    assert sev == Severity.BLOCK
    assert reasons


def test_classify_ask_returns_ask_severity(make_ha_config) -> None:
    root = make_ha_config("ask")
    sev, reasons = classify_entity("alarm_control_panel.home", root=root)
    assert sev == Severity.ASK
    assert reasons


def test_classify_ask_on_conditional_sensitive(make_ha_config) -> None:
    root = make_ha_config("ask")
    sev, _ = classify_entity("cover.garage_door", root=root)
    assert sev == Severity.ASK


def test_safe_entity_allowlist_wins_over_strict(make_ha_config, monkeypatch: pytest.MonkeyPatch) -> None:
    root = make_ha_config("strict")
    (root / ".env").write_text("HA_SAFE_ENTITIES=alarm_control_panel.home\n")
    monkeypatch.chdir(root)
    sev, _ = classify_entity("alarm_control_panel.home", root=root)
    assert sev == Severity.ALLOW


def test_evaluate_references_severity_field(make_ha_config) -> None:
    root = make_ha_config("ask")
    decision = evaluate_references(["alarm_control_panel.home"], [], root=root)
    assert decision.severity == Severity.ASK
    assert not decision.blocked


def test_check_entity_includes_severity() -> None:
    result = check_entity("light.kitchen")
    assert "severity" in result
    assert result["severity"] == "allow"


def test_policy_check_cli_yaml_file(tmp_path: Path, capsys) -> None:
    yaml_content = """
automation:
  - alias: "Test"
    action:
      - service: light.turn_on
        target:
          entity_id: light.kitchen
      - service: lock.unlock
        target:
          entity_id: lock.front_door
"""
    artifact = tmp_path / "test.yaml"
    artifact.write_text(yaml_content, encoding="utf-8")
    exit_code = main(["ha", "policy-check", str(artifact)])
    assert exit_code == 1
    captured = capsys.readouterr()
    assert '"blocked": true' in captured.out
    assert "lock.front_door" in captured.out
