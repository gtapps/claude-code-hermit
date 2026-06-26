---
name: ha-command-router
description: Route a natural-language house command (in the operator's locale) to a Home Assistant actuation. Resolves the target entity via the CLI, maps the verb to an MCP intent tool, asks on ambiguity, and confirms sensitive actions over the channel. Use when the operator tells the house to DO something (turn on/off, open/close, set level) — not for state questions (use ha-house-status).
allowed-tools:
  - Bash
  - Read
  - Write
  - AskUserQuestion
  - mcp__homeassistant__HassTurnOn
  - mcp__homeassistant__HassTurnOff
  - mcp__homeassistant__HassLightSet
  - mcp__homeassistant__HassSetPosition
---

# HA Command Router

Turn a spoken/typed house command into a concrete, safe Home Assistant call. The
safety gate (`hooks/mcp-safety-gate.ts`) requires a **concrete `entity_id`** — area
names and friendly names are blocked — so always resolve the target first.

## Steps

1. **Locale**: read the stored language from OPERATOR.md (`## HA hermit` section).
   All replies are in that locale (default to it for Portuguese phrasing).

2. **Parse** the utterance into: a verb (the intent), a target phrase (the device),
   and any parameter (a percentage / level). The model handles typos and synonyms —
   do not shell out for this. Map the verb to a tool via the Verb Lexicon below to
   infer the target's likely **domain** (e.g. "acende" → `light`).

3. **Prefer a script** when the whole utterance names a routine, not a single device
   (see Scripts). Otherwise continue.

4. **Resolve the target** to an `entity_id`:
   ```
   ${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha resolve-entity "<target phrase>" --domain <inferred-domain>
   ```
   Branch on the JSON:
   - `{"match": "<id>"}` → use that `entity_id`.
   - `{"candidates": [...]}` → **ask, never guess**. Present the friendly names and
     let the operator pick (interactive: `AskUserQuestion`; over a channel: reply
     with a short numbered list and wait for the reply). Re-run with the chosen id.
   - `{"none": true}` or `{"none": true, "reason": "no_snapshot"}` → reply that you
     don't recognize the device and suggest `/claude-code-homeassistant-hermit:ha-refresh-context`.

5. **Sensitivity check**: if the resolved `entity_id` is sensitive
   (`${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha policy-check <entity_id>` →
   `severity` is `block` or `ask`), follow **Confirmation** before actuating.
   `allow` → actuate directly.

6. **Actuate** by calling the mapped MCP intent tool with the concrete `entity_id`
   (and the level parameter per the tool's own schema). Never pass `area_id` /
   friendly names — the gate fails those closed.

7. **Confirm** to the operator in their locale what happened (Format below).

## Verb Lexicon (Portuguese → intent)

| Utterance verb            | Intent tool        | Notes |
|---------------------------|--------------------|-------|
| acende, liga, ligar       | `HassTurnOn`       | domain `light`/`switch` |
| apaga, desliga, desligar  | `HassTurnOff`      | domain `light`/`switch` |
| abre, abrir               | `HassTurnOn` / open-cover intent | covers |
| fecha, fechar             | `HassTurnOff` / close-cover intent | covers |
| põe a N%, define N%       | `HassLightSet` (brightness) / `HassSetPosition` (cover) | set the level param per the tool schema |

Use the dedicated cover/lock/etc. intents your MCP server actually exposes — consult
your available `mcp__homeassistant__*` tools rather than assuming a tool name.

## Scripts (optional fallback)

For whole-routine utterances ("bom dia", "vou sair") that have no single-device
equivalent: list scripts with
`${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha list-scripts` and match the phrase to a
`friendly_name`. Then find the **correspondingly-named tool** in your available
`mcp__homeassistant__*` tools and call it. There is no deterministic
`entity_id` → tool-id bridge — if you cannot confidently identify the script tool,
ask the operator rather than guessing. A sensitive script (e.g. arming an alarm)
carries no `entity_id`, so the channel-confirmation gate-token path cannot cover it;
treat such cases as a proposal unless the operator has explicitly arranged otherwise.

## Confirmation (sensitive actions)

Sensitive domains (`lock`, `alarm_control_panel`, security-keyworded
`cover`/`switch`/`button`) are never actuated without confirmation:

- **Interactive session**: use `AskUserQuestion` and actuate on approval.
- **Channel session** (Discord/voice): do NOT call the MCP tool. Append a pending
  entry to `.claude-code-hermit/state/pending-ha-actions.json` — create the file as
  `{"pending": []}` if it does not exist — with `pending[]` entries shaped
  `{id, tool, entity_id, verb, channel, created_at}`. Then reply
  "Confirmas <action>? (sim/não)". On the operator's next affirmative, this skill is
  re-invoked with `--resolve` (see below): it writes a one-shot confirmation token
  the gate honors, then makes the call. On "não", drop the entry and acknowledge.

`strict` mode never actuates sensitive entities — surface a proposal instead.

### `--resolve` mode

When invoked to resolve a pending confirmation: read
`state/pending-ha-actions.json`, take the matching pending entry, write the one-shot
token `state/ha-confirm-token.json` as `{"tool": "<mcp tool id>", "entity_ids":
["<entity_id>"], "expiry": <now + 30000 epoch ms>, "nonce": "<random>"}`, then
immediately call the entity-targeting MCP intent tool (the gate consumes the token
and allows the call). Finally remove the pending entry and confirm the result in the
operator's locale. The token is single-use and expires in ~30s — if the call does
not fire promptly, re-confirm rather than reusing it.

## Format

- **Discord/text**: short, markdown allowed, name the device by its friendly name.
- **Voice**: 1–2 short sentences, numbers spelled out, no symbols or entity IDs.
- Friendly errors only — never surface raw `entity_id`s or stack traces to the operator.
