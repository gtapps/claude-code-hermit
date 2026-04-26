from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml


def load_frontmatter(path: Path) -> tuple[dict[str, Any], str]:
    text = path.read_text(encoding="utf-8")
    if not text.startswith("---\n"):
        return {}, text

    parts = text.split("\n---\n", 1)
    if len(parts) != 2:
        return {}, text

    metadata_text = parts[0][4:]
    body = parts[1]
    metadata = yaml.safe_load(metadata_text) or {}
    if not isinstance(metadata, dict):
        raise ValueError(f"Frontmatter in {path} must parse to a mapping.")
    return metadata, body


def render_frontmatter(metadata: dict[str, Any], body: str) -> str:
    serialized = yaml.safe_dump(metadata, sort_keys=False, allow_unicode=False).strip()
    return f"---\n{serialized}\n---\n{body.rstrip()}\n"


def dump_frontmatter(path: Path, metadata: dict[str, Any], body: str) -> None:
    text = render_frontmatter(metadata, body)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")

