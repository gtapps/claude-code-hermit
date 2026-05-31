from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from pathlib import Path
from unittest.mock import patch

import pytest

from ha_agent_lab.history import (
    aggregate_history,
    detect_time_patterns,
    fetch_history_snapshot,
    select_history_entities,
)


# ---------------------------------------------------------------------------
# Fixtures and helpers
# ---------------------------------------------------------------------------

_W_START = datetime(2026, 5, 1, 0, 0, 0, tzinfo=UTC)
_W_END = datetime(2026, 5, 8, 0, 0, 0, tzinfo=UTC)


def _normalized(entities: dict) -> dict:
    return {"entity_index": entities}


def _entity(state: str = "on", domain_attrs: dict | None = None) -> dict:
    return {"state": state, "attributes": domain_attrs or {}, "last_changed": "2026-05-06T12:00:00+00:00"}


def _event(state: str, last_changed: str) -> dict:
    return {"state": state, "last_changed": last_changed}


# ---------------------------------------------------------------------------
# select_history_entities
# ---------------------------------------------------------------------------

def test_select_history_entities_applies_default_scope() -> None:
    normalized = _normalized({
        "light.kitchen": _entity(),
        "switch.fan": _entity(),
        "cover.blind": _entity(),
        "climate.hvac": _entity(),
        "automation.morning": _entity(),
        "binary_sensor.motion_hall": _entity(domain_attrs={"device_class": "motion"}),
        "binary_sensor.temperature": _entity(domain_attrs={"device_class": "temperature"}),
        "sensor.power": _entity(),
    })
    result = select_history_entities(normalized)
    assert "light.kitchen" in result
    assert "switch.fan" in result
    assert "cover.blind" in result
    assert "climate.hvac" in result
    assert "automation.morning" in result
    assert "binary_sensor.motion_hall" in result
    # temperature binary_sensor excluded (wrong device_class)
    assert "binary_sensor.temperature" not in result
    # sensor excluded (not in scope)
    assert "sensor.power" not in result


def test_select_history_entities_override_bypasses_scope() -> None:
    normalized = _normalized({
        "light.kitchen": _entity(),
        "sensor.power": _entity(),
    })
    override = ["sensor.power", "sensor.energy"]
    result = select_history_entities(normalized, override=override)
    assert result == sorted(override)
    assert "light.kitchen" not in result


def test_select_history_entities_empty_entity_index_returns_empty_list() -> None:
    # Fresh-install edge case: snapshot exists but the entity_index is empty.
    # Returning [] here lets the caller surface the empty-fetch error from
    # HomeAssistantClient.get_history instead of crashing on a missing key.
    assert select_history_entities(_normalized({})) == []
    assert select_history_entities({}) == []


# ---------------------------------------------------------------------------
# aggregate_history
# ---------------------------------------------------------------------------

def test_aggregate_history_counts_events() -> None:
    history = {
        "light.kitchen": [
            _event("off", "2026-05-01T06:00:00+00:00"),
            _event("on", "2026-05-01T18:00:00+00:00"),
        ]
    }
    result = aggregate_history(history, ["light.kitchen"], window_start=_W_START, window_end=_W_END)
    assert result["light.kitchen"]["event_count"] == 2
    assert result["light.kitchen"]["returned"] is True


def test_aggregate_history_synthesizes_zero_count_row_for_requested_but_missing_entity() -> None:
    history = {"light.kitchen": [_event("on", "2026-05-01T06:00:00+00:00")]}
    result = aggregate_history(history, ["light.kitchen", "switch.fan"], window_start=_W_START, window_end=_W_END)
    fan = result["switch.fan"]
    assert fan["event_count"] == 0
    assert fan["returned"] is False
    assert fan["hour_histogram"] == [0] * 24
    assert fan["last_event_iso"] is None
    assert fan["state_durations"] == {}


def test_aggregate_history_hour_histogram_uses_utc() -> None:
    # Event at 14:00 UTC
    history = {"light.x": [_event("on", "2026-05-03T14:30:00+00:00")]}
    result = aggregate_history(history, ["light.x"], window_start=_W_START, window_end=_W_END)
    histogram = result["light.x"]["hour_histogram"]
    assert histogram[14] == 1
    assert sum(histogram) == 1


def test_aggregate_history_does_not_emit_automation_execution_fields() -> None:
    history = {
        "automation.morning": [
            _event("off", "2026-05-01T06:00:00+00:00"),
            _event("on", "2026-05-01T06:00:01+00:00"),
        ]
    }
    result = aggregate_history(history, ["automation.morning"], window_start=_W_START, window_end=_W_END)
    agg = result["automation.morning"]
    assert "last_triggered_iso" not in agg
    assert "never_fired_in_window" not in agg


def test_aggregate_history_does_not_emit_first_event_iso() -> None:
    history = {"light.x": [_event("on", "2026-05-01T06:00:00+00:00")]}
    result = aggregate_history(history, ["light.x"], window_start=_W_START, window_end=_W_END)
    assert "first_event_iso" not in result["light.x"]


