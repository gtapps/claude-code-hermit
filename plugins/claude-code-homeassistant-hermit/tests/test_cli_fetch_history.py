"""Tests for the 'ha fetch-history' CLI subcommand."""
from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from ha_agent_lab.cli import main


def _make_normalized(root: Path, entities: dict | None = None) -> Path:
    raw = root / ".claude-code-hermit" / "raw"
    raw.mkdir(parents=True, exist_ok=True)
    payload = {"entity_index": entities or {"light.kitchen": {"state": "on", "attributes": {}}}}
    path = raw / "snapshot-ha-normalized-latest.json"
    path.write_text(json.dumps(payload), encoding="utf-8")
    return path


def _mock_client(history_data: dict) -> MagicMock:
    client = MagicMock()
    client.get_history.return_value = history_data
    return client


def test_fetch_history_writes_per_window_artifact_with_correct_filename(make_mock_config, capsys) -> None:
    cfg = make_mock_config()
    _make_normalized(cfg.root)

    with patch("ha_agent_lab.cli.load_config", return_value=cfg), \
         patch("ha_agent_lab.cli.HomeAssistantClient", return_value=_mock_client({})):
        result = main(["ha", "fetch-history", "--window-days", "7"])

    assert result == 0
    assert (cfg.root / ".claude-code-hermit" / "raw" / "snapshot-ha-history-7d-latest.json").exists()
    captured = capsys.readouterr()
    out = json.loads(captured.out)
    assert out["status"] == "ok"
    assert out["window_days"] == 7


def test_fetch_history_does_not_clobber_other_window_artifact(make_mock_config) -> None:
    cfg = make_mock_config()
    _make_normalized(cfg.root)

    with patch("ha_agent_lab.cli.load_config", return_value=cfg), \
         patch("ha_agent_lab.cli.HomeAssistantClient", return_value=_mock_client({})):
        main(["ha", "fetch-history", "--window-days", "7"])
        main(["ha", "fetch-history", "--window-days", "1"])

    raw = cfg.root / ".claude-code-hermit" / "raw"
    assert (raw / "snapshot-ha-history-7d-latest.json").exists()
    assert (raw / "snapshot-ha-history-1d-latest.json").exists()
    # Verify the two artifacts carry different window_days metadata
    d7 = json.loads((raw / "snapshot-ha-history-7d-latest.json").read_text())
    d1 = json.loads((raw / "snapshot-ha-history-1d-latest.json").read_text())
    # Both should exist and differ in their window spans
    assert d7["window_start"] != d1["window_start"]


def test_fetch_history_include_transitions_flag_writes_transitions_field(make_mock_config) -> None:
    cfg = make_mock_config()
    _make_normalized(cfg.root, {"person.alice": {"state": "home", "attributes": {}}})
    history_data = {
        "person.alice": [
            {"state": "home", "last_changed": "2026-05-01T06:00:00+00:00"},
            {"state": "away", "last_changed": "2026-05-01T18:00:00+00:00"},
        ]
    }

    with patch("ha_agent_lab.cli.load_config", return_value=cfg), \
         patch("ha_agent_lab.cli.HomeAssistantClient", return_value=_mock_client(history_data)):
        result = main(["ha", "fetch-history", "--entities", "person.*", "--include-transitions"])

    assert result == 0
    artifact = cfg.root / ".claude-code-hermit" / "raw" / "snapshot-ha-history-7d-latest.json"
    data = json.loads(artifact.read_text())
    agg = data["entity_aggregates"]["person.alice"]
    assert "transitions" in agg
    states = [t["state"] for t in agg["transitions"]]
    assert states == ["home", "away"]


def test_fetch_history_without_flag_omits_transitions_field(make_mock_config) -> None:
    cfg = make_mock_config()
    _make_normalized(cfg.root, {"person.alice": {"state": "home", "attributes": {}}})
    history_data = {
        "person.alice": [{"state": "home", "last_changed": "2026-05-01T06:00:00+00:00"}]
    }

    with patch("ha_agent_lab.cli.load_config", return_value=cfg), \
         patch("ha_agent_lab.cli.HomeAssistantClient", return_value=_mock_client(history_data)):
        main(["ha", "fetch-history", "--entities", "person.*"])

    artifact = cfg.root / ".claude-code-hermit" / "raw" / "snapshot-ha-history-7d-latest.json"
    data = json.loads(artifact.read_text())
    assert "transitions" not in data["entity_aggregates"]["person.alice"]


def test_fetch_history_glob_entities_expand_against_snapshot(make_mock_config, capsys) -> None:
    cfg = make_mock_config()
    _make_normalized(cfg.root, {
        "person.alice": {"state": "home", "attributes": {}},
        "person.bob": {"state": "away", "attributes": {}},
        "light.kitchen": {"state": "on", "attributes": {}},
    })

    with patch("ha_agent_lab.cli.load_config", return_value=cfg), \
         patch("ha_agent_lab.cli.HomeAssistantClient", return_value=_mock_client({})):
        result = main(["ha", "fetch-history", "--entities", "person.*"])

    assert result == 0
    artifact = cfg.root / ".claude-code-hermit" / "raw" / "snapshot-ha-history-7d-latest.json"
    data = json.loads(artifact.read_text())
    requested = data["requested_entities"]
    assert "person.alice" in requested
    assert "person.bob" in requested
    assert "light.kitchen" not in requested
