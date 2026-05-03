from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any

from .artifacts import current_session_id, standard_metadata, write_json_artifact, write_markdown_artifact
from .ha_api import HomeAssistantClient, HomeAssistantError
from .policy import evaluate_references
from .simulate import collect_references


def _fetch_automation_config(
    client: HomeAssistantClient, state: dict[str, Any]
) -> tuple[str, Any]:
    """Fetch one automation config. Returns (kind, value) where kind is 'ok'|'unmanaged'|'failure'."""
    auto_id = (state.get("attributes") or {}).get("id")
    if not auto_id:
        return ("unmanaged", state["entity_id"])
    try:
        config = client.get(f"/api/config/automation/config/{auto_id}")
        return ("ok", config)
    except HomeAssistantError as exc:
        if exc.status_code == 404:
            return ("failure", str(auto_id))
        raise


def audit_automations(root: Path, client: HomeAssistantClient) -> dict[str, Any]:
    all_states = client.get_states()
    automation_states = [
        s for s in all_states
        if isinstance(s, dict) and s.get("entity_id", "").startswith("automation.")
    ]
    total_automations = len(automation_states)

    unmanaged: list[str] = []
    fetch_failures: list[str] = []
    automations: list[dict[str, Any]] = []

    max_workers = min(20, total_automations) if total_automations else 1
    with ThreadPoolExecutor(max_workers=max_workers) as pool:
        futures = [pool.submit(_fetch_automation_config, client, s) for s in automation_states]
        for future in as_completed(futures):
            kind, value = future.result()
            if kind == "unmanaged":
                unmanaged.append(value)
            elif kind == "failure":
                fetch_failures.append(value)
            elif isinstance(value, dict):
                automations.append(value)

    violations: list[dict[str, Any]] = []
    for automation in automations:
        entities, services = collect_references(automation)
        decision = evaluate_references(sorted(set(entities)), sorted(set(services)), root=root)
        if decision.blocked:
            violations.append(
                {
                    "id": automation.get("id"),
                    "alias": automation.get("alias") or automation.get("id") or "(unnamed)",
                    "reasons": decision.reasons,
                }
            )

    passed = total_automations - len(violations) - len(unmanaged) - len(fetch_failures)
    summary = {
        "total_automations": total_automations,
        "violations": violations,
        "passed": passed,
        "unmanaged": unmanaged,
        "fetch_failures": fetch_failures,
    }

    write_json_artifact(
        root,
        ".claude-code-hermit/raw",
        "audit-ha-safety",
        summary,
        latest_name="audit-ha-safety-latest.json",
    )

    body_lines = [
        "# HA Safety Audit (live automations)",
        "",
        f"- total automations: {total_automations}",
        f"- passed: {passed}",
        f"- violations: {len(violations)}",
    ]
    if unmanaged:
        body_lines.append(f"- unmanaged (no numeric id, skipped): {len(unmanaged)}")
    if fetch_failures:
        body_lines.append(f"- fetch failures (404, skipped): {len(fetch_failures)}")
    if violations:
        body_lines.extend(["", "## Violations"])
        for v in violations:
            body_lines.append(f"- **{v['alias']}** (`{v['id']}`)")
            for reason in v["reasons"]:
                body_lines.append(f"  - {reason}")

    write_markdown_artifact(
        root,
        ".claude-code-hermit/raw",
        "audit-ha-safety",
        standard_metadata(
            "audit",
            "HA Safety Audit",
            session=current_session_id(root),
            tags=["ha-safety", "audit", "policy-drift"],
            extra={
                "source": "scheduled-check",
                "total_automations": total_automations,
                "violations": len(violations),
            },
        ),
        "\n".join(body_lines),
        latest_name="audit-ha-safety-latest.md",
    )
    return summary
