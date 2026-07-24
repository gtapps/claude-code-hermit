---
name: relogin
description: "Renew the hermit's long-lived Claude login token over the channel, before it expires. Relays a one-time sign-in link to the operator, takes the code back, installs the new token, and restarts. Activates on messages like 'relogin', 'renew my login', 'reauth', 'the login is expiring', or when doctor's credential-expiry check flags setup-token."
---

# Relogin

Renews this hermit's `setup-token` credential without anyone touching the box. The operator opens a link, signs in, sends back a code; you install the token and restart.

Use this when doctor warns that `setup-token` is expiring, or the operator asks to renew. If the hermit is *already* dead from an expired token, this skill is not the path — the watchdog runs the same flow deterministically without a model (`setup-token-mint.ts relay`), because a dead hermit can't run a skill.

**Never run `/logout`.** Renewal never needs it. Retiring the old `.credentials.json` is fine — the install does it for you (see Notes) — but `/logout` *also* resets first-launch state, after which the interactive wizard demands a login and refuses the env token. That reset is the hazard, not the credential removal.

## Step 0 — Preflight

```
bun ${CLAUDE_PLUGIN_ROOT}/scripts/setup-token-mint.ts status
```

- `token_mode: false` → this hermit isn't on token auth. Tell the operator renewal is manual here (`hermit-docker setup-token` converts it), and stop.
- `in_progress` non-null → a renewal is already running. Don't start a second one.
- Otherwise report the current `expires_at` in plain language and continue.

## Step 1 — Mint and relay the link

```
bun ${CLAUDE_PLUGIN_ROOT}/scripts/setup-token-mint.ts start
bun ${CLAUDE_PLUGIN_ROOT}/scripts/setup-token-mint.ts await-url
```

Send the operator the `url` from the second command, in your own voice — one line, the link, and what you need back. Something like: "Time to renew your Claude sign-in. Open this and send me the code it gives you: `<url>`".

**If a `maintainer_channel_id` is configured for the active channel** (`channels.<platform>.maintainer_channel_id` in `config.json`), send that message via the maintainer channel instead of the client chat, so the sign-in link never reaches an end-user's chat. Pipe the text on stdin:

```
bun ${CLAUDE_PLUGIN_ROOT}/scripts/channel-send.ts .claude-code-hermit --tier maintainer -
```

The operator still pastes the code back through the primary chat (Step 2 is unchanged). When no maintainer channel is configured, keep the current in-chat/terminal path above; that remains the documented owner-recipient contract.

The link is one-time and short-lived. Don't mint it before the operator is ready to use it.

## Step 2 — Take the code back

When the operator replies with the code:

```
bun ${CLAUDE_PLUGIN_ROOT}/scripts/setup-token-mint.ts submit-code "<code>"
bun ${CLAUDE_PLUGIN_ROOT}/scripts/setup-token-mint.ts await-token-and-install
```

The install prints `{ok, expires_at}` and nothing else — the token itself never reaches you, by design. It goes from the mint pane straight into a 0600 file on the config volume.

If either step fails, run `abort`, tell the operator plainly that nothing changed, and offer to try again.

## Step 3 — Confirm, then restart (order matters)

The new token only takes effect when the claude process restarts — and that restart kills the session running this skill. So:

1. **First**, send the confirmation: "You're signed back in, nothing else needed. Next renewal is due `<expires_at>`, and I'll ask you then."
2. **Then**, as the final act of the skill:

```
bun ${CLAUDE_PLUGIN_ROOT}/scripts/setup-token-mint.ts finish
```

It fires the restart detached and returns immediately. Anything you write after it will never run — send the message first, every time.

## Notes

- The one-time link and the login code cross the channel; the token never does.
- Installing the token parks any stored `/login` credential (`.credentials.json` → `.credentials.json.pre-token.bak`). Interactive sessions prefer a stored login over the env token, so an unparked file would 401 the hermit once its old access token lapsed. The rename is restorable; nothing is deleted.
- Expiry is hermit-tracked in `state/setup-token.json` — the CLI exposes no expiry surface for these tokens, so that record is the only source of truth. Doctor's `credential-expiry` check reads it and warns 14 days out.
- Renewal is container-internal on purpose: the token lives on the persistent config volume, not in `.env`, so nothing on the host has to be recreated.
