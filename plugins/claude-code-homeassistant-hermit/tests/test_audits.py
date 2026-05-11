from __future__ import annotations

import json
import pytest
from pathlib import Path

from ha_agent_lab.audits import audit_automations
from ha_agent_lab.ha_api import HomeAssistantError


class FakeClient:
    def __init__(self, responses: dict[str, object]) -> None:
        self._responses = responses
        self.calls: list[str] = []

    def get(self, path: str) -> object:
        self.calls.append(path)
        if path not in self._responses:
            raise KeyError(f"unexpected path: {path}")
        value = self._responses[path]
        if isinstance(value, Exception):
            raise value
        return value

    def get_states(self) -> object:
        return self.get("/api/states")


def _make_state(entity_id: str, auto_id: str | None) -> dict:
    attrs = {"id": auto_id} if auto_id is not None else {}
    return {"entity_id": entity_id, "state": "on", "attributes": attrs}


def test_audit_automations_flags_sensitive_references(tmp_path: Path) -> None:
    (tmp_path / ".claude-code-hermit" / "raw").mkdir(parents=True)
    configs = {
        "safe_kitchen": {
            "id": "safe_kitchen",
            "alias": "Kitchen motion light",
            "trigger": [{"platform": "state", "entity_id": "binary_sensor.kitchen_motion"}],
            "action": [{"service": "light.turn_on", "target": {"entity_id": "light.kitchen"}}],
        },
        "garage_auto_close": {
            "id": "garage_auto_close",
            "alias": "Close garage at night",
            "trigger": [{"platform": "time", "at": "23:00:00"}],
            "action": [{"service": "cover.close_cover", "target": {"entity_id": "cover.garage_door"}}],
        },
    }
    states = [
        _make_state("automation.safe_kitchen", "safe_kitchen"),
        _make_state("automation.garage_auto_close", "garage_auto_close"),
    ]
    responses: dict[str, object] = {
        "/api/states": states,
        "/api/config/automation/config/safe_kitchen": configs["safe_kitchen"],
        "/api/config/automation/config/garage_auto_close": configs["garage_auto_close"],
    }
    client = FakeClient(responses)

    summary = audit_automations(tmp_path, client)

    assert summary["total_automations"] == 2
    assert summary["passed"] == 1
    assert len(summary["violations"]) == 1
    assert summary["unmanaged"] == []
    assert summary["fetch_failures"] == []
    violation = summary["violations"][0]
    assert violation["id"] == "garage_auto_close"
    assert any("garage_door" in r for r in violation["reasons"])

    latest = tmp_path / ".claude-code-hermit" / "raw" / "audit-ha-safety-latest.json"
    assert latest.exists()
    persisted = json.loads(latest.read_text(encoding="utf-8"))
    assert persisted["violations"] == summary["violations"]


def test_audit_automations_no_violations(tmp_path: Path) -> None:
    (tmp_path / ".claude-code-hermit" / "raw").mkdir(parents=True)
    config = {
        "id": "bedtime_dim",
        "alias": "Dim bedroom at bedtime",
        "action": [{"service": "light.turn_on", "target": {"entity_id": "light.bedroom"}}],
    }
    states = [_make_state("automation.bedtime_dim", "bedtime_dim")]
    responses: dict[str, object] = {
        "/api/states": states,
        "/api/config/automation/config/bedtime_dim": config,
    }
    client = FakeClient(responses)

    summary = audit_automations(tmp_path, client)

    assert summary["total_automations"] == 1
    assert summary["violations"] == []
    assert summary["passed"] == 1
    assert summary["unmanaged"] == []
    assert summary["fetch_failures"] == []


