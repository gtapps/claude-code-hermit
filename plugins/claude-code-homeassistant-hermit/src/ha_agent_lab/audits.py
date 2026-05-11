from __future__ import annotations

import re
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any

import yaml

from .artifacts import current_session_id, standard_metadata, write_json_artifact, write_markdown_artifact
from .ha_api import HomeAssistantClient, HomeAssistantError
from .policy import Severity, classify_entity, evaluate_references
from .simulate import collect_references


_RATIONALE_BULLET_RE = re.compile(
    r"^- `(?P<id>[^`]+)`:\s*refs=\[(?P<refs>[^\]]*)\];\s*(?P<line>.+)$"
)


def _load_acknowledged(root: Path) -> dict[str, dict[str, Any]]:
    r"""Load .claude-code-hermit/compiled/acknowledged-violations.md.

    Returns {id: {"refs": frozenset[str], "quoted_line": str | None}}.
    Frontmatter automation_ids[] is the canonical filter set; body ## Rationale
    bullets in the form ``- `<id>`: refs=[<csv>]; <text>`` provide per-id refs
    and quoted_line. Ids in frontmatter without a matching body bullet get
    empty refs (and so won't suppress any sensitive violation by the subset
    check below — see template for rationale).

    Fail-open on missing/malformed file: stderr one-liner, return {}.
    """
    path = root / ".claude-code-hermit" / "compiled" / "acknowledged-violations.md"
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return {}
    except OSError as exc:
        print(f"ha-safety-audit: cannot read acknowledged-violations file: {exc}", file=sys.stderr)
        return {}

    try:
        if not text.startswith("---\n"):
            return {}
        end = text.find("\n---\n", 4)
        if end == -1:
            return {}
        fm = yaml.safe_load(text[4:end]) or {}
        body = text[end + 5:]
    except yaml.YAMLError as exc:
        print(f"ha-safety-audit: malformed frontmatter in acknowledged-violations: {exc}", file=sys.stderr)
        return {}

    ids = [str(i) for i in (fm.get("automation_ids") or []) if i]
    result: dict[str, dict[str, Any]] = {i: {"refs": frozenset(), "quoted_line": None} for i in ids}

    for line in body.splitlines():
        match = _RATIONALE_BULLET_RE.match(line.strip())
        if not match:
            continue
        bullet_id = match.group("id")
        if bullet_id not in result:
            continue
        refs = frozenset(r.strip() for r in match.group("refs").split(",") if r.strip())
        result[bullet_id] = {"refs": refs, "quoted_line": line.strip()}

    return result


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

    acknowledged_map = _load_acknowledged(root)
    raw_violations: list[dict[str, Any]] = []
    for automation in automations:
        entities, services = collect_references(automation)
        decision = evaluate_references(sorted(set(entities)), sorted(set(services)), root=root)
        if decision.blocked:
            sensitive_refs = frozenset(
                ref for ref in (*entities, *services)
                if classify_entity(ref, root=root)[0] != Severity.ALLOW
            )
            raw_violations.append(
                {
                    "id": automation.get("id"),
                    "alias": automation.get("alias") or automation.get("id") or "(unnamed)",
                    "reasons": decision.reasons,
                    "_sensitive_refs": sensitive_refs,
                }
            )

    violations: list[dict[str, Any]] = []
    acknowledged: list[dict[str, Any]] = []
    for v in raw_violations:
        sensitive_refs = v.pop("_sensitive_refs")
        info = acknowledged_map.get(v["id"])
        if info and sensitive_refs.issubset(info["refs"]):
            acknowledged.append({
                **v,
                "quoted_line": info["quoted_line"],
                "source": "compiled/acknowledged-violations.md",
            })
        else:
            violations.append(v)

    passed = total_automations - len(violations) - len(unmanaged) - len(fetch_failures) - len(acknowledged)
    summary = {
        "total_automations": total_automations,
        "violations": violations,
        "acknowledged": acknowledged,
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
    if acknowledged:
        body_lines.append(f"- acknowledged (suppressed by compiled/acknowledged-violations.md): {len(acknowledged)}")
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
                "acknowledged": len(acknowledged),
            },
        ),
        "\n".join(body_lines),
        latest_name="audit-ha-safety-latest.md",
    )
    return summary
