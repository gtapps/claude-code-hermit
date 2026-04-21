from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from .artifacts import write_markdown_artifact
from .ha_api import HomeAssistantClient, HomeAssistantError
from .policy import can_reload_domain
from .simulate import SimulationResult, simulate_artifact


@dataclass(slots=True)
class ApplyResult:
    ok: bool
    config_check_ok: bool
    reload_attempted: bool
    reload_domain: str | None
    message: str
    report_path: Path


def validate_and_apply(
    root: Path,
    client: HomeAssistantClient,
    artifact_path: Path,
    reload_domain: str | None = None,
) -> ApplyResult:
    simulation = simulate_artifact(root, artifact_path)

    if not simulation.is_valid:
        report_path = _write_apply_report(
            root,
            artifact_path,
            simulation,
            False,
            False,
            reload_domain,
            "Simulation failed. See missing entities or blocked reasons.",
        )
        return ApplyResult(False, False, False, reload_domain, "simulation-failed", report_path)

    try:
        check_result = client.post("/api/config/core/check_config", {})
        config_ok = _is_truthy(check_result)
    except HomeAssistantError as exc:
        report_path = _write_apply_report(
            root,
            artifact_path,
            simulation,
            False,
            False,
            reload_domain,
            f"Config validation failed: {exc}",
        )
        return ApplyResult(False, False, False, reload_domain, str(exc), report_path)

    reload_attempted = False
    if reload_domain:
        if not can_reload_domain(reload_domain):
            report_path = _write_apply_report(
                root,
                artifact_path,
                simulation,
                False,
                False,
                reload_domain,
                f"Reload domain `{reload_domain}` is not allowed.",
            )
            return ApplyResult(False, config_ok, False, reload_domain, "reload-blocked", report_path)
        client.post(f"/api/services/{reload_domain}/reload", {})
        reload_attempted = True

    message = (
        "Validation succeeded. Apply flow completed. "
        "Generated YAML must still be present in Home Assistant includes for reload to take effect."
    )
    report_path = _write_apply_report(
        root,
        artifact_path,
        simulation,
        config_ok,
        reload_attempted,
        reload_domain,
        message,
    )
    return ApplyResult(True, config_ok, reload_attempted, reload_domain, message, report_path)


def _write_apply_report(
    root: Path,
    artifact_path: Path,
    simulation: SimulationResult,
    config_check_ok: bool,
    reload_attempted: bool,
    reload_domain: str | None,
    message: str,
) -> Path:
    metadata = {
        "artifact_path": str(artifact_path.relative_to(root)),
        "config_check_ok": config_check_ok,
        "reload_attempted": reload_attempted,
        "reload_domain": reload_domain,
        "simulation_valid": simulation.is_valid,
        "message": message,
    }
    body = "\n".join(
        [
            f"# Apply Report for `{artifact_path.name}`",
            "",
            f"- simulation_valid: {str(simulation.is_valid).lower()}",
            f"- config_check_ok: {str(config_check_ok).lower()}",
            f"- reload_attempted: {str(reload_attempted).lower()}",
            f"- reload_domain: {reload_domain or 'none'}",
            "",
            f"Message: {message}",
        ]
    )
    return write_markdown_artifact(
        root,
        ".claude-code-hermit/raw",
        f"audit-ha-apply__{artifact_path.stem}",
        metadata,
        body,
        latest_name="audit-ha-apply-latest.md",
    )


def _is_truthy(check_result: object) -> bool:
    if isinstance(check_result, bool):
        return check_result
    if isinstance(check_result, dict):
        if "result" in check_result:
            return check_result["result"] == "valid"
        return not any(value is False for value in check_result.values())
    return bool(check_result)