def test_audit_automations_handles_unmanaged_and_fetch_failures(tmp_path: Path) -> None:
    (tmp_path / ".claude-code-hermit" / "raw").mkdir(parents=True)
    states = [
        _make_state("automation.yaml_only", None),       # no numeric id — unmanaged
        _make_state("automation.missing_config", "999"),  # 404 on config fetch
    ]
    responses: dict[str, object] = {
        "/api/states": states,
        "/api/config/automation/config/999": HomeAssistantError(message="not found", status_code=404),
    }
    client = FakeClient(responses)

    summary = audit_automations(tmp_path, client)

    assert summary["total_automations"] == 2
    assert summary["unmanaged"] == ["automation.yaml_only"]
    assert summary["fetch_failures"] == ["999"]
    assert summary["violations"] == []
    # invariant: passed + violations + unmanaged + fetch_failures == total
    assert summary["passed"] + len(summary["violations"]) + len(summary["unmanaged"]) + len(summary["fetch_failures"]) == summary["total_automations"]


def _write_acknowledged(root: Path, content: str) -> None:
    compiled = root / ".claude-code-hermit" / "compiled"
    compiled.mkdir(parents=True, exist_ok=True)
    (compiled / "acknowledged-violations.md").write_text(content, encoding="utf-8")


def _alarm_arm_fixture() -> tuple[dict, list[dict]]:
    config = {
        "id": "realiza_apos_armar_alarme",
        "alias": "After-arm follow-up",
        "trigger": [{"platform": "state", "entity_id": "alarm_control_panel.casa"}],
        "action": [{"service": "scene.turn_on", "target": {"entity_id": "scene.away"}}],
    }
    states = [_make_state("automation.realiza_apos_armar_alarme", "realiza_apos_armar_alarme")]
    return config, states


def test_audit_acknowledged_missing_file_no_suppression(tmp_path: Path) -> None:
    (tmp_path / ".claude-code-hermit" / "raw").mkdir(parents=True)
    config, states = _alarm_arm_fixture()
    responses: dict[str, object] = {
        "/api/states": states,
        "/api/config/automation/config/realiza_apos_armar_alarme": config,
    }
    client = FakeClient(responses)

    summary = audit_automations(tmp_path, client)

    assert len(summary["violations"]) == 1
    assert summary["acknowledged"] == []


