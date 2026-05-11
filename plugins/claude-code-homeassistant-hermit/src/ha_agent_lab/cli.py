from __future__ import annotations

import argparse
import json
import sys
from datetime import date
from pathlib import Path
from typing import Any

from .apply import remove_config, validate_and_apply
from .artifacts import current_session_id, standard_metadata, utc_timestamp, write_json_artifact, write_markdown_artifact
from .boot import boot_status, save_boot_preferences
from .config import load_config, normalized_context_path
from .ha_api import HomeAssistantClient, HomeAssistantError
from .policy import check_entity, normalize_entity_index


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="ha_agent_lab")
    subparsers = parser.add_subparsers(dest="command", required=True)

    boot_parser = subparsers.add_parser("boot")
    boot_subparsers = boot_parser.add_subparsers(dest="boot_command", required=True)
    boot_status_parser = boot_subparsers.add_parser("status")
    boot_status_parser.add_argument("--probe", action="store_true")
    boot_store_parser = boot_subparsers.add_parser("store")
    boot_store_parser.add_argument("--language")
    boot_store_parser.add_argument("--url")
    boot_store_parser.add_argument("--local-url")
    boot_store_parser.add_argument("--remote-url")
    boot_store_parser.add_argument("--token")

    ha_parser = subparsers.add_parser("ha")
    ha_subparsers = ha_parser.add_subparsers(dest="ha_command", required=True)
    refresh_parser = ha_subparsers.add_parser("refresh-context")
    refresh_parser.add_argument(
        "--incremental",
        action="store_true",
        help="Only re-process entities that changed since the last artifact (faster, cheaper).",
    )

    simulate_parser = ha_subparsers.add_parser("simulate")
    simulate_parser.add_argument("artifact")

    validate_apply_parser = ha_subparsers.add_parser("validate-apply")
    validate_apply_parser.add_argument("artifact")
    validate_apply_parser.add_argument("--reload", choices=["automation", "script"])

    policy_check_parser = ha_subparsers.add_parser("policy-check")
    policy_check_parser.add_argument("target", help="entity_id or path to YAML file")

    ha_subparsers.add_parser(
        "audit-automations",
        help="Audit all live HA automations against the safety policy.",
    )

    ha_subparsers.add_parser(
        "audit-scripts",
        help="Audit all live HA scripts against the safety policy.",
    )

    probe_parser = ha_subparsers.add_parser(
        "probe",
        help="GET a raw HA REST path and print the JSON response. Useful for verifying endpoints.",
    )
    probe_parser.add_argument("path", help="HA REST path, e.g. /api/config/automation/config/1234")

    ha_subparsers.add_parser("list-automations", help="List all automation entity IDs and config IDs.")
    ha_subparsers.add_parser("list-scripts", help="List all script entity IDs and config IDs.")

    delete_automation_parser = ha_subparsers.add_parser("delete-automation", help="Delete an automation config by ID.")
    delete_automation_parser.add_argument("id", help="Automation config ID (not entity_id).")

    delete_script_parser = ha_subparsers.add_parser("delete-script", help="Delete a script config by ID.")
    delete_script_parser.add_argument("id", help="Script config ID (not entity_id).")

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    # policy-check doesn't need HA config
    if args.command == "ha" and args.ha_command == "policy-check":
        return _handle_policy_check(args.target)

    config = load_config()
    root = config.root

    if args.command == "boot" and args.boot_command == "status":
        status = boot_status(config, probe=args.probe)
        print(json.dumps(status.as_dict(), indent=2))
        return 0

    if args.command == "boot" and args.boot_command == "store":
        changes = save_boot_preferences(root, language=args.language, url=args.url, local_url=args.local_url, remote_url=args.remote_url, token=args.token)
        print(json.dumps({"updated": changes}, indent=2))
        return 0

    if args.command == "ha" and args.ha_command == "refresh-context":
        try:
            client = HomeAssistantClient(config)
            if args.incremental:
                payload, delta = refresh_context_incremental(root, client)
                print(
                    json.dumps(
                        {
                            "status": "ok",
                            "mode": "incremental",
                            "entities": len(payload["entity_index"]),
                            "added": len(delta["added"]),
                            "removed": len(delta["removed"]),
                            "changed": len(delta["changed"]),
                            "base_url_source": client.base_url_source,
                        },
                        indent=2,
                    )
                )
            else:
                payload = refresh_context(root, client)
                print(
                    json.dumps(
                        {
                            "status": "ok",
                            "mode": "full",
                            "entities": len(payload["entity_index"]),
                            "base_url_source": client.base_url_source,
                        },
                        indent=2,
                    )
                )
            return 0
        except HomeAssistantError as exc:
            print(str(exc))
            return 1

    if args.command == "ha" and args.ha_command == "simulate":
        from .simulate import simulate_artifact

        result = simulate_artifact(root, Path(args.artifact).resolve())
        print(
            json.dumps(
                {
                    "valid": result.is_valid,
                    "missing_entities": result.missing_entities,
                    "blocked_reasons": result.blocked_reasons,
                },
                indent=2,
            )
        )
        return 0 if result.is_valid else 1

    if args.command == "ha" and args.ha_command == "audit-automations":
        try:
            from .audits import audit_automations

            client = HomeAssistantClient(config)
            summary = audit_automations(root, client)
            _print_safety_audit_summary(summary, domain="automation")
            return 0
        except HomeAssistantError as exc:
            print(str(exc))
            return 1

    if args.command == "ha" and args.ha_command == "audit-scripts":
        try:
            from .audits import audit_scripts

            client = HomeAssistantClient(config)
            summary = audit_scripts(root, client)
            _print_safety_audit_summary(summary, domain="script")
            return 0
        except HomeAssistantError as exc:
            print(str(exc))
            return 1

    if args.command == "ha" and args.ha_command == "probe":
        try:
            client = HomeAssistantClient(config)
            response = client.get(args.path)
            print(json.dumps(response, indent=2, ensure_ascii=False))
            return 0
        except HomeAssistantError as exc:
            print(f"HA error {exc.status_code}: {str(exc.payload)[:500]}", file=sys.stderr)
            return 1

    if args.command == "ha" and args.ha_command == "validate-apply":
        try:
            client = HomeAssistantClient(config)
            result = validate_and_apply(root, client, Path(args.artifact).resolve(), args.reload)
            print(
                json.dumps(
                    {
                        "ok": result.ok,
                        "config_id": result.config_id,
                        "creation_attempted": result.creation_attempted,
                        "creation_ok": result.creation_ok,
                        "reload_attempted": result.reload_attempted,
                        "message": result.message,
                        "report_path": str(result.report_path.relative_to(root)),
                        "base_url_source": client.base_url_source,
                    },
                    indent=2,
                )
            )
            return 0 if result.ok else 1
        except HomeAssistantError as exc:
            print(str(exc))
            return 1

    if args.command == "ha" and args.ha_command in ("list-automations", "list-scripts"):
        try:
            client = HomeAssistantClient(config)
            domain = "automation" if args.ha_command == "list-automations" else "script"
            items = _list_domain(client, domain)
            print(json.dumps(items, indent=2, ensure_ascii=False))
            return 0
        except HomeAssistantError as exc:
            print(str(exc))
            return 1

    if args.command == "ha" and args.ha_command in ("delete-automation", "delete-script"):
        try:
            client = HomeAssistantClient(config)
            domain = "automation" if args.ha_command == "delete-automation" else "script"
            result = remove_config(root, client, domain, args.id)
            print(
                json.dumps(
                    {
                        "ok": result.ok,
                        "domain": result.domain,
                        "config_id": result.config_id,
                        "message": result.message,
                        "report_path": str(result.report_path.relative_to(root)),
                    },
                    indent=2,
                )
            )
            return 0 if result.ok else 1
        except HomeAssistantError as exc:
            print(str(exc))
            return 1

    parser.error("Unsupported command.")
    return 1


