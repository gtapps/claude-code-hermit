"""Structural lint for the /domain-brainstorm skill.

Grep-level checks against the skill markdown. No runtime skill execution.
Mirrors the dev-hermit skill-structure.test.js pattern, adapted for ha-hermit pytest.
Guards:
  - 5-gate structure (Gate 0..4)
  - contract references (Evidence Source, category, metrics emit with per-plugin skill name)
  - boundary: suppression artifacts appear under a suppression framing, not as idea sources
"""

import re
from pathlib import Path

import pytest

PLUGIN_ROOT = Path(__file__).parent.parent
SKILL = PLUGIN_ROOT / "skills" / "domain-brainstorm" / "SKILL.md"
EXPECTED_GATES = 5


@pytest.fixture(scope="module")
def skill_text() -> str:
    return SKILL.read_text(encoding="utf-8")


@pytest.fixture(scope="module")
def skill_body(skill_text: str) -> str:
    parts = skill_text.split("---", 2)
    assert len(parts) >= 3, "SKILL.md must have YAML frontmatter"
    return parts[2]


@pytest.fixture(scope="module")
def frontmatter(skill_text: str) -> dict:
    parts = skill_text.split("---", 2)
    assert len(parts) >= 3
    fields = {}
    for line in parts[1].splitlines():
        if ":" in line:
            key, _, val = line.partition(":")
            fields[key.strip()] = val.strip()
    return fields


# --- File and frontmatter ---

def test_skill_file_exists():
    assert SKILL.exists(), "domain-brainstorm/SKILL.md must exist"


def test_frontmatter_has_name(frontmatter: dict):
    assert frontmatter.get("name") == "domain-brainstorm"


def test_frontmatter_has_description(frontmatter: dict):
    desc = frontmatter.get("description", "")
    assert len(desc) > 20, f"description too short: {desc!r}"


# --- Gate structure ---

def test_gate_count(skill_body: str):
    gates = re.findall(r"^### Gate \d+ —", skill_body, re.MULTILINE)
    assert len(gates) == EXPECTED_GATES, (
        f"expected {EXPECTED_GATES} gate headers, found {len(gates)}: {gates}"
    )


def test_gate_0_present(skill_body: str):
    assert re.search(r"^### Gate 0 —", skill_body, re.MULTILINE)


def test_gate_4_present(skill_body: str):
    assert re.search(r"^### Gate 4 —", skill_body, re.MULTILINE)


# --- Contract references ---

def test_evidence_source_capability_brainstorm(skill_body: str):
    assert "Evidence Source: capability-brainstorm" in skill_body


def test_category_improvement(skill_body: str):
    assert "category: improvement" in skill_body


def test_metrics_emit_type(skill_body: str):
    assert "brainstorm-emit" in skill_body


def test_metrics_emit_skill_value(skill_body: str):
    # Must use the HA-specific skill name, not the dev pilot's generic name,
    # so brainstorm-emit rows stay separable in a shared proposal-metrics.jsonl.
    assert "ha-domain-brainstorm" in skill_body


def test_prefix_automation_gap(skill_body: str):
    assert "[automation-gap]" in skill_body


def test_prefix_coverage_asymmetry(skill_body: str):
    assert "[coverage-asymmetry]" in skill_body


def test_prefix_unbuilt_intent(skill_body: str):
    assert "[unbuilt-intent]" in skill_body


# --- Boundary guard: suppression framing ---
# Gate 0 legitimately reads integration-health-degraded-domains.json and pattern-analysis
# as SUPPRESSION FILTERS. The assertion is positive (they appear in a suppression context),
# not negative (absence of a term). A "not in body" assertion would false-fail because
# the skill genuinely references these artifacts — it just uses them to exclude ideas,
# not to source them.

def test_integration_health_appears_in_suppression_context(skill_body: str):
    # integration-health-degraded-domains.json must appear near "suppress"/"skip"/"exclude"
    # to confirm it is framed as a filter, not an idea source.
    assert "integration-health-degraded-domains.json" in skill_body, \
        "integration-health-degraded-domains.json not referenced in SKILL.md"
    idx = skill_body.index("integration-health-degraded-domains.json")
    window = skill_body[max(0, idx - 300) : idx + 300].lower()
    assert any(kw in window for kw in ("suppress", "skip", "exclude", "filter")), (
        "integration-health-degraded-domains.json must appear near a suppression keyword "
        "(suppress/skip/exclude/filter); it should be a filter, not an idea source"
    )


def test_no_proposal_create_call_in_gate_0(skill_body: str):
    # Gate 0 must not invoke proposal-create — that belongs to Gate 2.
    gate0_match = re.search(r"### Gate 0 —(.+?)### Gate 1 —", skill_body, re.DOTALL)
    assert gate0_match, "Could not extract Gate 0 body"
    gate0_body = gate0_match.group(1)
    assert "proposal-create" not in gate0_body
