from __future__ import annotations

import argparse
import json
import sys
from datetime import date
from pathlib import Path
from typing import Any

from .apply import validate_and_apply
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
        help="Audit all live HA automations against the safety policy (plugin_check entry point).",
    )

    probe_parser = ha_subparsers.add_parser(
        "probe",
        help="GET a raw HA REST path and print the JSON response. Useful for verifying endpoints.",
    )
    probe_parser.add_argument("path", help="HA REST path, e.g. /api/config/automation/config/1234")

    errors_parser = ha_subparsers.add_parser(
        "automation-errors",
        help="Scan HA error log for recurring automation failures (plugin_check entry point).",
    )
    errors_parser.add_argument(
        "--min-hits",
        type=int,
        default=3,
        help="Minimum error-pattern hits per automation to flag (default: 3).",
    )

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
        changes = save_boot_preferences(root, args.language, args.url, args.local_url, args.remote_url, args.token)
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
            _print_safety_audit_summary(summary)
            return 0
        except HomeAssistantError as exc:
            print(str(exc))
            return 1

    if args.command == "ha" and args.ha_command == "automation-errors":
        try:
            from .audits import review_automation_errors

            client = HomeAssistantClient(config)
            summary = review_automation_errors(root, client, min_hits=args.min_hits)
            _print_automation_errors_summary(summary)
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

    parser.error("Unsupported command.")
    return 1


def _print_safety_audit_summary(summary: dict[str, Any]) -> None:
    violations = summary.get("violations", [])
    total = summary.get("total_automations", 0)
    unmanaged = summary.get("unmanaged", [])
    fetch_failures = summary.get("fetch_failures", [])
    print(f"ha-safety-audit findings — {date.today().isoformat()}")
    if not violations:
        print(f"No actionable findings. ({total} automations scanned)")
    else:
        print(f"Policy violations: {len(violations)}")
        for v in violations:
            reasons = "; ".join(v.get("reasons", []))
            print(f"- {v.get('alias')} (`{v.get('id')}`): {reasons}")
        print(f"No action needed: {summary['passed']} automations passed")
    if unmanaged:
        print(f"Skipped (no numeric id): {len(unmanaged)}")
    if fetch_failures:
        print(f"Skipped (404 on config fetch): {len(fetch_failures)}")


def _print_automation_errors_summary(summary: dict[str, Any]) -> None:
    flagged = summary.get("flagged_automations", [])
    print(f"ha-automation-errors findings — {date.today().isoformat()}")
    if not flagged:
        print("No actionable findings.")
        return
    print(f"Automations with recurring errors: {len(flagged)}")
    for item in flagged:
        print(f"- {item['entity_id']}: {item['count']} error-pattern hits")


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