def _list_domain(client: HomeAssistantClient, domain: str) -> list[dict[str, Any]]:
    states = client.get("/api/states")
    prefix = f"{domain}."
    items: list[dict[str, Any]] = []
    for s in states:
        if not (isinstance(s, dict) and s.get("entity_id", "").startswith(prefix)):
            continue
        attrs = s.get("attributes") or {}
        config_id = attrs.get("id")
        items.append({
            "entity_id": s["entity_id"],
            "id": config_id,
            "friendly_name": attrs.get("friendly_name"),
            "state": s.get("state"),
            "last_changed": s.get("last_changed"),
            "deletable": config_id is not None,
        })
    items.sort(key=lambda item: item["entity_id"])
    return items


def _print_safety_audit_summary(summary: dict[str, Any], domain: str = "automation") -> None:
    violations = summary.get("violations", [])
    acknowledged = summary.get("acknowledged", [])
    total = summary.get(f"total_{domain}s", 0)
    unmanaged = summary.get("unmanaged", [])
    fetch_failures = summary.get("fetch_failures", [])
    label = "ha-safety-audit" if domain == "automation" else f"ha-{domain}-safety-audit"
    print(f"{label} findings — {date.today().isoformat()}")
    if not violations:
        print(f"No actionable findings. ({total} {domain}s scanned)")
    else:
        print(f"Policy violations: {len(violations)}")
        for v in violations:
            reasons = "; ".join(v.get("reasons", []))
            print(f"- {v.get('alias')} (`{v.get('id')}`): {reasons}")
        print(f"No action needed: {summary['passed']} {domain}s passed")
    if acknowledged:
        print(f"Acknowledged (suppressed): {len(acknowledged)}")
    if unmanaged:
        print(f"Skipped (no numeric id): {len(unmanaged)}")
    if fetch_failures:
        print(f"Skipped (404 on config fetch): {len(fetch_failures)}")