def test_audit_acknowledged_malformed_file_no_suppression(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    (tmp_path / ".claude-code-hermit" / "raw").mkdir(parents=True)
    _write_acknowledged(tmp_path, "no frontmatter at all, just text")
    config, states = _alarm_arm_fixture()
    responses: dict[str, object] = {
        "/api/states": states,
        "/api/config/automation/config/realiza_apos_armar_alarme": config,
    }
    client = FakeClient(responses)

    summary = audit_automations(tmp_path, client)

    assert len(summary["violations"]) == 1
    assert summary["acknowledged"] == []


def test_audit_acknowledged_subset_suppresses_alarm_bypass(tmp_path: Path, make_ha_config) -> None:
    make_ha_config("strict")
    (tmp_path / ".claude-code-hermit" / "raw").mkdir(parents=True)
    _write_acknowledged(
        tmp_path,
        "---\n"
        "title: Acknowledged\n"
        "type: acknowledged-violations\n"
        "automation_ids: [realiza_apos_armar_alarme]\n"
        "---\n\n"
        "## Rationale\n\n"
        "- `realiza_apos_armar_alarme`: refs=[alarm_control_panel.casa]; runs after arming\n",
    )
    config, states = _alarm_arm_fixture()
    responses: dict[str, object] = {
        "/api/states": states,
        "/api/config/automation/config/realiza_apos_armar_alarme": config,
    }
    client = FakeClient(responses)

    summary = audit_automations(tmp_path, client)

    assert summary["violations"] == []
    assert len(summary["acknowledged"]) == 1
    entry = summary["acknowledged"][0]
    assert entry["id"] == "realiza_apos_armar_alarme"
    assert "runs after arming" in entry["quoted_line"]
    assert entry["source"] == "compiled/acknowledged-violations.md"
    assert summary["passed"] == 0  # the only automation moved to acknowledged


def test_audit_acknowledged_drift_re_surfaces(tmp_path: Path, make_ha_config) -> None:
    make_ha_config("strict")
    (tmp_path / ".claude-code-hermit" / "raw").mkdir(parents=True)
    _write_acknowledged(
        tmp_path,
        "---\n"
        "title: Acknowledged\n"
        "type: acknowledged-violations\n"
        "automation_ids: [realiza_apos_armar_alarme]\n"
        "---\n\n"
        "## Rationale\n\n"
        "- `realiza_apos_armar_alarme`: refs=[alarm_control_panel.casa]; runs after arming\n",
    )
    # Drift: automation now also references lock.front_door, outside the acknowledged refs.
    config = {
        "id": "realiza_apos_armar_alarme",
        "alias": "After-arm follow-up",
        "trigger": [{"platform": "state", "entity_id": "alarm_control_panel.casa"}],
        "action": [{"service": "lock.unlock", "target": {"entity_id": "lock.front_door"}}],
    }
    states = [_make_state("automation.realiza_apos_armar_alarme", "realiza_apos_armar_alarme")]
    responses: dict[str, object] = {
        "/api/states": states,
        "/api/config/automation/config/realiza_apos_armar_alarme": config,
    }
    client = FakeClient(responses)

    summary = audit_automations(tmp_path, client)

    assert summary["acknowledged"] == []
    assert len(summary["violations"]) == 1
    assert summary["violations"][0]["id"] == "realiza_apos_armar_alarme"


def test_audit_acknowledged_unparseable_bullet_emits_stderr(
    tmp_path: Path, capsys: pytest.CaptureFixture[str], make_ha_config
) -> None:
    """Bullets that look like rationale lines but don't match the format hit stderr."""
    make_ha_config("strict")
    (tmp_path / ".claude-code-hermit" / "raw").mkdir(parents=True)
    _write_acknowledged(
        tmp_path,
        "---\n"
        "title: Acknowledged\n"
        "type: acknowledged-violations\n"
        "automation_ids: [realiza_apos_armar_alarme]\n"
        "---\n\n"
        "## Rationale\n\n"
        # Missing trailing rationale text after `;`
        "- `realiza_apos_armar_alarme`: refs=[alarm_control_panel.casa]; \n",
    )
    config, states = _alarm_arm_fixture()
    responses: dict[str, object] = {
        "/api/states": states,
        "/api/config/automation/config/realiza_apos_armar_alarme": config,
    }
    client = FakeClient(responses)

    summary = audit_automations(tmp_path, client)
    captured = capsys.readouterr()

    # Bullet did not parse → no suppression
    assert summary["acknowledged"] == []
    assert len(summary["violations"]) == 1
    # Stderr breadcrumb fired
    assert "unparseable rationale bullet" in captured.err
    assert "realiza_apos_armar_alarme" in captured.err


def test_audit_acknowledged_frontmatter_only_does_not_suppress(tmp_path: Path) -> None:
    (tmp_path / ".claude-code-hermit" / "raw").mkdir(parents=True)
    _write_acknowledged(
        tmp_path,
        "---\n"
        "title: Acknowledged\n"
        "type: acknowledged-violations\n"
        "automation_ids: [realiza_apos_armar_alarme]\n"
        "---\n\n"
        "## Rationale\n\n(no bullets)\n",
    )
    config, states = _alarm_arm_fixture()
    responses: dict[str, object] = {
        "/api/states": states,
        "/api/config/automation/config/realiza_apos_armar_alarme": config,
    }
    client = FakeClient(responses)

    summary = audit_automations(tmp_path, client)

    # frontmatter-only id has empty refs → subset check against {alarm_control_panel.casa} fails → no suppression.
    assert len(summary["violations"]) == 1
    assert summary["acknowledged"] == []


def test_audit_automations_propagates_unexpected_errors(tmp_path: Path) -> None:
    (tmp_path / ".claude-code-hermit" / "raw").mkdir(parents=True)
    states = [_make_state("automation.broken", "broken_id")]
    responses: dict[str, object] = {
        "/api/states": states,
        "/api/config/automation/config/broken_id": HomeAssistantError(message="server error", status_code=500),
    }
    client = FakeClient(responses)

    with pytest.raises(HomeAssistantError) as exc_info:
        audit_automations(tmp_path, client)

    assert exc_info.value.status_code == 500
