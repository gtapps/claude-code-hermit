import json
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from ha_agent_lab.integration_health import (
    compute_degraded_domains,
    format_integration_health_stdout,
    write_degraded_domains_artifact,
)


def _normalized(entity_index: dict, unavailable: list[str] | None = None) -> dict:
    return {"entity_index": entity_index, "unavailable_entities": unavailable or []}


def _make_entities(domain: str, n: int, unavail: int) -> tuple[dict, list[str]]:
    idx = {f"{domain}.e{i}": {"entity_id": f"{domain}.e{i}", "state": "unavailable" if i < unavail else "ok"} for i in range(n)}
    unavail_list = [f"{domain}.e{i}" for i in range(unavail)]
    return idx, unavail_list


def test_degraded_domains_flags_domain_over_thresholds():
    idx, unavail = _make_entities("sensor", 6, 5)
    result = compute_degraded_domains(_normalized(idx, unavail))
    domains = [d["domain"] for d in result["degraded_entity_domains"]]
    assert "sensor" in domains
    entry = result["degraded_entity_domains"][0]
    assert entry["total"] == 6
    assert entry["unavailable"] == 5
    assert entry["ratio"] == round(5 / 6, 4)


def test_degraded_domains_ignores_small_domains_under_min_total():
    idx, unavail = _make_entities("lock", 2, 2)
    result = compute_degraded_domains(_normalized(idx, unavail))
    assert result["degraded_entity_domains"] == []


def test_degraded_domains_ignores_healthy_domains_under_min_ratio():
    idx, unavail = _make_entities("light", 10, 1)
    result = compute_degraded_domains(_normalized(idx, unavail))
    assert result["degraded_entity_domains"] == []


def test_degraded_domains_payload_deterministic_sort():
    idx_a, ua = _make_entities("sensor", 4, 4)
    idx_b, ub = _make_entities("binary_sensor", 4, 4)
    normalized = _normalized({**idx_a, **idx_b}, ua + ub)
    result1 = compute_degraded_domains(normalized)
    result2 = compute_degraded_domains(normalized)
    assert result1["degraded_entity_domains"] == result2["degraded_entity_domains"]
    assert result1["degraded_entity_domains"][0]["domain"] == "binary_sensor"
    assert result1["degraded_entity_domains"][1]["domain"] == "sensor"


def test_degraded_domains_artifact_written_to_state_path(tmp_path: Path):
    idx, unavail = _make_entities("sensor", 4, 3)
    payload = compute_degraded_domains(_normalized(idx, unavail))
    path = write_degraded_domains_artifact(tmp_path, payload)
    assert path == tmp_path / ".claude-code-hermit" / "state" / "integration-health-degraded-domains.json"
    assert path.exists()
    loaded = json.loads(path.read_text())
    assert "degraded_entity_domains" in loaded
    assert "computed_at" in loaded


def test_format_stdout_with_degraded():
    payload = {
        "degraded_entity_domains": [{"domain": "sensor", "total": 15, "unavailable": 12, "ratio": 0.8}],
        "scanned_domains": 8,
    }
    out = format_integration_health_stdout(payload, "2026-05-14")
    assert out.startswith("ha-integration-health findings — 2026-05-14")
    assert "Degraded domains: 1" in out
    assert "sensor: 12/15" in out
    assert "80.0%" in out


def test_format_stdout_no_degraded():
    payload = {"degraded_entity_domains": [], "scanned_domains": 5}
    out = format_integration_health_stdout(payload, "2026-05-14")
    assert "No actionable findings." in out
    assert "5 domains scanned" in out


def test_cli_integration_health_emits_existing_stdout_shape(tmp_path: Path, capsys):
    from ha_agent_lab.cli import _handle_integration_health

    raw = tmp_path / ".claude-code-hermit" / "raw"
    raw.mkdir(parents=True)
    idx, unavail = _make_entities("sensor", 6, 4)
    snapshot = {"entity_index": idx, "unavailable_entities": unavail}
    (raw / "snapshot-ha-normalized-latest.json").write_text(json.dumps(snapshot), encoding="utf-8")

    rc = _handle_integration_health(tmp_path, object())
    out = capsys.readouterr().out
    assert rc == 0
    assert out.startswith("ha-integration-health findings —")
    assert "Degraded domains:" in out