def test_state_durations_sums_intervals_between_transitions() -> None:
    # light is off from 06:00, on from 07:00, off from 09:00 → on=2h, off spans rest
    history = {
        "light.x": [
            _event("off", "2026-05-01T06:00:00+00:00"),
            _event("on", "2026-05-01T07:00:00+00:00"),
            _event("off", "2026-05-01T09:00:00+00:00"),
        ]
    }
    result = aggregate_history(history, ["light.x"], window_start=_W_START, window_end=_W_END)
    durations = result["light.x"]["state_durations"]
    assert durations["on"] == 2 * 3600
    # off duration: (07:00 - 06:00) + (window_end - 09:00) = 1h + (7d - 3h exactly)
    expected_off = 1 * 3600 + int((_W_END - datetime(2026, 5, 1, 9, 0, tzinfo=UTC)).total_seconds())
    assert durations["off"] == expected_off


def test_state_durations_clips_to_window_bounds() -> None:
    # Event before window_start — span should be clipped at window_start
    history = {
        "light.x": [
            _event("on", "2026-04-30T23:00:00+00:00"),  # before window
            _event("off", "2026-05-01T01:00:00+00:00"),  # within window
        ]
    }
    result = aggregate_history(history, ["light.x"], window_start=_W_START, window_end=_W_END)
    durations = result["light.x"]["state_durations"]
    # "on" span: clipped_start = window_start (2026-05-01T00:00), end = 01:00 → 1h
    assert durations.get("on", 0) == 3600


# ---------------------------------------------------------------------------
# detect_time_patterns
# ---------------------------------------------------------------------------

def test_detect_time_patterns_finds_dominant_hour() -> None:
    histogram = [0] * 24
    histogram[9] = 6  # 60% of events at hour 9
    histogram[14] = 2
    histogram[20] = 2
    aggregates = {
        "light.kitchen": {
            "returned": True,
            "event_count": 10,
            "hour_histogram": histogram,
        }
    }
    patterns = detect_time_patterns(aggregates)
    assert len(patterns) == 1
    assert patterns[0]["entity_id"] == "light.kitchen"
    assert patterns[0]["peak_hour"] == 9
    assert patterns[0]["peak_count"] == 6


def test_detect_time_patterns_ignores_low_volume_entities() -> None:
    histogram = [0] * 24
    histogram[9] = 4  # total = 4, below threshold of 5
    aggregates = {
        "light.x": {"returned": True, "event_count": 4, "hour_histogram": histogram}
    }
    assert detect_time_patterns(aggregates) == []


def test_detect_time_patterns_skips_synthesized_zero_count_rows() -> None:
    aggregates = {
        "switch.fan": {"returned": False, "event_count": 0, "hour_histogram": [0] * 24}
    }
    assert detect_time_patterns(aggregates) == []


def test_detect_time_patterns_ignores_no_dominant_hour() -> None:
    # Evenly spread — no hour exceeds 50%
    histogram = [1] * 24
    aggregates = {
        "light.x": {"returned": True, "event_count": 24, "hour_histogram": histogram}
    }
    assert detect_time_patterns(aggregates) == []


# ---------------------------------------------------------------------------
# fetch_history_snapshot
# ---------------------------------------------------------------------------

def test_fetch_history_snapshot_artifact_has_no_raw_events_field(tmp_path: Path) -> None:
    normalized = _normalized({"light.kitchen": _entity()})
    mock_client = _make_mock_client({"light.kitchen": [_event("on", "2026-05-03T10:00:00+00:00")]})

    payload = fetch_history_snapshot(tmp_path, mock_client, normalized, window_days=1)

    assert "raw_events" not in payload
    assert "entity_aggregates" in payload
    assert "time_patterns" in payload
    assert "event_total" in payload


def test_fetch_history_snapshot_writes_per_window_artifact_with_correct_filename(tmp_path: Path) -> None:
    normalized = _normalized({"light.x": _entity()})
    mock_client = _make_mock_client({})

    fetch_history_snapshot(tmp_path, mock_client, normalized, window_days=7)

    raw = tmp_path / ".claude-code-hermit" / "raw"
    latest = raw / "snapshot-ha-history-7d-latest.json"
    assert latest.exists()
    data = json.loads(latest.read_text())
    assert data["event_total"] == 0  # no events returned


def test_fetch_history_does_not_clobber_other_window_artifact(tmp_path: Path) -> None:
    normalized = _normalized({"light.x": _entity()})
    mock_client = _make_mock_client({})

    fetch_history_snapshot(tmp_path, mock_client, normalized, window_days=7)
    fetch_history_snapshot(tmp_path, mock_client, normalized, window_days=1)

    raw = tmp_path / ".claude-code-hermit" / "raw"
    assert (raw / "snapshot-ha-history-7d-latest.json").exists()
    assert (raw / "snapshot-ha-history-1d-latest.json").exists()


# ---------------------------------------------------------------------------
# Helper
# ---------------------------------------------------------------------------

