"""Structural lint for the /hatch skill (target-aware routing + schema stamping).

Grep-level checks against the skill markdown. No runtime skill execution.
Mirrors the dev-hermit hatch-mode.test.js pattern adapted for ha-hermit.
"""

import re
from pathlib import Path

import pytest

PLUGIN_ROOT = Path(__file__).parent.parent
HATCH_SKILL = PLUGIN_ROOT / "skills" / "hatch" / "SKILL.md"


@pytest.fixture(scope="module")
def skill_text() -> str:
    return HATCH_SKILL.read_text(encoding="utf-8")


def test_references_hatch_options_json(skill_text: str):
    assert "hatch-options.json" in skill_text


def test_reads_target_field_from_hatch_options_json(skill_text: str):
    assert re.search(r"hatch-options\.json[\s\S]{0,80}[\"`]target[\"`]", skill_text)


def test_local_target_routes_to_claude_local_md(skill_text: str):
    assert re.search(r"[\"`]local[\"`][\s\S]{0,80}target_file = CLAUDE\.local\.md", skill_text)


def test_committed_target_routes_to_claude_md(skill_text: str):
    assert re.search(r"[\"`]committed[\"`][\s\S]{0,120}target_file = CLAUDE\.md", skill_text)


def test_schema_stamps_target_field(skill_text: str):
    assert re.search(r'"target":\s*"', skill_text)


def test_schema_stamps_core_install_scope_field(skill_text: str):
    assert re.search(r'"core_install_scope":\s*"', skill_text)


def test_schema_stamps_stamped_at_field(skill_text: str):
    assert re.search(r'"stamped_at":\s*"', skill_text)


def test_schema_stamps_stamped_by_field(skill_text: str):
    assert re.search(r'"stamped_by":\s*"claude-code-homeassistant-hermit:hatch"', skill_text)


def test_schema_stamps_version_field(skill_text: str):
    assert re.search(r'"version":\s*"', skill_text)


def test_detects_core_install_scope_from_plugin_list(skill_text: str):
    assert re.search(
        r"core_install_scope[\s\S]{0,120}claude plugin list --json", skill_text
    )


def test_documents_project_to_committed_scope_mapping(skill_text: str):
    assert re.search(r"`project`[^\n]{0,20}`committed`", skill_text)


def test_documents_local_user_null_to_local_scope_mapping(skill_text: str):
    assert re.search(r"`local`/`user`/`null`[^\n]{0,40}`local`", skill_text)


def test_stamped_version_source_is_hermit_versions(skill_text: str):
    # Pin the version-comparison source so a future prose edit can't silently
    # change where "stamped version" reads from.
    assert '_hermit_versions["claude-code-homeassistant-hermit"]' in skill_text


def test_skips_on_stamped_version_match(skill_text: str):
    assert re.search(
        r"stamped version equals plugin version[\s\S]{0,40}skip", skill_text
    )


def test_handles_absent_stamped_version(skill_text: str):
    # Realistic upgrade case: block exists but was appended before stamping
    # was reliable. Must NOT fall into an undefined branch.
    assert re.search(r"stamped version null[\s\S]{0,80}stale", skill_text) or \
           re.search(r"stamped version (absent|null)", skill_text)


def test_marker_replacement_specifies_closing_marker(skill_text: str):
    assert "<!-- /claude-code-homeassistant-hermit: Home Assistant Workflow -->" in skill_text


def test_delegates_stray_block_migration_to_hermit_evolve(skill_text: str):
    assert re.search(r"hermit-evolve[\s\S]{0,20}Step 7", skill_text)


# --- Knowledge-schema extension (Step 7.6) ---

def test_has_knowledge_schema_extension_step(skill_text: str):
    assert "Knowledge-schema extension" in skill_text


def test_knowledge_schema_idempotency_sentinel(skill_text: str):
    # The sentinel must appear as the actual typed bullet in the appended block,
    # not just as a backtick-quoted example in the prose description.
    assert "- analysis: HA pattern analysis" in skill_text


def test_knowledge_schema_declares_context(skill_text: str):
    assert "- context:" in skill_text


def test_knowledge_schema_declares_brief(skill_text: str):
    assert "- brief:" in skill_text


def test_knowledge_schema_declares_presence_report(skill_text: str):
    assert "- presence-report:" in skill_text


def test_knowledge_schema_declares_audit(skill_text: str):
    assert "- audit:" in skill_text


def test_knowledge_schema_declares_simulation(skill_text: str):
    assert "- simulation:" in skill_text


def test_knowledge_schema_declares_apply(skill_text: str):
    assert "- apply:" in skill_text


def test_knowledge_schema_declares_remove(skill_text: str):
    assert "- remove:" in skill_text


def test_knowledge_schema_extension_uses_edit_tool(skill_text: str):
    assert "Use Edit to make the changes." in skill_text


def test_knowledge_schema_final_report_line(skill_text: str):
    assert "knowledge-schema.md: HA types added" in skill_text