def _setup_refresh_monkeypatch(monkeypatch, cli_mod, snapshot_path: Path) -> None:
    idx, unavail = _make_entities("sensor", 6, 4)
    fresh = {"entity_index": idx, "unavailable_entities": unavail}

    def fake_refresh(root, client):
        snapshot_path.parent.mkdir(parents=True, exist_ok=True)
        snapshot_path.write_text(json.dumps(fresh), encoding="utf-8")

    monkeypatch.setattr(cli_mod, "refresh_context", fake_refresh)
    monkeypatch.setattr(cli_mod, "HomeAssistantClient", lambda config: object())


def test_cli_integration_health_refreshes_and_proceeds_when_snapshot_missing(tmp_path: Path, capsys, monkeypatch):
    import ha_agent_lab.cli as cli_mod
    from ha_agent_lab.cli import _handle_integration_health

    snapshot_path = tmp_path / ".claude-code-hermit" / "raw" / "snapshot-ha-normalized-latest.json"
    _setup_refresh_monkeypatch(monkeypatch, cli_mod, snapshot_path)

    rc = _handle_integration_health(tmp_path, object())
    out = capsys.readouterr().out
    assert rc == 0
    assert "skipped" not in out
    assert "Degraded domains:" in out


def test_cli_integration_health_refreshes_and_proceeds_when_snapshot_stale(tmp_path: Path, capsys, monkeypatch):
    import os
    import ha_agent_lab.cli as cli_mod
    from ha_agent_lab.cli import _handle_integration_health

    raw = tmp_path / ".claude-code-hermit" / "raw"
    raw.mkdir(parents=True)
    snapshot_path = raw / "snapshot-ha-normalized-latest.json"
    snapshot_path.write_text("{}", encoding="utf-8")
    stale_time = (datetime.now(UTC) - timedelta(hours=25)).timestamp()
    os.utime(snapshot_path, (stale_time, stale_time))
    _setup_refresh_monkeypatch(monkeypatch, cli_mod, snapshot_path)

    rc = _handle_integration_health(tmp_path, object())
    out = capsys.readouterr().out
    assert rc == 0
    assert "skipped" not in out
    assert "Degraded domains:" in out


def test_cli_integration_health_skips_cleanly_when_refresh_fails(tmp_path: Path, capsys, monkeypatch):
    import ha_agent_lab.cli as cli_mod
    from ha_agent_lab.cli import _handle_integration_health
    from ha_agent_lab.ha_api import HomeAssistantError

    def fail_refresh(root, client):
        raise HomeAssistantError("HA unreachable")

    monkeypatch.setattr(cli_mod, "HomeAssistantClient", lambda config: object())
    monkeypatch.setattr(cli_mod, "refresh_context", fail_refresh)

    rc = _handle_integration_health(tmp_path, object())
    out = capsys.readouterr().out
    assert rc == 0
    assert "refresh failed" in out


def test_cli_integration_health_refreshes_when_stat_raises_oserror(tmp_path: Path, capsys, monkeypatch):
    import ha_agent_lab.cli as cli_mod
    from ha_agent_lab.cli import _handle_integration_health

    snapshot_path = tmp_path / ".claude-code-hermit" / "raw" / "snapshot-ha-normalized-latest.json"
    _setup_refresh_monkeypatch(monkeypatch, cli_mod, snapshot_path)

    real_stat = Path.stat

    def boom_stat(self, *args, **kwargs):
        if self == snapshot_path:
            raise PermissionError("stat denied")
        return real_stat(self, *args, **kwargs)

    monkeypatch.setattr(Path, "stat", boom_stat)

    rc = _handle_integration_health(tmp_path, object())
    out = capsys.readouterr().out
    assert rc == 0
    assert "skipped" not in out
    assert "Degraded domains:" in out
