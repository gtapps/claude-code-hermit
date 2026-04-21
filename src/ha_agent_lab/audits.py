from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from .artifacts import utc_timestamp, write_json_artifact, write_markdown_artifact
from .ha_api import HomeAssistantClient
from .policy import evaluate_references
from .simulate import collect_references


ERROR_PATTERNS = ("error", "failed", "timeout", "could not", "unable to")
ERROR_REGEX = re.compile(r"(automation\.[a-z0-9_]+)", re.IGNORECASE)


def audit_automations(root: Path, client: HomeAssistantClient) -> dict[str, Any]:
    raw = client.get("/api/config/automation/config")
    automations = raw if isinstance(raw, list) else []

    violations: list[dict[str, Any]] = []
    for automation in automations:
        if not isinstance(automation, dict):
            continue
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

    summary = {
        "total_automations": len(automations),
        "violations": violations,
        "passed": len(automations) - len(violations),
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
        f"- total automations: {summary['total_automations']}",
        f"- passed: {summary['passed']}",
        f"- violations: {len(violations)}",
    ]
    if violations:
        body_lines.extend(["", "## Violations"])
        for v in violations:
            body_lines.append(f"- **{v['alias']}** (`{v['id']}`)")
            for reason in v["reasons"]:
                body_lines.append(f"  - {reason}")

    ts = utc_timestamp()
    write_markdown_artifact(
        root,
        ".claude-code-hermit/raw",
        "audit-ha-safety",
        {
            "title": f"HA Safety Audit — {ts}",
            "type": "audit",
            "created": ts,
            "source": "plugin-check",
            "tags": ["ha-safety", "audit", "policy-drift"],
            "total_automations": summary["total_automations"],
            "violations": len(violations),
        },
        "\n".join(body_lines),
        latest_name="audit-ha-safety-latest.md",
    )
    return summary


def review_automation_errors(root: Path, client: HomeAssistantClient, min_hits: int = 3) -> dict[str, Any]:
    raw = client.get("/api/error_log")
    text = raw if isinstance(raw, str) else ""

    lines = text.splitlines()
    counts: dict[str, int] = {}
    for line in lines:
        lower = line.lower()
        if not any(p in lower for p in ERROR_PATTERNS):
            continue
        for match in ERROR_REGEX.findall(lower):
            counts[match] = counts.get(match, 0) + 1

    flagged = [
        {"entity_id": eid, "count": count}
        for eid, count in sorted(counts.items(), key=lambda item: (-item[1], item[0]))
        if count >= min_hits
    ]

    summary = {
        "min_hits": min_hits,
        "total_lines_scanned": len(lines),
        "flagged_automations": flagged,
    }

    write_json_artifact(
        root,
        ".claude-code-hermit/raw",
        "audit-ha-automation-errors",
        summary,
        latest_name="audit-ha-automation-errors-latest.json",
    )

    body_lines = [
        "# HA Automation Error Review",
        "",
        f"- log lines scanned: {summary['total_lines_scanned']}",
        f"- threshold: >= {min_hits} hits",
        f"- automations flagged: {len(flagged)}",
    ]
    if flagged:
        body_lines.extend(["", "## Flagged Automations"])
        for item in flagged:
            body_lines.append(f"- `{item['entity_id']}` — {item['count']} error-pattern hits")

    ts = utc_timestamp()
    write_markdown_artifact(
        root,
        ".claude-code-hermit/raw",
        "audit-ha-automation-errors",
        {
            "title": f"HA Automation Errors — {ts}",
            "type": "audit",
            "created": ts,
            "source": "plugin-check",
            "tags": ["ha-automation", "errors", "review"],
            "min_hits": min_hits,
            "flagged": len(flagged),
        },
        "\n".join(body_lines),
        latest_name="audit-ha-automation-errors-latest.md",
    )
    return summary
