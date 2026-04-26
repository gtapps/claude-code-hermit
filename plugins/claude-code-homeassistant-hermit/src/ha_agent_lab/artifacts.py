from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from .markdown import render_frontmatter


def utc_timestamp() -> str:
    return datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")


def slugify(value: str) -> str:
    return "".join(ch if ch.isalnum() or ch in {"-", "_"} else "_" for ch in value).strip("_")


def current_session_id(root: Path) -> str | None:
    runtime = root / ".claude-code-hermit" / "state" / "runtime.json"
    try:
        return json.loads(runtime.read_text(encoding="utf-8")).get("session_id")
    except (OSError, ValueError):
        return None


def standard_metadata(
    type_: str,
    title: str,
    *,
    session: str | None = None,
    tags: list[str] | None = None,
    extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Build v1.0.17-compliant frontmatter with canonical field ordering."""
    meta: dict[str, Any] = {
        "title": title,
        "type": type_,
        "created": datetime.now(UTC).isoformat(),
        "session": session,
        "tags": tags or [],
    }
    if extra:
        meta.update(extra)
    return meta


def _artifact_name(kind: str, ext: str, directory: Path) -> str:
    now = datetime.now(UTC)
    today = now.strftime("%Y-%m-%d")
    name = f"{kind}-{today}.{ext}"
    if (directory / name).exists():
        name = f"{kind}-{today}-{now.strftime('%H%M%S')}.{ext}"
    return name


def write_json_artifact(
    root: Path,
    relative_dir: str,
    kind: str,
    payload: dict[str, Any] | list[Any],
    latest_name: str | None = None,
) -> Path:
    directory = root / relative_dir
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / _artifact_name(kind, "json", directory)
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
    path = directory / _artifact_name(kind, "md", directory)
    text = render_frontmatter(metadata, body)
    path.write_text(text, encoding="utf-8")
    if latest_name:
        (directory / latest_name).write_text(text, encoding="utf-8")
    return path
