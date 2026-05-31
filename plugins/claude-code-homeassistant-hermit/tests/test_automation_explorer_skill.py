"""Structural lint for the /ha-automation-explorer skill.

Grep-level checks against the skill markdown. No runtime skill execution.
Guards the CLI and snapshot contract the skill depends on against drift.
Mirrors the test_hatch_skill.py pattern.
"""

from pathlib import Path

import pytest

PLUGIN_ROOT = Path(__file__).parent.parent
SKILL = PLUGIN_ROOT / "skills" / "ha-automation-explorer" / "SKILL.md"


@pytest.fixture(scope="module")
def skill_text() -> str:
    return SKILL.read_text(encoding="utf-8")


def test_references_list_automations_cli(skill_text: str):
    assert "ha list-automations" in skill_text


def test_references_get_automation_config_cli(skill_text: str):
    assert "ha get-automation-config" in skill_text


def test_references_normalized_snapshot(skill_text: str):
    assert "snapshot-ha-normalized-latest.json" in skill_text


def test_documents_all_three_modes(skill_text: str):
    assert "--last-fired" in skill_text
    assert "Mode 1" in skill_text
    assert "Mode 2" in skill_text
    assert "Mode 3" in skill_text


def test_reads_silence_summary_dead_automations(skill_text: str):
    assert "silence_summary" in skill_text
    assert "dead_automations" in skill_text


def test_reads_entity_index_for_last_fired(skill_text: str):
    assert "entity_index" in skill_text


def test_refers_refresh_context_on_missing_snapshot(skill_text: str):
    assert "ha-refresh-context" in skill_text