def _handle_policy_check(target: str) -> int:
    target_path = Path(target)
    if target_path.exists() and target_path.suffix in (".yaml", ".yml"):
        from .simulate import evaluate_yaml_policy

        entities, services, decision = evaluate_yaml_policy(target_path)
        print(
            json.dumps(
                {
                    "file": str(target_path),
                    "blocked": decision.blocked,
                    "severity": decision.severity.value,
                    "entities": entities,
                    "services": services,
                    "reasons": decision.reasons,
                },
                indent=2,
            )
        )
        return 1 if decision.blocked else 0
    result = check_entity(target)
    print(json.dumps(result, indent=2))
    return 1 if result["sensitive"] else 0


def refresh_context(root: Path, client: HomeAssistantClient) -> dict[str, Any]:
    from concurrent.futures import ThreadPoolExecutor

    paths = ["/api/", "/api/config", "/api/components", "/api/services", "/api/states"]
    with ThreadPoolExecutor(max_workers=len(paths)) as pool:
        api_root, config, components, services, states = pool.map(client.get, paths)

    snapshot = {
        "api": api_root,
        "config": config,
        "components": components,
        "services": services,
        "states": states,
    }
    write_json_artifact(root, ".claude-code-hermit/raw", "snapshot-ha-context", snapshot, latest_name="snapshot-ha-context-latest.json")

    normalized = normalize_context(states, services, components)
    write_json_artifact(root, ".claude-code-hermit/raw", "snapshot-ha-normalized", normalized, latest_name="snapshot-ha-normalized-latest.json")
    write_markdown_artifact(
        root,
        ".claude-code-hermit/raw",
        "audit-ha-context-refresh",
        standard_metadata(
            "audit",
            "HA Context Refresh",
            session=current_session_id(root),
            tags=["ha-context", "refresh"],
            extra={
                "source": "routine",
                "entity_count": len(normalized["entity_index"]),
                "service_domain_count": len(normalized["service_index"]),
            },
        ),
        "\n".join(
            [
                "# Home Assistant Context Refresh",
                "",
                f"- entities: {len(normalized['entity_index'])}",
                f"- service_domains: {len(normalized['service_index'])}",
                f"- components: {len(normalized['components'])}",
            ]
        ),
        latest_name="audit-ha-context-refresh-latest.md",
    )
    return normalized


