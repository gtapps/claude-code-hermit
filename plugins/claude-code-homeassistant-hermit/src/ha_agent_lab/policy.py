from __future__ import annotations

import functools
import json
from dataclasses import dataclass
from enum import Enum
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


class Severity(str, Enum):
    BLOCK = "block"
    ASK = "ask"
    ALLOW = "allow"  # sentinel for non-sensitive entities; no ha_safety_mode maps to it


_MODE_TO_SEVERITY: dict[str, Severity] = {
    "strict": Severity.BLOCK,
    "ask": Severity.ASK,
}

_SEVERITY_ORDER = {Severity.ALLOW: 0, Severity.ASK: 1, Severity.BLOCK: 2}


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


@functools.lru_cache(maxsize=8)
def _load_safety_mode(root: Path) -> str:
    try:
        cfg = json.loads((root / ".claude-code-hermit" / "config.json").read_text())
        mode = cfg.get("ha_safety_mode", "strict")
        return mode if mode in _MODE_TO_SEVERITY else "strict"
    except Exception:
        return "strict"


def safety_mode(root: Path | None = None) -> str:
    """Read ha_safety_mode from .claude-code-hermit/config.json. Fail-closed: returns 'strict'."""
    return _load_safety_mode((root or Path.cwd()).resolve())


@dataclass(slots=True)
class PolicyDecision:
    severity: Severity
    blocked: bool
    reasons: list[str]


def classify_entity(entity_id: str, root: Path | None = None) -> tuple[Severity, list[str]]:
    """Return (Severity, reasons) for a single entity."""
    resolved = (root or Path.cwd()).resolve()
    overrides = _load_policy_overrides(resolved)
    if entity_id in overrides["safe_entities"]:
        return Severity.ALLOW, []
    domain = entity_id.split(".", 1)[0]
    mode_sev = _MODE_TO_SEVERITY[_load_safety_mode(resolved)]
    if domain in SENSITIVE_DOMAINS | overrides["extra_domains"]:
        return mode_sev, [f"Domain '{domain}' is always sensitive"]
    if domain in CONDITIONALLY_SENSITIVE_DOMAINS:
        matched = [kw for kw in SENSITIVE_KEYWORDS | overrides["extra_keywords"] if kw in entity_id.lower()]
        if matched:
            return mode_sev, [f"Domain '{domain}' with keywords: {', '.join(matched)}"]
    return Severity.ALLOW, []


def is_sensitive_entity(entity_id: str, root: Path | None = None) -> bool:
    sev, _ = classify_entity(entity_id, root)
    return sev != Severity.ALLOW


def is_sensitive_service(service_name: str) -> bool:
    sev, _ = classify_entity(service_name)
    return sev != Severity.ALLOW


def evaluate_references(entity_ids: list[str], services: list[str], root: Path | None = None) -> PolicyDecision:
    max_sev = Severity.ALLOW
    reasons: list[str] = []
    for entity_id in sorted(set(entity_ids)):
        sev, _ = classify_entity(entity_id, root)
        if sev != Severity.ALLOW:
            reasons.append(f"Sensitive or ambiguous entity ({sev.value}): {entity_id}")
            if _SEVERITY_ORDER[sev] > _SEVERITY_ORDER[max_sev]:
                max_sev = sev
    for service in sorted(set(services)):
        sev, _ = classify_entity(service, root)
        if sev != Severity.ALLOW:
            reasons.append(f"Sensitive or ambiguous service ({sev.value}): {service}")
            if _SEVERITY_ORDER[sev] > _SEVERITY_ORDER[max_sev]:
                max_sev = sev
    return PolicyDecision(severity=max_sev, blocked=(max_sev == Severity.BLOCK), reasons=reasons)


def can_reload_domain(domain: str) -> bool:
    return domain in SAFE_RELOAD_DOMAINS


def check_entity(entity_id: str) -> dict[str, Any]:
    """Return a JSON-friendly policy check for a single entity."""
    sev, reasons = classify_entity(entity_id)
    return {
        "entity_id": entity_id,
        "sensitive": sev != Severity.ALLOW,
        "severity": sev.value,
        "reasons": reasons,
    }


def normalize_entity_index(states: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    index: dict[str, dict[str, Any]] = {}
    for state in states:
        entity_id = state.get("entity_id")
        if isinstance(entity_id, str):
            index[entity_id] = state
    return index
