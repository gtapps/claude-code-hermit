"""Structural lint for the /ha-automation-explorer skill.

Grep-level checks against the skill markdown. No runtime skill execution.
Guards the no-redundancy contract with ha-analyze-patterns (Mode 3 must
consume silence_summary, not re-derive from fetch-history).
"""

from pathlib import Path

import pytest

PLUGIN_ROOT = Path(__file__).parent.parent
SKILL = PLUGIN_ROOT / "skills" / "ha-automation-explorer" / "SKILL.md"


@pytest.fixture(scope="module")
def skill_text() -> str:
    return SKILL.read_text(encoding="utf-8")


def test_skill_file_exists():
    assert SKILL.exists(), "ha-automation-explorer/SKILL.md must exist"


def test_references_get_automation_config(skill_text: str):
    assert "get-automation-config" in skill_text


def test_references_silence_summary(skill_text: str):
    assert "silence_summary" in skill_text


def test_does_not_invoke_fetch_history(skill_text: str):
    # Mode 3 must NOT invoke fetch-history — that would duplicate ha-analyze-patterns'
    # silence-detection contract. Staleness comes from silence_summary only.
    # We check for the CLI invocation pattern, not the bare string (the skill may
    # mention fetch-history in a prohibition without invoking it).
    assert "ha fetch-history" not in skill_text


def test_references_entity_index(skill_text: str):
    assert "entity_index" in skill_text


def test_read_only_no_writes(skill_text: str):
    # Split on frontmatter delimiters; index 2 is the body after the closing ---.
    body = skill_text.split("---", 2)[2]
    assert "Write" not in body
    # Must not invoke the proposal-create skill (describing other skills using the
    # word "proposal" is fine — e.g. ha-analyze-patterns is "proposal-generating").
    assert "proposal-create" not in body
