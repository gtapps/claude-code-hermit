# Safety Policy

This plugin controls real home devices. The safety model is layered — the agent's instructions keep it cautious, and a hook enforces the rules even if the agent tries to bypass them.

## How Actuation Is Gated

Every MCP call to the Home Assistant server (`mcp__homeassistant__*`) is pre-screened by `hooks/mcp-safety-gate.ts` (importing the policy from `src/policy.ts` directly) before it reaches Home Assistant. The matcher covers **all** HA MCP tools — including script-derived tools (an exposed HA script becomes a tool named by its bare object_id, with no `Hass` prefix and no `entity_id` parameter), which would otherwise bypass the gate entirely. The read-only `GetLiveContext` / `GetDateTime` tools are allowlisted inside the gate (they carry no target and never actuate). The hook fails closed — if the policy check errors, the input can't be parsed, or the target can't be resolved to a concrete entity, the call is blocked (exit 2).

## What's Blocked by Default

- **Sensitive domains**: `lock`, `alarm_control_panel`
- **Security-tagged devices**: `cover`, `button`, `switch` entities matching security-related keywords (door, gate, garage, etc.)
- **Unresolvable targets**: any call carrying an `area_id`/`floor_id`/`label_id`/`device_id` selector that does not resolve to a concrete, well-formed `entity_id` — blocked even when a safe concrete `entity_id` is also present (the selector fans out server-side to entities the gate cannot enumerate). Domain matching is case-insensitive (`LOCK.front_door` is treated as `lock`); malformed ids with an empty domain (e.g. `.lock`) are rejected as unresolvable.
- **Opaque (script-derived) tools**: a call that carries no `entity_id` and no targeting selector — the canonical case is an exposed HA script, which has no classifiable target. Blocked under `strict` (becomes a proposal); under `ask`, the operator is prompted. (An unnamed/garbage call with no `tool_name` always hard-blocks. A `Hass*` intent tool that targets by `name`/`area` is **not** opaque in this sense — it fans out server-side like an `area_id` selector, so it hard-blocks in every mode.)
- **Anything explicitly listed** in the sensitive-domain or sensitive-keyword policy

Blocked operations do not silently fail — they become proposals for human review.

## Safety Mode

The safety gate has a two-tier configurable mode stored in `.claude-code-hermit/config.json` under `ha_safety_mode`. Set during `/claude-code-homeassistant-hermit:hatch` and adjustable afterwards.

| Mode | Behaviour |
|------|-----------|
| `strict` (default) | Always blocked — no agent-drafted automation or MCP call can actuate sensitive domains. Blocked work becomes a proposal. |
| `ask` | Operator is prompted before any actuation of a sensitive entity. The `ha-apply-change` skill requires `AskUserQuestion` confirmation before pushing. Direct MCP calls emit `permissionDecision: "ask"` so Claude Code itself prompts the operator before allowing the call — enforced by the harness, not by agent convention. |

Both tiers enforce confirmation through the runtime; there is no "operator-owns-the-risk" mode by design — actuation of locks and alarms has no software undo.

The mode dial does **not** relax the hard fail-closed branch: an unresolvable `area_id`/`floor_id`/`label_id`/`device_id` fan-out, a `Hass*` intent tool that targets by `name`/`area`, a malformed `entity_id`, or an unnamed/garbage call all still block regardless of mode (the target set can't be enumerated, so it could hit a sensitive entity). The one mode-dependent case is an **opaque named script tool** (a bare-`object_id` call with no concrete target and no fan-out selector): `strict` blocks it, `ask` prompts the operator — same as it does for a concrete sensitive entity. The `HA_SAFE_ENTITIES` per-entity allowlist still takes precedence over both modes — a listed entity is always allowed.

Change the mode by editing `ha_safety_mode` in `.claude-code-hermit/config.json` or re-running `/claude-code-homeassistant-hermit:hatch`.

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

Policy source of truth is `src/policy.ts`, enforced at the harness level by `hooks/mcp-safety-gate.ts`. Changes to either file are considered sensitive — review carefully and run the test suite before shipping:

```bash
bun test
```

`tests/gate-corpus.test.ts` replays the retired Python gates (from git history) side by side with the TS hooks and asserts byte-identical verdicts; `tests/gate-fuzz.test.ts` property-tests the fail-closed guarantee on arbitrary garbage input. Both must stay green for any hook or policy change.

When in doubt the hook fails closed. You can always relax the policy, but you have to do it deliberately.

## Hook Profile Gating

`hooks/mcp-safety-gate.ts` runs on **all profiles** by design — actuation gating is non-optional and must hold even in `lite` and `default` profiles where the operator may have loosened other controls.

`hooks/curl-host-gate.ts` (convenience auto-approver for curl/wget to the HA instance) is gated to `standard,strict` profiles. In `lite` profile it does not run, so HA URL calls go through the normal permission flow instead of being auto-approved.
