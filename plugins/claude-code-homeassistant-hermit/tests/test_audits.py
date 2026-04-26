from __future__ import annotations

import json
import pytest
from pathlib import Path

from ha_agent_lab.audits import audit_automations, review_automation_errors
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


def test_review_automation_errors_flags_recurring(tmp_path: Path) -> None:
    (tmp_path / ".claude-code-hermit" / "raw").mkdir(parents=True)
    log = "\n".join(
        [
            "2026-04-20 09:00:01 ERROR Failed to call service in automation.broken_flow",
            "2026-04-20 09:05:02 ERROR automation.broken_flow: timeout waiting for light",
            "2026-04-20 09:10:03 ERROR Error running automation.broken_flow step 2",
            "2026-04-20 10:00:00 INFO automation.ok_flow triggered by state",
            "2026-04-20 11:00:00 ERROR automation.transient_flow: error in condition",
        ]
    )
    client = FakeClient({"/api/error_log": log})

    summary = review_automation_errors(tmp_path, client, min_hits=3)

    assert summary["min_hits"] == 3
    flagged_ids = [item["entity_id"] for item in summary["flagged_automations"]]
    assert flagged_ids == ["automation.broken_flow"]
    assert summary["flagged_automations"][0]["count"] == 3


def test_review_automation_errors_empty_log(tmp_path: Path) -> None:
    (tmp_path / ".claude-code-hermit" / "raw").mkdir(parents=True)
    client = FakeClient({"/api/error_log": ""})

    summary = review_automation_errors(tmp_path, client)

    assert summary["flagged_automations"] == []
    assert summary["total_lines_scanned"] == 0
