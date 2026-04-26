from __future__ import annotations

import re
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from .config import AppConfig, normalized_context_path, save_env_file, save_operator_context
from .ha_api import probe_home_assistant_url, select_home_assistant_url


LANGUAGE_PATTERN = re.compile(r"^- Language:\s*(.+?)\s*$", re.MULTILINE)
_PLUGIN_ROOT = Path(__file__).resolve().parents[2]


@dataclass(slots=True)
class BootStatus:
    language: str | None
    token_configured: bool
    url: str | None
    local_url: str | None
    remote_url: str | None
    active_url: str | None
    active_source: str | None
    context_exists: bool
    context_age_hours: float | None
    context_fresh: bool
    needs_language: bool
    needs_token: bool
    needs_endpoint: bool
    needs_context_refresh: bool
    can_refresh_context: bool
    command_prefix: str
    setup_checklist: list[dict[str, Any]]
    setup_hints: list[dict[str, str]]

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


def memory_path(root: Path) -> Path:
    return root / "MEMORY.md"


def read_language(root: Path) -> str | None:
    path = memory_path(root)
    if not path.exists():
        return None
    match = LANGUAGE_PATTERN.search(path.read_text(encoding="utf-8"))
    return match.group(1).strip() if match else None


def write_language(root: Path, language: str) -> Path:
    path = memory_path(root)
    if path.exists():
        text = path.read_text(encoding="utf-8")
        if LANGUAGE_PATTERN.search(text):
            text = LANGUAGE_PATTERN.sub(f"- Language: {language}", text, count=1)
        else:
            suffix = "\n" if text.endswith("\n") else "\n\n"
            text = f"{text}{suffix}- Language: {language}\n"
    else:
        text = "# MEMORY\n\n- Language: {language}\n".format(language=language)
    path.write_text(text, encoding="utf-8")
    return path


def _command_prefix() -> str:
    launcher = _PLUGIN_ROOT / "bin" / "ha-agent-lab"
    if launcher.exists():
        return str(launcher)
    return f"{_PLUGIN_ROOT}/.venv/bin/python -m ha_agent_lab"


def boot_status(config: AppConfig, probe: bool = False, staleness_hours: int = 24) -> BootStatus:
    root = config.root
    language = read_language(root)
    command_prefix = _command_prefix()
    context_path = normalized_context_path(root)
    context_exists = context_path.exists()
    context_age_hours: float | None = None
    context_fresh = False
    if context_exists:
        seconds = max(0.0, time.time() - context_path.stat().st_mtime)
        context_age_hours = round(seconds / 3600, 2)
        context_fresh = seconds <= (staleness_hours * 3600)

    active_url = None
    active_source = None
    if probe and config.ha_token:
        active_url, active_source = select_home_assistant_url(config)
    elif config.ha_url:
        active_url, active_source = config.ha_url, "single"
    elif config.ha_local_url:
        active_url, active_source = config.ha_local_url, "local"
    elif config.ha_remote_url:
        active_url, active_source = config.ha_remote_url, "remote"

    return BootStatus(
        language=language,
        token_configured=bool(config.ha_token),
        url=config.ha_url,
        local_url=config.ha_local_url,
        remote_url=config.ha_remote_url,
        active_url=active_url,
        active_source=active_source,
        context_exists=context_exists,
        context_age_hours=context_age_hours,
        context_fresh=context_fresh,
        needs_language=language is None,
        needs_token=not bool(config.ha_token),
        needs_endpoint=not config.has_ha_endpoint,
        needs_context_refresh=not context_fresh,
        can_refresh_context=bool(config.ha_token and config.has_ha_endpoint),
        command_prefix=command_prefix,
        setup_checklist=_setup_checklist(config, language, context_exists, context_fresh, command_prefix),
        setup_hints=_setup_hints(config, language),
    )


