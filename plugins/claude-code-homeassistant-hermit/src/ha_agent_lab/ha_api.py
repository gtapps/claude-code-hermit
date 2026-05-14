"""Home Assistant REST client. Upstream contract: https://developers.home-assistant.io/docs/api/rest/"""
from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass
from datetime import datetime
from typing import Any
from urllib import error, parse, request

from . import __version__
from .config import AppConfig, load_config

_USER_AGENT = os.environ.get("HOMEASSISTANT_USER_AGENT") or f"ha-agent-lab/{__version__} (+https://github.com/gtapps/claude-code-hermit)"


@dataclass(slots=True)
class HomeAssistantError(Exception):
    message: str
    status_code: int | None = None
    payload: Any | None = None

    def __str__(self) -> str:
        if self.status_code is None:
            return self.message
        return f"{self.message} (status={self.status_code})"


class HomeAssistantClient:
    def __init__(self, config: AppConfig) -> None:
        missing_fields = config.missing_ha_configuration_fields()
        if missing_fields:
            raise HomeAssistantError(
                "Missing Home Assistant configuration: "
                f"{', '.join(missing_fields)}. "
                "Run `./bin/ha-agent-lab boot status --probe` and persist the missing values."
            )
        self.config = config
        self.base_url, self.base_url_source = select_home_assistant_url(config)

    def get(self, path: str) -> Any:
        return self._request("GET", path, None)

    def post(self, path: str, payload: dict[str, Any] | None = None) -> Any:
        return self._request("POST", path, payload)

    def delete(self, path: str) -> Any:
        return self._request("DELETE", path, None)

    def get_states(self) -> list[dict[str, Any]]:
        return self.get("/api/states")

    def get_state(self, entity_id: str) -> dict[str, Any]:
        return self.get(f"/api/states/{entity_id}")

    def get_history(
        self,
        entity_ids: list[str],
        start_time: datetime,
        end_time: datetime,
        *,
        minimal_response: bool = True,
        significant_changes_only: bool = True,
    ) -> dict[str, list[dict[str, Any]]]:
        """Fetch state-change history for the given entities over [start_time, end_time].

        Returns {entity_id: [state_change, ...]}. Entities with no events in the window
        are absent from the result — callers that need zero-count rows synthesize them.

        Raises HomeAssistantError if entity_ids is empty (avoids an unbounded all-entity fetch).
        Flags are sent as bare query params (minimal_response, not minimal_response=true)
        matching the HA REST API docs.
        """
        if not entity_ids:
            raise HomeAssistantError("get_history requires entity_ids — pass at least one entity ID")

        start_iso = parse.quote(start_time.isoformat(), safe="")
        params = f"filter_entity_id={','.join(parse.quote(e, safe='') for e in entity_ids)}"
        params += f"&end_time={parse.quote(end_time.isoformat(), safe='')}"
        if minimal_response:
            params += "&minimal_response"
        if significant_changes_only:
            params += "&significant_changes_only"

        response: list[list[dict[str, Any]]] = self.get(f"/api/history/period/{start_iso}?{params}")
        if not isinstance(response, list):
            return {}
        result: dict[str, list[dict[str, Any]]] = {}
        for inner in response:
            if inner and isinstance(inner[0], dict) and "entity_id" in inner[0]:
                result[inner[0]["entity_id"]] = inner
        return result

    def _request(self, method: str, path: str, payload: dict[str, Any] | None) -> Any:
        if not self.config.ha_token:
            raise HomeAssistantError("HOMEASSISTANT_TOKEN is not configured.")
        url = f"{self.base_url.rstrip('/')}{path}"
        data = None
        headers = {
            "Authorization": f"Bearer {self.config.ha_token}",
            "Content-Type": "application/json",
            "User-Agent": _USER_AGENT,
        }
        if payload is not None:
            data = json.dumps(payload).encode("utf-8")

        for attempt in range(self.config.retry_count + 1):
            req = request.Request(url, data=data, headers=headers, method=method)
            try:
                with request.urlopen(req, timeout=self.config.timeout_seconds) as response:
                    text = response.read().decode("utf-8")
                    if not text.strip():
                        return {}
                    try:
                        return json.loads(text)
                    except json.JSONDecodeError as exc:
                        raise HomeAssistantError("Malformed JSON from Home Assistant.", payload=text) from exc
            except error.HTTPError as exc:
                body = exc.read().decode("utf-8", errors="replace")
                raise HomeAssistantError(
                    message=self._http_error_message(exc.code),
                    status_code=exc.code,
                    payload=body,
                ) from exc
            except error.URLError as exc:
                if attempt >= self.config.retry_count:
                    raise HomeAssistantError("Failed to reach Home Assistant.", payload=str(exc)) from exc
                time.sleep(0.25 * (attempt + 1))

        raise HomeAssistantError("Exhausted Home Assistant retries.")

    @staticmethod
    def _http_error_message(status_code: int) -> str:
        mapping = {
            401: "Unauthorized Home Assistant request.",
            403: "Forbidden: Home Assistant is in YAML mode (REST config API unavailable).",
            404: "Home Assistant endpoint not found.",
            405: "Home Assistant method not allowed.",
        }
        return mapping.get(status_code, "Home Assistant request failed.")


def extract_ha_error_message(exc: HomeAssistantError) -> str:
    """Pull HA's structured {"message": "..."} body from the error; fall back to str(exc)."""
    if isinstance(exc.payload, str):
        try:
            parsed = json.loads(exc.payload)
            if isinstance(parsed, dict) and isinstance(parsed.get("message"), str):
                return parsed["message"]
        except json.JSONDecodeError:
            pass
    return str(exc)


def probe_home_assistant_url(base_url: str, token: str, timeout_seconds: int) -> bool:
    url = f"{base_url.rstrip('/')}/api/"
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
        "User-Agent": _USER_AGENT,
    }
    req = request.Request(url, headers=headers, method="GET")
    try:
        with request.urlopen(req, timeout=timeout_seconds):
            return True
    except (error.URLError, error.HTTPError):
        return False


def select_home_assistant_url(config: AppConfig) -> tuple[str, str]:
    if not config.ha_token:
        raise HomeAssistantError("HOMEASSISTANT_TOKEN is not configured.")

    # Dual-URL mode: user opted in by setting both LOCAL and REMOTE — probe with fallback.
    if config.ha_local_url and config.ha_remote_url:
        if probe_home_assistant_url(config.ha_local_url, config.ha_token, config.timeout_seconds):
            return config.ha_local_url, "local"
        if probe_home_assistant_url(config.ha_remote_url, config.ha_token, config.timeout_seconds):
            return config.ha_remote_url, "remote"
        return config.ha_local_url, "fallback"

    # Single-URL mode: HOMEASSISTANT_URL, or whichever of LOCAL/REMOTE is set alone.
    url = config.primary_url()
    if not url:
        raise HomeAssistantError("Missing Home Assistant base URL configuration.")
    return url, "single"
