from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml

from .artifacts import write_markdown_artifact
from .config import normalized_context_path
from .policy import PolicyDecision, evaluate_references


@dataclass(slots=True)
class SimulationResult:
    artifact_path: Path
    referenced_entities: list[str]
    referenced_services: list[str]
    missing_entities: list[str]
    blocked_reasons: list[str]

    @property
    def is_valid(self) -> bool:
        return not self.missing_entities and not self.blocked_reasons


def evaluate_yaml_policy(yaml_path: Path) -> tuple[list[str], list[str], PolicyDecision]:
    """Load a YAML file, extract references, and evaluate against safety policy."""
    data = yaml.safe_load(yaml_path.read_text(encoding="utf-8")) or {}
    raw_entities, raw_services = collect_references(data)
    entities = sorted(set(raw_entities))
    services = sorted(set(raw_services))
    decision = evaluate_references(entities, services)
    return entities, services, decision


def simulate_artifact(root: Path, artifact_path: Path, inventory_path: Path | None = None) -> SimulationResult:
    data = yaml.safe_load(artifact_path.read_text(encoding="utf-8")) or {}
    inventory = load_inventory(root, inventory_path)
    entity_index = inventory.get("entity_index", {})
    raw_entities, raw_services = collect_references(data)
    entities = sorted(set(raw_entities))
    services = sorted(set(raw_services))
    missing_entities = [entity_id for entity_id in entities if entity_id not in entity_index]
    decision = evaluate_references(entities, services)
    result = SimulationResult(
        artifact_path=artifact_path,
        referenced_entities=entities,
        referenced_services=services,
        missing_entities=missing_entities,
        blocked_reasons=decision.reasons,
    )
    write_simulation_report(root, result)
    return result


def load_inventory(root: Path, inventory_path: Path | None = None) -> dict[str, Any]:
    path = inventory_path or normalized_context_path(root)
    if not path.exists():
        raise FileNotFoundError(
            f"Normalized inventory not found at {path}. Run `./bin/ha-agent-lab ha refresh-context` first."
        )
    return json.loads(path.read_text(encoding="utf-8"))


def write_simulation_report(root: Path, result: SimulationResult) -> Path:
    metadata = {
        "artifact_path": str(result.artifact_path.relative_to(root)),
        "valid": result.is_valid,
        "referenced_entities": result.referenced_entities,
        "referenced_services": result.referenced_services,
        "missing_entities": result.missing_entities,
        "blocked_reasons": result.blocked_reasons,
    }
    body_lines = [
        f"# Simulation Report for `{result.artifact_path.name}`",
        "",
        f"- valid: {str(result.is_valid).lower()}",
        f"- referenced_entities: {len(result.referenced_entities)}",
        f"- referenced_services: {len(result.referenced_services)}",
    ]
    if result.missing_entities:
        body_lines.extend(["", "## Missing Entities", *[f"- {item}" for item in result.missing_entities]])
    if result.blocked_reasons:
        body_lines.extend(["", "## Blocked Reasons", *[f"- {item}" for item in result.blocked_reasons]])
    return write_markdown_artifact(
        root,
        ".claude-code-hermit/raw",
        f"audit-ha-simulation__{result.artifact_path.stem}",
        metadata,
        "\n".join(body_lines),
        latest_name="audit-ha-simulation-latest.md",
    )


def collect_references(value: Any) -> tuple[list[str], list[str]]:
    """Walk a YAML tree once and return (entity_ids, services)."""
    entities: list[str] = []
    services: list[str] = []
    _walk_references(value, entities, services)
    return entities, services


def _walk_references(value: Any, entities: list[str], services: list[str]) -> None:
    if isinstance(value, dict):
        for key, child in value.items():
            if key == "entity_id":
                if isinstance(child, str):
                    entities.extend(part.strip() for part in child.split(",") if part.strip())
                elif isinstance(child, list):
                    entities.extend(item for item in child if isinstance(item, str))
            elif key == "target" and isinstance(child, dict):
                entity_value = child.get("entity_id")
                if isinstance(entity_value, str):
                    entities.extend(part.strip() for part in entity_value.split(",") if part.strip())
                elif isinstance(entity_value, list):
                    entities.extend(item for item in entity_value if isinstance(item, str))
            if key == "service" and isinstance(child, str):
                services.append(child)
            _walk_references(child, entities, services)
    elif isinstance(value, list):
        for item in value:
            _walk_references(item, entities, services)
