from __future__ import annotations

import yaml
from dataclasses import dataclass
from pathlib import Path

from .artifacts import current_session_id, slugify, standard_metadata, write_markdown_artifact
from .ha_api import HomeAssistantClient, HomeAssistantError, extract_ha_error_message
from .policy import can_reload_domain
from .simulate import SimulationResult, simulate_artifact

_CONFIG_DOMAINS = {"automation", "script"}


def _unsupported_domain_msg(domain: str) -> str:
    return f"Domain '{domain}' is not a configurable domain. Choose from: {', '.join(sorted(_CONFIG_DOMAINS))}."


@dataclass(slots=True)
class ApplyResult:
    ok: bool
    config_check_ok: bool
    config_id: str | None
    domain: str | None
    creation_attempted: bool
    creation_ok: bool
    reload_attempted: bool
    reload_domain: str | None
    message: str
    report_path: Path


@dataclass(slots=True)
class ReadResult:
    ok: bool
    domain: str
    config_id: str
    config: dict
    message: str


@dataclass(slots=True)
class RemoveResult:
    ok: bool
    domain: str
    config_id: str
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
            root, artifact_path, simulation,
            config_check_ok=False, config_id=None, creation_attempted=False,
            creation_ok=False, reload_attempted=False, reload_domain=reload_domain,
            message="Simulation failed. See missing entities or blocked reasons.",
        )
        return ApplyResult(
            ok=False, config_check_ok=False, config_id=None, domain=reload_domain,
            creation_attempted=False, creation_ok=False, reload_attempted=False,
            reload_domain=reload_domain, message="simulation-failed", report_path=report_path,
        )

    try:
        check_result = client.post("/api/config/core/check_config", {})
        config_ok = _is_truthy(check_result)
    except HomeAssistantError as exc:
        report_path = _write_apply_report(
            root, artifact_path, simulation,
            config_check_ok=False, config_id=None, creation_attempted=False,
            creation_ok=False, reload_attempted=False, reload_domain=reload_domain,
            message=f"Config validation failed: {exc}",
        )
        return ApplyResult(
            ok=False, config_check_ok=False, config_id=None, domain=reload_domain,
            creation_attempted=False, creation_ok=False, reload_attempted=False,
            reload_domain=reload_domain, message=str(exc), report_path=report_path,
        )

    config_id: str | None = None
    creation_attempted = False
    creation_ok = False
    drift_warning: str | None = None
    yaml_mode_message: str | None = None

    if reload_domain and not can_reload_domain(reload_domain):
        report_path = _write_apply_report(
            root, artifact_path, simulation,
            config_check_ok=config_ok, config_id=None, creation_attempted=False,
            creation_ok=False, reload_attempted=False, reload_domain=reload_domain,
            message=f"Reload domain `{reload_domain}` is not allowed.",
        )
        return ApplyResult(
            ok=False, config_check_ok=config_ok, config_id=None, domain=reload_domain,
            creation_attempted=False, creation_ok=False, reload_attempted=False,
            reload_domain=reload_domain, message="reload-blocked", report_path=report_path,
        )

    if reload_domain in _CONFIG_DOMAINS:
        artifact_config = yaml.safe_load(artifact_path.read_text(encoding="utf-8")) or {}
        config_id = (
            str(artifact_config.get("id") or "").strip()
            or slugify(str(artifact_config.get("alias") or "").strip())
            or slugify(artifact_path.stem)
        )
        if not str(artifact_config.get("id") or "").strip():
            drift_warning = (
                f"id '{config_id}' derived from {'alias' if artifact_config.get('alias') else 'filename'} — "
                f"set id: explicitly in the YAML to prevent drift on rename."
            )

        creation_attempted = True
        try:
            client.post(f"/api/config/{reload_domain}/config/{config_id}", artifact_config)
            try:
                verify = client.get(f"/api/config/{reload_domain}/config/{config_id}")
                creation_ok = verify.get("alias") == artifact_config.get("alias")
            except HomeAssistantError:
                creation_ok = False
        except HomeAssistantError as exc:
            if exc.status_code == 403:
                yaml_mode_message = (
                    f"YAML mode: HA rejected REST config push (403). "
                    f"Place the generated YAML in your HA config directory and reload {reload_domain}."
                )
            else:
                ha_message = extract_ha_error_message(exc)
                msg = f"Config push failed: {ha_message}"
                report_path = _write_apply_report(
                    root, artifact_path, simulation,
                    config_check_ok=config_ok, config_id=config_id, creation_attempted=True,
                    creation_ok=False, reload_attempted=False, reload_domain=reload_domain,
                    message=msg,
                )
                return ApplyResult(
                    ok=False, config_check_ok=config_ok, config_id=config_id, domain=reload_domain,
                    creation_attempted=True, creation_ok=False, reload_attempted=False,
                    reload_domain=reload_domain, message=msg, report_path=report_path,
                )

    reload_attempted = False
    if reload_domain:
        client.post(f"/api/services/{reload_domain}/reload", {})
        reload_attempted = True

    parts = ["Validation succeeded. Apply flow completed."]
    if creation_attempted and creation_ok:
        parts.append(f"Config pushed and verified via REST ({reload_domain}/{config_id}).")
    elif yaml_mode_message:
        parts.append(yaml_mode_message)
    else:
        parts.append(
            "Generated YAML must still be present in Home Assistant includes for reload to take effect."
        )
    if drift_warning:
        parts.append(drift_warning)
    message = " ".join(parts)

    report_path = _write_apply_report(
        root, artifact_path, simulation,
        config_check_ok=config_ok, config_id=config_id, creation_attempted=creation_attempted,
        creation_ok=creation_ok, reload_attempted=reload_attempted, reload_domain=reload_domain,
        message=message,
    )
    return ApplyResult(
        ok=True, config_check_ok=config_ok, config_id=config_id, domain=reload_domain,
        creation_attempted=creation_attempted, creation_ok=creation_ok,
        reload_attempted=reload_attempted, reload_domain=reload_domain,
        message=message, report_path=report_path,
    )