def save_boot_preferences(
    root: Path,
    language: str | None = None,
    url: str | None = None,
    local_url: str | None = None,
    remote_url: str | None = None,
    token: str | None = None,
) -> dict[str, str]:
    changes: dict[str, str] = {}
    if language:
        write_language(root, language)
        changes["language"] = language
    env_updates: dict[str, str | None] = {}
    if token is not None:
        env_updates["HOMEASSISTANT_TOKEN"] = token
        changes["token"] = "updated"
    if url is not None:
        env_updates["HOMEASSISTANT_URL"] = url
        changes["url"] = url
    if local_url is not None:
        env_updates["HOMEASSISTANT_LOCAL_URL"] = local_url
        changes["local_url"] = local_url
    if remote_url is not None:
        env_updates["HOMEASSISTANT_REMOTE_URL"] = remote_url
        changes["remote_url"] = remote_url
    if env_updates:
        save_env_file(root, env_updates)
    if url is not None or local_url is not None or remote_url is not None:
        save_operator_context(root, url=url, local_url=local_url, remote_url=remote_url)
    return changes


def probe_endpoint(url: str | None, config: AppConfig) -> bool:
    if not url or not config.ha_token:
        return False
    return probe_home_assistant_url(url, config.ha_token, config.timeout_seconds)


def _setup_checklist(
    config: AppConfig,
    language: str | None,
    context_exists: bool,
    context_fresh: bool,
    command_prefix: str,
) -> list[dict[str, Any]]:
    endpoint_value = config.primary_url()
    context_status = "fresh" if context_fresh else "stale" if context_exists else "missing"
    return [
        {
            "field": "Language",
            "required": True,
            "configured": language is not None,
            "status": "ok" if language is not None else "missing",
            "location": "MEMORY.md",
            "next_step": f"{command_prefix} boot store --language <locale>",
        },
        {
            "field": "Home Assistant endpoint",
            "required": True,
            "configured": config.has_ha_endpoint,
            "status": "ok" if config.has_ha_endpoint else "missing",
            "location": ".env or .local/operator/context.md",
            "current_value": endpoint_value or "",
            "next_step": f"{command_prefix} boot store --url http://<home-assistant-ip>:8123",
        },
        {
            "field": "HOMEASSISTANT_TOKEN",
            "required": True,
            "configured": bool(config.ha_token),
            "status": "ok" if config.ha_token else "missing",
            "location": ".env",
            "next_step": f"{command_prefix} boot store --token <long-lived-access-token>",
        },
        {
            "field": "Context snapshot",
            "required": True,
            "configured": context_exists,
            "status": context_status,
            "location": ".claude-code-hermit/raw/snapshot-ha-normalized-latest.json",
            "next_step": f"{command_prefix} ha refresh-context",
        },
        {
            "field": "HOMEASSISTANT_REMOTE_URL",
            "required": False,
            "configured": bool(config.ha_remote_url),
            "status": "ok" if config.ha_remote_url else "optional",
            "location": ".env or .local/operator/context.md",
            "next_step": f"{command_prefix} boot store --local-url <local> --remote-url <remote>",
        },
    ]


def _setup_hints(config: AppConfig, language: str | None) -> list[dict[str, str]]:
    hints: list[dict[str, str]] = []
    if language is None:
        hints.append(
            {
                "field": "Language",
                "how_to_get": "Choose the locale you want the agent to use for conversation plus aliases and descriptions, for example `en` or `pt-PT`.",
            }
        )
    if not config.has_ha_endpoint:
        hints.append(
            {
                "field": "HOMEASSISTANT_URL",
                "how_to_get": "The URL used to reach Home Assistant — local (`http://<ip>:8123`) or remote (Nabu Casa, reverse proxy). Set in `.env` as `HOMEASSISTANT_URL=...`.",
                "source": "https://developers.home-assistant.io/docs/api/rest",
            }
        )
    if not config.ha_token:
        hints.append(
            {
                "field": "HOMEASSISTANT_TOKEN",
                "how_to_get": "In Home Assistant, open your user profile and create a Long-Lived Access Token from the profile page. Copy it once and store it in `.env`.",
                "source": "https://developers.home-assistant.io/docs/auth_api/",
            }
        )
    return hints
