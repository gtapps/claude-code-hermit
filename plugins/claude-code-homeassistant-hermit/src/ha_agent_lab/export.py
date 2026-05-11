from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import yaml

from .artifacts import slugify
from .ha_api import HomeAssistantClient, HomeAssistantError


@dataclass(slots=True)
class ExportResult:
    ok: bool
    domain: str
    config_id: str
    path: Path
    message: str


class InvalidConfigId(ValueError):
    pass


def _validate_id(config_id: str) -> None:
    if not config_id:
        raise InvalidConfigId("config id is empty")
    if "." in config_id and config_id.split(".", 1)[0] in {
        "automation",
        "script",
        "light",
        "switch",
        "cover",
        "lock",
        "alarm_control_panel",
    }:
        raise InvalidConfigId(
            f"'{config_id}' looks like an entity_id; pass the config id (e.g. 'kitchen_lights' not 'automation.kitchen_lights')"
        )


def export_config(root: Path, client: HomeAssistantClient, domain: str, config_id: str) -> ExportResult:
    """Fetch live HA config for an automation or script and write it as YAML.

    The original config_id is used verbatim for the HA REST call and recorded
    in the result. The on-disk filename is slugified to guard against path
    separators or filesystem-hostile characters; if slugification changes the
    string, the message records the mapping so the operator can locate the file.
    """
    if domain not in {"automation", "script"}:
        raise ValueError(f"unsupported domain: {domain}")
    _validate_id(config_id)

    config = client.get(f"/api/config/{domain}/config/{config_id}")
    if not isinstance(config, dict):
        raise HomeAssistantError(message=f"unexpected response: {config!r}", status_code=0)

    slug = slugify(config_id)
    target_dir = root / ".claude-code-hermit" / "raw"
    target_dir.mkdir(parents=True, exist_ok=True)
    path = target_dir / f"{domain}-{slug}.yaml"

    serialized = yaml.safe_dump(config, sort_keys=False, allow_unicode=True)
    path.write_text(serialized, encoding="utf-8")

    if slug == config_id:
        message = f"exported {domain} '{config_id}' to {path.relative_to(root)}"
    else:
        message = f"exported {domain} '{config_id}' to {path.relative_to(root)} (filename slugified to '{slug}')"

    return ExportResult(ok=True, domain=domain, config_id=config_id, path=path, message=message)
