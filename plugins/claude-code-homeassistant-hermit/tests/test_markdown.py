from pathlib import Path

import pytest

from ha_agent_lab.markdown import dump_frontmatter, load_frontmatter


def test_roundtrip(tmp_path: Path):
    path = tmp_path / "test.md"
    metadata = {"id": "S-001", "status": "completed", "cost_usd": 1.23}
    body = "# Session Report\n\nSome content here."

    dump_frontmatter(path, metadata, body)
    loaded_meta, loaded_body = load_frontmatter(path)

    assert loaded_meta == metadata
    assert "# Session Report" in loaded_body


def test_no_frontmatter_returns_empty_dict(tmp_path: Path):
    path = tmp_path / "plain.md"
    path.write_text("# Just a plain file\n\nNo frontmatter.", encoding="utf-8")

    meta, body = load_frontmatter(path)

    assert meta == {}
    assert "plain file" in body


def test_dump_creates_parent_dirs(tmp_path: Path):
    path = tmp_path / "nested" / "dir" / "file.md"
    dump_frontmatter(path, {"key": "value"}, "body")
    assert path.exists()


def test_non_mapping_frontmatter_raises(tmp_path: Path):
    path = tmp_path / "bad.md"
    path.write_text("---\n- list item\n---\nbody", encoding="utf-8")

    with pytest.raises(ValueError):
        load_frontmatter(path)
