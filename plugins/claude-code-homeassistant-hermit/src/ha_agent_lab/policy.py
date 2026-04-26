from __future__ import annotations

import functools
from dataclasses import dataclass
from pathlib import Path
from typing import Any


SENSITIVE_DOMAINS = {
    "lock",
    "alarm_control_panel",
}

CONDITIONALLY_SENSITIVE_DOMAINS = {
    "cover",
    "button",
    "switch",
}

SENSITIVE_KEYWORDS = {
    "garage",
    "gate",
    "door",
    "alarm",
    "lock",
    "security",
    "shutter",
    "entry",
    "access",
}

SAFE_RELOAD_DOMAINS = {"automation", "script"}


@functools.lru_cache(maxsize=8)
def _load_policy_overrides(root: Path) -> dict[str, frozenset[str]]:
    from .config import load_env_file

    env = load_env_file(root)

    def _fset(name: str) -> frozenset[str]:
        return frozenset(x.strip() for x in env.get(name, "").split(",") if x.strip())

    return {
        "safe_entities": _fset("HA_SAFE_ENTITIES"),
        "extra_domains": _fset("HA_EXTRA_SENSITIVE_DOMAINS"),
        "extra_keywords": _fset("HA_EXTRA_SENSITIVE_KEYWORDS"),
    }


def _policy_overrides(root: Path | None = None) -> dict[str, frozenset[str]]:
    return _load_policy_overrides((root or Path.cwd()).resolve())


@dataclass(slots=True)
class PolicyDecision:
    blocked: bool
    reasons: list[str]


def classify_entity(entity_id: str, root: Path | None = None) -> tuple[bool, list[str]]:
    """Return (sensitive, reasons) for a single entity."""
    overrides = _policy_overrides(root)
    if entity_id in overrides["safe_entities"]:
        return False, []
    domain = entity_id.split(".", 1)[0]
    if domain in SENSITIVE_DOMAINS | overrides["extra_domains"]:
        return True, [f"Domain '{domain}' is always sensitive"]
    if domain in CONDITIONALLY_SENSITIVE_DOMAINS:
        matched = [kw for kw in SENSITIVE_KEYWORDS | overrides["extra_keywords"] if kw in entity_id.lower()]
        if matched:
            return True, [f"Domain '{domain}' with keywords: {', '.join(matched)}"]
    return False, []


def is_sensitive_entity(entity_id: str, root: Path | None = None) -> bool:
    return classify_entity(entity_id, root)[0]


def is_sensitive_service(service_name: str) -> bool:
    return classify_entity(service_name)[0]


def evaluate_references(entity_ids: list[str], services: list[str], root: Path | None = None) -> PolicyDecision:
    reasons: list[str] = []
    for entity_id in sorted(set(entity_ids)):
        if is_sensitive_entity(entity_id, root):
            reasons.append(f"Sensitive or ambiguous entity blocked: {entity_id}")
    for service in sorted(set(services)):
        if is_sensitive_service(service):
            reasons.append(f"Sensitive or ambiguous service blocked: {service}")
    return PolicyDecision(blocked=bool(reasons), reasons=reasons)


def can_reload_domain(domain: str) -> bool:
    return domain in SAFE_RELOAD_DOMAINS


def check_entity(entity_id: str) -> dict[str, Any]:
    """Return a JSON-friendly policy check for a single entity."""
    sensitive, reasons = classify_entity(entity_id)
    return {"entity_id": entity_id, "sensitive": sensitive, "reasons": reasons}


def normalize_entity_index(states: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    index: dict[str, dict[str, Any]] = {}
    for state in states:
        entity_id = state.get("entity_id")
        if isinstance(entity_id, str):
            index[entity_id] = state
    return index
