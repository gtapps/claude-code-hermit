# Safety Policy

This plugin controls real home devices. The safety model is layered — the agent's instructions keep it cautious, and a hook enforces the rules even if the agent tries to bypass them.

## How Actuation Is Gated

Every MCP call matching `mcp__homeassistant__Hass*` is pre-screened by `hooks/mcp-safety-gate.py` against `src/ha_agent_lab/policy.py` before it reaches Home Assistant. The hook fails closed — if the policy check errors or the target can't be resolved to a concrete entity, the call is blocked.

## What's Blocked by Default

- **Sensitive domains**: `lock`, `alarm_control_panel`
- **Security-tagged devices**: `cover`, `button`, `switch` entities matching security-related keywords (door, gate, garage, etc.)
- **Unresolvable targets**: calls that specify only an `area_id` or `device_id` with no concrete `entity_id`
- **Anything explicitly listed** in the sensitive-domain or sensitive-keyword policy

Blocked operations do not silently fail — they become proposals for human review.

## Policy Overrides

Configured via environment variables in `.env` (see `.env.example`):

| Variable                      | Effect                                                     |
| ----------------------------- | ---------------------------------------------------------- |
| `HA_SAFE_ENTITIES`            | Per-entity allow-list. Exact IDs only, no wildcards.       |
| `HA_EXTRA_SENSITIVE_DOMAINS`  | Block additional domains entirely.                         |
| `HA_EXTRA_SENSITIVE_KEYWORDS` | Block extra keywords in conditionally-sensitive domains.   |

Example:

```
HA_SAFE_ENTITIES=cover.garage_door,switch.coffee_machine
HA_EXTRA_SENSITIVE_DOMAINS=vacuum,media_player
HA_EXTRA_SENSITIVE_KEYWORDS=pool,pump
```

## Checking a Target

Before wiring anything to the policy, you can ask what it would decide:

```bash
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha policy-check <entity_id_or_yaml>
```

## Reviewing Live Automations

The `ha-safety-audit` plugin check runs weekly and re-audits every live automation against the current policy. Findings surface as proposals.

Run on demand:

```
/claude-code-homeassistant-hermit:ha-safety-audit
```

## Changing the Policy

Policy source of truth is `src/ha_agent_lab/policy.py`. Changes to this file are considered sensitive — review carefully and run the test suite before shipping:

```bash
.venv/bin/pytest tests/ -v
```

When in doubt the hook fails closed. You can always relax the policy, but you have to do it deliberately.

## Hook Profile Gating

`hooks/mcp-safety-gate.py` runs on **all profiles** by design — actuation gating is non-optional and must hold even in `lite` and `default` profiles where the operator may have loosened other controls.

`hooks/curl-host-gate.py` (convenience auto-approver for curl/wget to the HA instance) is gated to `standard,strict` profiles. In `lite` profile it does not run, so HA URL calls go through the normal permission flow instead of being auto-approved.
