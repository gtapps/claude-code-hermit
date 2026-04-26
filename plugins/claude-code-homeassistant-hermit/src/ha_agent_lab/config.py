from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import dotenv_values

from .markdown import dump_frontmatter, load_frontmatter


@dataclass(slots=True)
class AppConfig:
    root: Path
    ha_url: str | None
    ha_local_url: str | None
    ha_remote_url: str | None
    ha_token: str | None
    timeout_seconds: int
    retry_count: int

    @property
    def has_ha_endpoint(self) -> bool:
        return bool(self.primary_url())

    @property
    def has_ha_credentials(self) -> bool:
        return bool(self.ha_token and self.has_ha_endpoint)

    def primary_url(self) -> str | None:
        """Single resolved URL. Uses ha_url unless dual-URL mode is active."""
        return self.ha_url or self.ha_local_url or self.ha_remote_url

    def missing_ha_configuration_fields(self) -> list[str]:
        missing: list[str] = []
        if not self.has_ha_endpoint:
            missing.append("HOMEASSISTANT_URL")
        if not self.ha_token:
            missing.append("HOMEASSISTANT_TOKEN")
        return missing


def load_env_file(root: Path) -> dict[str, str]:
    env_path = root / ".env"
    if not env_path.exists():
        return {}
    return {k: v for k, v in dotenv_values(env_path).items() if v is not None}


def save_env_file(root: Path, updates: dict[str, str | None]) -> Path:
    env_path = root / ".env"
    existing = load_env_file(root)
    for key, value in updates.items():
        if value is None:
            existing.pop(key, None)
        else:
            existing[key] = value

    lines = [f"{key}={value}" for key, value in existing.items()]
    env_path.write_text("\n".join(lines) + ("\n" if lines else ""), encoding="utf-8")
    return env_path


def operator_context_path(root: Path) -> Path:
    return root / ".local" / "operator" / "context.md"


def load_operator_context(root: Path) -> dict[str, str]:
    path = operator_context_path(root)
    if not path.exists():
        return {}
    metadata, _ = load_frontmatter(path)
    return {str(key): str(value) for key, value in metadata.items() if value}


def save_operator_context(
    root: Path,
    url: str | None = None,
    local_url: str | None = None,
    remote_url: str | None = None,
) -> Path:
    metadata = {
        "home_assistant_url": url or "",
        "home_assistant_local_url": local_url or "",
        "home_assistant_remote_url": remote_url or "",
    }
    body = "\n".join(
        [
            "# Local Operator Context",
            "",
            "- This file is ignored and local-only.",
            "- Keep operator-specific endpoints here if they are not stored in `.env`.",
        ]
    )
    path = operator_context_path(root)
    dump_frontmatter(path, metadata, body)
    return path


HERMIT_RAW = Path(".claude-code-hermit") / "raw"


def normalized_context_path(root: Path) -> Path:
    return root / HERMIT_RAW / "snapshot-ha-normalized-latest.json"


def load_config(root: Path | None = None) -> AppConfig:
    repo_root = (root or Path.cwd()).resolve()
    env_file = load_env_file(repo_root)
    operator_context = load_operator_context(repo_root)

    def pick(name: str, fallback: str | None = None) -> str | None:
        return os.getenv(name) or env_file.get(name) or operator_context.get(name.lower()) or fallback

    return AppConfig(
        root=repo_root,
        ha_url=pick("HOMEASSISTANT_URL"),
        ha_local_url=pick("HOMEASSISTANT_LOCAL_URL"),
        ha_remote_url=pick("HOMEASSISTANT_REMOTE_URL"),
        ha_token=pick("HOMEASSISTANT_TOKEN"),
        timeout_seconds=int(pick("HOMEASSISTANT_TIMEOUT_SECONDS", "15") or "15"),
        retry_count=int(pick("HOMEASSISTANT_RETRY_COUNT", "2") or "2"),
    )