def refresh_context_incremental(
    root: Path, client: HomeAssistantClient
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Fetch only /api/states, diff against the existing artifact, and merge the delta.

    Returns (updated_normalized, delta_summary).
    Falls back to a full refresh if no baseline artifact exists.
    """
    baseline_path = normalized_context_path(root)
    if not baseline_path.exists():
        payload = refresh_context(root, client)
        empty_delta: dict[str, Any] = {"added": [], "removed": [], "changed": []}
        return payload, empty_delta

    baseline: dict[str, Any] = json.loads(baseline_path.read_text(encoding="utf-8"))
    baseline_index: dict[str, Any] = baseline.get("entity_index", {})

    states: list[dict[str, Any]] = client.get("/api/states")
    new_index = normalize_entity_index(states)

    baseline_ids = set(baseline_index)
    new_ids = set(new_index)

    added = sorted(new_ids - baseline_ids)
    removed = sorted(baseline_ids - new_ids)
    changed = sorted(
        eid
        for eid in baseline_ids & new_ids
        if new_index[eid].get("state") != baseline_index[eid].get("state")
        or new_index[eid].get("last_updated") != baseline_index[eid].get("last_updated")
    )

    merged_index = dict(baseline_index)
    for eid in added + changed:
        merged_index[eid] = new_index[eid]
    for eid in removed:
        del merged_index[eid]

    unavailable_entities = _collect_unavailable(merged_index)

    normalized: dict[str, Any] = {
        **baseline,
        "entity_index": merged_index,
        "unavailable_entities": unavailable_entities,
    }

    write_json_artifact(
        root, ".claude-code-hermit/raw", "snapshot-ha-normalized", normalized, latest_name="snapshot-ha-normalized-latest.json"
    )

    delta: dict[str, Any] = {
        "mode": "incremental",
        "timestamp": utc_timestamp(),
        "added": added,
        "removed": removed,
        "changed": changed,
        "unavailable_total": len(unavailable_entities),
        "entity_total": len(merged_index),
    }
    write_json_artifact(root, ".claude-code-hermit/raw", "snapshot-ha-delta", delta)

    write_markdown_artifact(
        root,
        ".claude-code-hermit/raw",
        "audit-ha-context-refresh",
        standard_metadata(
            "audit",
            "HA Context Refresh (incremental)",
            session=current_session_id(root),
            tags=["ha-context", "refresh", "incremental"],
            extra={
                "source": "routine",
                "mode": "incremental",
                "entity_count": len(merged_index),
                "added": len(added),
                "removed": len(removed),
                "changed": len(changed),
                "unavailable": len(unavailable_entities),
            },
        ),
        "\n".join(
            [
                "# Home Assistant Context Refresh (incremental)",
                "",
                f"- entities: {len(merged_index)}",
                f"- added: {len(added)}",
                f"- removed: {len(removed)}",
                f"- changed: {len(changed)}",
                f"- unavailable: {len(unavailable_entities)}",
            ]
        ),
        latest_name="audit-ha-context-refresh-latest.md",
    )

    return normalized, delta


def _collect_unavailable(entity_index: dict[str, Any]) -> list[str]:
    return sorted(
        eid for eid, state in entity_index.items() if str(state.get("state")) in {"unavailable", "unknown"}
    )


def normalize_context(states: list[dict[str, Any]], services: list[dict[str, Any]], components: list[str]) -> dict[str, Any]:
    entity_index = normalize_entity_index(states)
    service_index: dict[str, list[str]] = {}
    for item in services:
        domain = item.get("domain")
        if not isinstance(domain, str):
            continue
        services_payload = item.get("services", {})
        service_names: set[str] = set()
        if isinstance(services_payload, dict):
            for name, metadata in services_payload.items():
                if isinstance(name, str):
                    service_names.add(name)
        elif isinstance(services_payload, list):
            for service in services_payload:
                if isinstance(service, dict):
                    name = service.get("service")
                    if isinstance(name, str):
                        service_names.add(name)
        service_index[domain] = sorted(service_names)
    return {
        "entity_index": entity_index,
        "service_index": service_index,
        "components": sorted(component for component in components if isinstance(component, str)),
        "unavailable_entities": _collect_unavailable(entity_index),
    }
