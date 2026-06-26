# Safety Policy

This plugin controls real home devices. The safety model is layered — the agent's instructions keep it cautious, and a hook enforces the rules even if the agent tries to bypass them.

## How Actuation Is Gated

Every MCP call matching `mcp__homeassistant__.*` is pre-screened by `hooks/mcp-safety-gate.ts` (importing the policy from `src/policy.ts` directly) before it reaches Home Assistant. The matcher covers the **whole** `homeassistant` server namespace — a default-deny chokepoint — so script-derived and any other non-`Hass`-prefixed actuation tools cannot bypass the gate. The hook fails closed — if the policy check errors, the input can't be parsed, or the target can't be resolved to a concrete entity, the call is blocked (exit 2).

A small explicit allowlist of **read-only** tools (`GetLiveContext`, `GetDateTime` — see `READ_ONLY_TOOLS` in `src/policy.ts`) is short-circuited to allow before entity resolution, since they carry no `entity_id` and would otherwise fail closed. The allowlist is an explicit name set, not a pattern, so a future mutating tool cannot be granted by accident.

## What's Blocked by Default

- **Sensitive domains**: `lock`, `alarm_control_panel`
- **Security-tagged devices**: `cover`, `button`, `switch` entities matching security-related keywords (door, gate, garage, etc.)
- **Unresolvable targets**: any call carrying an `area_id`/`floor_id`/`label_id`/`device_id` selector that does not resolve to a concrete, well-formed `entity_id` — blocked even when a safe concrete `entity_id` is also present (the selector fans out server-side to entities the gate cannot enumerate). Domain matching is case-insensitive (`LOCK.front_door` is treated as `lock`); malformed ids with an empty domain (e.g. `.lock`) are rejected as unresolvable.
- **Anything explicitly listed** in the sensitive-domain or sensitive-keyword policy

Blocked operations do not silently fail — they become proposals for human review.

## Safety Mode

The safety gate has a two-tier configurable mode stored in `.claude-code-hermit/config.json` under `ha_safety_mode`. Set during `/claude-code-homeassistant-hermit:hatch` and adjustable afterwards.

| Mode | Behaviour |
|------|-----------|
| `strict` (default) | Always blocked — no agent-drafted automation or MCP call can actuate sensitive domains. Blocked work becomes a proposal. |
| `ask` | Operator is prompted before any actuation of a sensitive entity. The `ha-apply-change` skill requires `AskUserQuestion` confirmation before pushing. Direct MCP calls emit `permissionDecision: "ask"` so Claude Code itself prompts the operator before allowing the call — enforced by the harness, not by agent convention. |

Both tiers enforce confirmation through the runtime; there is no "operator-owns-the-risk" mode by design — actuation of locks and alarms has no software undo.

The mode dial does **not** relax the fail-closed branch: if the hook cannot resolve the target to a concrete `entity_id`, it still blocks regardless of mode. The `HA_SAFE_ENTITIES` per-entity allowlist still takes precedence over both modes — a listed entity is always allowed.

### Channel confirmation (Discord/voice) — a weaker `ask`

In a channel or always-on session there is no terminal to answer a `permissionDecision: "ask"` prompt (verified: a headless session returns the ask reason to the model instead of executing). To still actuate sensitive entities the operator opted into via `ask` mode, `ha-command-router` confirms over the channel ("sim/não") and, on an affirmative, writes a one-shot token at `.claude-code-hermit/state/ha-confirm-token.json` that the gate honors for **exactly one** matching call (same tool + same entity set, single-use via atomic rename, ~30s TTL; any mismatch, expiry, or parse error falls through to the normal `ask`).

This token is **written by the agent**, so channel confirmation is an *agent-asserted* approval — strictly weaker than a harness-enforced terminal `ask`. The token only ever upgrades the `ask` tier; it never relaxes `strict` mode or the fail-closed unresolvable-target branch. Practical guidance: do not enable `ask` mode for any entity whose actuation you would not accept the agent self-approving. Locks and alarms are best left on `strict` (channel control then surfaces a proposal instead of actuating).

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
