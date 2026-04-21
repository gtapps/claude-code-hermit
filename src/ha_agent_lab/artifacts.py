from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import yaml


def utc_timestamp() -> str:
    return datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")


def slugify(value: str) -> str:
    return "".join(ch if ch.isalnum() or ch in {"-", "_"} else "_" for ch in value).strip("_")


def write_json_artifact(
    root: Path,
    relative_dir: str,
    kind: str,
    payload: dict[str, Any] | list[Any],
    latest_name: str | None = None,
) -> Path:
    directory = root / relative_dir
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / f"{utc_timestamp()}__{slugify(kind)}.json"
    serialized = json.dumps(payload, indent=2, sort_keys=True) + "\n"
    path.write_text(serialized, encoding="utf-8")
    if latest_name:
        (directory / latest_name).write_text(serialized, encoding="utf-8")
    return path


def write_markdown_artifact(
    root: Path,
    relative_dir: str,
    kind: str,
    metadata: dict[str, Any],
    body: str,
    latest_name: str | None = None,
) -> Path:
    directory = root / relative_dir
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / f"{utc_timestamp()}__{slugify(kind)}.md"
    text = _render_frontmatter(metadata, body)
    path.write_text(text, encoding="utf-8")
    if latest_name:
        (directory / latest_name).write_text(text, encoding="utf-8")
    return path


def _render_frontmatter(metadata: dict[str, Any], body: str) -> str:
    serialized = yaml.safe_dump(metadata, sort_keys=False, allow_unicode=False).strip()
    return f"---\n{serialized}\n---\n{body.rstrip()}\n"