def read_config(
    client: HomeAssistantClient,
    domain: str,
    config_id: str,
) -> ReadResult:
    if domain not in _CONFIG_DOMAINS:
        return ReadResult(ok=False, domain=domain, config_id=config_id, config={}, message=_unsupported_domain_msg(domain))

    try:
        config = client.get(f"/api/config/{domain}/config/{config_id}")
        return ReadResult(ok=True, domain=domain, config_id=config_id, config=config, message="ok")
    except HomeAssistantError as exc:
        return ReadResult(ok=False, domain=domain, config_id=config_id, config={}, message=extract_ha_error_message(exc))


def remove_config(
    root: Path,
    client: HomeAssistantClient,
    domain: str,
    config_id: str,
) -> RemoveResult:
    if domain not in _CONFIG_DOMAINS:
        msg = _unsupported_domain_msg(domain)
        report_path = _write_remove_report(root, domain, config_id, ok=False, message=msg)
        return RemoveResult(ok=False, domain=domain, config_id=config_id, message=msg, report_path=report_path)

    try:
        result = client.delete(f"/api/config/{domain}/config/{config_id}")
        ok = isinstance(result, dict) and result.get("result") == "ok"
        message = "ok" if ok else f"unexpected response: {result}"
    except HomeAssistantError as exc:
        ok = False
        message = extract_ha_error_message(exc)

    report_path = _write_remove_report(root, domain, config_id, ok=ok, message=message)
    return RemoveResult(ok=ok, domain=domain, config_id=config_id, message=message, report_path=report_path)


def _write_apply_report(
    root: Path,
    artifact_path: Path,
    simulation: SimulationResult,
    *,
    config_check_ok: bool,
    config_id: str | None,
    creation_attempted: bool,
    creation_ok: bool,
    reload_attempted: bool,
    reload_domain: str | None,
    message: str,
) -> Path:
    metadata = standard_metadata(
        "apply",
        f"Apply Report — {artifact_path.name}",
        session=current_session_id(root),
        tags=["apply", "ha-automation"],
        extra={
            "artifact_path": str(artifact_path.relative_to(root)),
            "config_check_ok": config_check_ok,
            "config_id": config_id,
            "creation_attempted": creation_attempted,
            "creation_ok": creation_ok,
            "reload_attempted": reload_attempted,
            "reload_domain": reload_domain,
            "simulation_valid": simulation.is_valid,
            "message": message,
        },
    )
    body = "\n".join(
        [
            f"# Apply Report for `{artifact_path.name}`",
            "",
            f"- simulation_valid: {str(simulation.is_valid).lower()}",
            f"- config_check_ok: {str(config_check_ok).lower()}",
            f"- config_id: {config_id or 'none'}",
            f"- creation_attempted: {str(creation_attempted).lower()}",
            f"- creation_ok: {str(creation_ok).lower()}",
            f"- reload_attempted: {str(reload_attempted).lower()}",
            f"- reload_domain: {reload_domain or 'none'}",
            "",
            f"Message: {message}",
        ]
    )
    slug = f"audit-ha-apply-{slugify(artifact_path.stem)}"
    return write_markdown_artifact(
        root,
        ".claude-code-hermit/raw",
        slug,
        metadata,
        body,
        latest_name="audit-ha-apply-latest.md",
    )


def _write_remove_report(
    root: Path,
    domain: str,
    config_id: str,
    *,
    ok: bool,
    message: str,
) -> Path:
    metadata = standard_metadata(
        "remove",
        f"Remove Report — {domain}/{config_id}",
        session=current_session_id(root),
        tags=["ha-remove", f"ha-{domain}"],
        extra={
            "domain": domain,
            "config_id": config_id,
            "ok": ok,
            "message": message,
        },
    )
    body = "\n".join(
        [
            f"# Remove Report for `{domain}/{config_id}`",
            "",
            f"- ok: {str(ok).lower()}",
            f"- domain: {domain}",
            f"- config_id: {config_id}",
            "",
            f"Message: {message}",
        ]
    )
    slug = f"audit-ha-remove-{domain}-{slugify(config_id)}"
    return write_markdown_artifact(
        root,
        ".claude-code-hermit/raw",
        slug,
        metadata,
        body,
        latest_name="audit-ha-remove-latest.md",
    )


def _is_truthy(check_result: object) -> bool:
    if isinstance(check_result, bool):
        return check_result
    if isinstance(check_result, dict):
        if "result" in check_result:
            return check_result["result"] == "valid"
        return not any(value is False for value in check_result.values())
    return bool(check_result)
