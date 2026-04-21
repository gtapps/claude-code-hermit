from __future__ import annotations

import json
from pathlib import Path

from ha_agent_lab.audits import audit_automations, review_automation_errors


class FakeClient:
    def __init__(self, responses: dict[str, object]) -> None:
        self._responses = responses
        self.calls: list[str] = []

    def get(self, path: str) -> object:
        self.calls.append(path)
        if path not in self._responses:
            raise KeyError(f"unexpected path: {path}")
        return self._responses[path]


def test_audit_automations_flags_sensitive_references(tmp_path: Path) -> None:
    (tmp_path / ".claude-code-hermit" / "raw").mkdir(parents=True)
    automations = [
        {
            "id": "safe_kitchen",
            "alias": "Kitchen motion light",
            "trigger": [{"platform": "state", "entity_id": "binary_sensor.kitchen_motion"}],
            "action": [{"service": "light.turn_on", "target": {"entity_id": "light.kitchen"}}],
        },
        {
            "id": "garage_auto_close",
            "alias": "Close garage at night",
            "trigger": [{"platform": "time", "at": "23:00:00"}],
            "action": [{"service": "cover.close_cover", "target": {"entity_id": "cover.garage_door"}}],
        },
    ]
    client = FakeClient({"/api/config/automation/config": automations})

    summary = audit_automations(tmp_path, client)

    assert summary["total_automations"] == 2
    assert summary["passed"] == 1
    assert len(summary["violations"]) == 1
    violation = summary["violations"][0]
    assert violation["id"] == "garage_auto_close"
    assert any("garage_door" in r for r in violation["reasons"])

    latest = tmp_path / ".claude-code-hermit" / "raw" / "audit-ha-safety-latest.json"
    assert latest.exists()
    persisted = json.loads(latest.read_text(encoding="utf-8"))
    assert persisted["violations"] == summary["violations"]


def test_audit_automations_no_violations(tmp_path: Path) -> None:
    (tmp_path / ".claude-code-hermit" / "raw").mkdir(parents=True)
    automations = [
        {
            "id": "bedtime_dim",
            "alias": "Dim bedroom at bedtime",
            "action": [{"service": "light.turn_on", "target": {"entity_id": "light.bedroom"}}],
        }
    ]
    client = FakeClient({"/api/config/automation/config": automations})

    summary = audit_automations(tmp_path, client)

    assert summary["total_automations"] == 1
    assert summary["violations"] == []
    assert summary["passed"] == 1


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