def _make_mock_client(history_data: dict) -> object:
    from unittest.mock import MagicMock
    client = MagicMock()
    client.get_history.return_value = history_data
    return client


# ---------------------------------------------------------------------------
# select_history_entities — glob expansion (added for ha-presence-report)
# ---------------------------------------------------------------------------

def test_select_history_entities_glob_expands_against_entity_index() -> None:
    normalized = _normalized({
        "person.alice": _entity("home"),
        "person.bob": _entity("away"),
        "device_tracker.alice_phone": _entity("home"),
        "light.living_room": _entity("on"),
    })
    result = select_history_entities(normalized, override=["person.*"])
    assert result == ["person.alice", "person.bob"]
    assert "light.living_room" not in result
    assert "device_tracker.alice_phone" not in result


def test_select_history_entities_multiple_globs_combined() -> None:
    normalized = _normalized({
        "person.alice": _entity("home"),
        "device_tracker.alice_phone": _entity("home"),
        "light.living_room": _entity("on"),
    })
    result = select_history_entities(normalized, override=["person.*", "device_tracker.*"])
    assert "person.alice" in result
    assert "device_tracker.alice_phone" in result
    assert "light.living_room" not in result


def test_select_history_entities_mixed_exact_and_glob_dedupes() -> None:
    normalized = _normalized({
        "person.alice": _entity("home"),
        "person.bob": _entity("away"),
    })
    # person.alice matches both the exact token and person.*
    result = select_history_entities(normalized, override=["person.alice", "person.*"])
    assert result.count("person.alice") == 1
    assert "person.bob" in result


def test_select_history_entities_nonmatching_glob_yields_empty() -> None:
    normalized = _normalized({"light.kitchen": _entity()})
    result = select_history_entities(normalized, override=["sensor.*"])
    assert result == []


def test_select_history_entities_exact_id_not_in_index_passes_through() -> None:
    # Exact IDs (no *) are still returned verbatim even if absent from entity_index
    normalized = _normalized({"light.kitchen": _entity()})
    result = select_history_entities(normalized, override=["sensor.unknown"])
    assert result == ["sensor.unknown"]


# ---------------------------------------------------------------------------
# aggregate_history — include_transitions (added for ha-presence-report)
# ---------------------------------------------------------------------------

def test_aggregate_history_transitions_omitted_by_default() -> None:
    history = {"person.alice": [
        _event("home", "2026-05-01T06:00:00+00:00"),
        _event("away", "2026-05-01T18:00:00+00:00"),
    ]}
    result = aggregate_history(history, ["person.alice"], window_start=_W_START, window_end=_W_END)
    assert "transitions" not in result["person.alice"]


def test_aggregate_history_transitions_included_when_flag_set() -> None:
    history = {"person.alice": [
        _event("home", "2026-05-01T06:00:00+00:00"),
        _event("away", "2026-05-01T18:00:00+00:00"),
        _event("home", "2026-05-02T08:00:00+00:00"),
    ]}
    result = aggregate_history(
        history, ["person.alice"],
        window_start=_W_START, window_end=_W_END,
        include_transitions=True,
    )
    transitions = result["person.alice"]["transitions"]
    states = [t["state"] for t in transitions]
    assert states == ["home", "away", "home"]
    # All entries must have a "ts" key
    assert all("ts" in t for t in transitions)


def test_aggregate_history_transitions_consecutive_duplicates_collapsed() -> None:
    # HA can emit same-state events for attribute-only updates
    history = {"person.alice": [
        _event("home", "2026-05-01T06:00:00+00:00"),
        _event("home", "2026-05-01T06:01:00+00:00"),   # duplicate — collapsed
        _event("away", "2026-05-01T18:00:00+00:00"),
        _event("away", "2026-05-01T18:01:00+00:00"),   # duplicate — collapsed
        _event("home", "2026-05-02T08:00:00+00:00"),
    ]}
    result = aggregate_history(
        history, ["person.alice"],
        window_start=_W_START, window_end=_W_END,
        include_transitions=True,
    )
    states = [t["state"] for t in result["person.alice"]["transitions"]]
    assert states == ["home", "away", "home"]


def test_aggregate_history_missing_entity_gets_empty_transitions_list() -> None:
    result = aggregate_history(
        {}, ["person.alice"],
        window_start=_W_START, window_end=_W_END,
        include_transitions=True,
    )
    assert result["person.alice"]["transitions"] == []
    assert result["person.alice"]["returned"] is False


def test_aggregate_history_include_transitions_false_regression() -> None:
    """Existing callers (ha-analyze-patterns, ha-morning-brief) must be byte-for-byte unaffected."""
    history = {"light.kitchen": [
        _event("off", "2026-05-01T06:00:00+00:00"),
        _event("on", "2026-05-01T18:00:00+00:00"),
    ]}
    result = aggregate_history(
        history, ["light.kitchen"],
        window_start=_W_START, window_end=_W_END,
        include_transitions=False,
    )
    assert "transitions" not in result["light.kitchen"]
    assert result["light.kitchen"]["event_count"] == 2
