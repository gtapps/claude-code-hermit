---
name: ha-apply-update
description: Apply a Home Assistant update surfaced by ha-update-check, when the operator accepts a [ha-update] proposal. Enforces the tier rule -- add-ons/HACS may auto-apply, Core/OS/Supervisor always wait for an explicit operator go-ahead.
allowed-tools:
  - Bash
---

# Apply HA Update

## When this runs

Invoked from `proposal-act`'s Accept flow for a `[ha-update]` proposal (originated by `/claude-code-homeassistant-hermit:ha-update-check`). The proposal body carries the entity_id, tier (`core`/`os`/`supervisor`/`addon`/`hacs`), and target version.

## Steps

1. **Read the flag**: check `ha_update_auto_apply` in `.claude-code-hermit/config.json`.
   - **Absent or `false`**: this is advisory-only. Resolve the proposal — tell the operator the update is available and where (`Settings → System → Updates` in the HA UI), and stop. Do not call `update.install`.
   - **`true`**: continue.

2. **Branch on tier** (from the proposal body). The `addon` vs `hacs` split is defined by the native backup capability: `ha-update-check` tiers an entity `addon` precisely when it advertises HA's BACKUP update feature, so `backup:true` is always valid for an `addon` proposal, and a `hacs` entity is one that can't back itself up (hence the separate full-backup step).

   - **`addon`**: `${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha call-service update.install --data '{"entity_id":"<entity_id>","backup":true}' --confirm`. HA backs up the add-on natively and rolls back on install failure. Report the result to the operator once done.
   - **`hacs`** (an individual HACS entity accepted out of an aggregated proposal — HACS entities don't support the native `backup` parameter): first `${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha create-backup --agent-ids <configured agent> --confirm`. If the backup call is blocked or fails, stop and stay advisory — tell the operator why. Only on a successful backup: `ha call-service update.install --data '{"entity_id":"<entity_id>"}' --confirm`.
   - **`core` / `os` / `supervisor`**: never auto-apply, even with the flag on. Use `AskUserQuestion` (or the channel, if this is a routine-fired context — see Operator Notification protocol in CLAUDE.md): "Home Assistant <tier> update ready: <installed_version> → <latest_version>. This can affect access to your dashboard, so I'll wait for your go-ahead. Install now?" Only on an explicit yes: `ha call-service update.install --data '{"entity_id":"<entity_id>","backup":true}' --confirm`.

3. **Report**: read the command's JSON output (`ok`/`message`). On success, tell the operator the update installed and that an audit is at `.claude-code-hermit/raw/audit-ha-call-service-*`. On failure, surface the error verbatim and leave the proposal open rather than resolving it.

## Why this exists

`ha call-service update.install` is gated in `src/policy.ts` (`gateServiceCall`'s `update`-domain branch): with `ha_update_auto_apply` unset, the call is blocked outright regardless of `--confirm`; with it set, the call still requires `--confirm` on every invocation, independent of `ha_safety_mode`. This skill is what supplies that `--confirm` deliberately, once, per accepted proposal — never issue `--confirm` speculatively or in a loop.
