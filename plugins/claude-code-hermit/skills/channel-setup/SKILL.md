---
name: channel-setup
description: Guided channel activation for local/tmux users — adds a channel entry when none is configured, installs the plugin, configures the bot token in the project-local state dir, and walks through pairing. Run after hatch, or any time to add or re-enable a channel.
disable-model-invocation: true
---
# Channel Setup

Activate a channel, adding the `config.json` entry first when there isn't one. Local/tmux pairing is this skill's own flow; a Docker hermit is routed by the check below.

## Plan

### 1. Read config and detect channels

**Runtime routing (first):** evaluate in this order.

1. **Inside the container.** Run `[ -f /.dockerenv ] || [ -f /run/.containerenv ] && echo container || echo host`. If `container`: read `.claude-code-hermit/config.json`. For each enabled channel object, resolve `state_dir` as step 4 does (config `state_dir`, default `.claude.local/channels/<channel>`; if relative, make it absolute against the project root) and print that absolute path literally. Print and stop:
   > The channel is live in this session. DM the bot for a code, then type `/<channel>:access pair <code> — save access.json to <state_dir>/ not ~/.claude` and `/<channel>:access policy allowlist` here. Or run `/claude-code-hermit:channel-setup` from the host project root.
   If no enabled channel, print only the host-run sentence and stop. No `AskUserQuestion` on this path.

2. **No compose file.** If `docker-compose.hermit.yml` is absent at the project root, continue with the local/tmux flow below.

3. **Live tmux hermit.** Run `bun ${CLAUDE_PLUGIN_ROOT}/scripts/docker-preflight.ts "$(pwd)"`. If its `liveOwner` is non-null, a host tmux hermit owns this project despite the compose file: continue with the local/tmux flow below.

4. **Compose present.** Run `docker compose -f docker-compose.hermit.yml ps --status running --format '{{.Service}}'`. Non-zero exit → print its output, stop. If `hermit` is absent from the output: after channel selection, run steps 2 and 4, skip 3, then stop with `.claude-code-hermit/bin/hermit-docker up` and "re-run this skill to pair". If `hermit` is present: docker-running.

5. **docker-running.** After channel selection, skip step 3 (the container installs channel plugins at boot). Run step 4; a `SKIP … HTTP 401` or `403` from its `channel-bot-id.ts` line is reported as "token rejected by <platform>, fix it before restarting". If this run created the config entry or wrote the token → stop: "The bot is offline until the container restarts and loads it: `.claude-code-hermit/bin/hermit-docker restart`, then DM the bot for a code and re-run this skill. Still no code after a restart: `hermit-docker logs --tail=60` shows the plugin's own error (wrong token, missing Message Content intent, install failure), and `/claude-code-hermit:hermit-doctor` checks the token." Otherwise skip steps 5 to 6c and run docker-setup's **Channel pairing** sub-steps 1 to 9 against the container (`Read` only the **Channel pairing** heading through sub-step 9 of `${CLAUDE_SKILL_DIR}/../docker-setup/SKILL.md`, not the rest of the wizard): `channel-pair.ts pair` / `policy` / `group-add` with `--compose-file docker-compose.hermit.yml --service hermit --session <session>`, session from `tmux_session_name` in `config.json` with `{project_name}` replaced by the project directory basename, `<state_dir>` absolute. Precondition `docker compose -f docker-compose.hermit.yml exec -T hermit tmux has-session -t <session>`; on failure stop with "container is still booting or the first-run screens were never accepted: `hermit-docker attach`, accept them, re-run". The "I have the code / Skip this channel" question on this branch adds one sentence: "No code from the bot? It has not loaded the token: `hermit-docker restart`, then re-run this skill."

Read `.claude-code-hermit/config.json`. Collect all entries under `channels` that are valid objects, tracking which are disabled (`enabled: false`).

**Adding an entry.** Where a branch below says *create the entry*, run (`<name>` is the lowercase channel key — `discord`, `telegram` — never the capitalized option label):

```
echo '{"channels":{"<name>":{"enabled":true}}}' | bun ${CLAUDE_PLUGIN_ROOT}/scripts/hatch-config.ts "$(pwd)" --reinit >/dev/null
```

The script fills `enabled`, `dm_channel_id: null`, `default_chat_id: null`, and `state_dir` (`.claude.local/channels/<name>`), validates the whole config, preserves every other key, and merges onto an existing entry rather than replacing it. Discard stdout — it prints the full config. A non-zero exit means nothing was written: report the `hatch-config:` line it printed on stderr and stop — never fall through into steps 2–6 against a channel that isn't in `config.json`.

- If no channels configured: offer to add one — `AskUserQuestion` (header: "Channel") with options **Discord**, **Telegram**, **Cancel**. On **Cancel**, stop without writing. Otherwise create the entry and continue with that channel selected. Do not offer iMessage here: step 4 defines token vars for Discord and Telegram only.
- If entries exist but all are disabled: name them, then ask with `AskUserQuestion` (header: "Channel") — the disabled channel names plus **Cancel** — which to re-enable. On **Cancel**, stop without writing. Otherwise create the entry for the chosen name (this flips `enabled` and leaves `dm_channel_id`, `default_chat_id`, `state_dir`, and `allowed_users` intact) and continue with it selected.
- If exactly one enabled channel and nothing disabled: use it automatically.
- Otherwise (several enabled, or enabled and disabled side by side): ask with `AskUserQuestion` (header: "Channel") — every channel name as an option, disabled ones labelled `<name> — disabled`, plus **All** (enabled channels only) — which to set up. If a disabled name is chosen, create the entry for it first (re-enabling it), then continue with it selected.

Run steps 2–6 for each selected channel. On a Docker host (runtime routing 4–5), apply those overrides instead of the local/tmux default.

### 2. Check prerequisites

Run both checks in a single Bash call:

```bash
bun --version 2>/dev/null; uname -s
```

- **Bun missing** (command fails / no output): tell the operator —
  > Bun is required for channel plugins but is not installed.
  > Install: https://bun.sh
  > Then re-run this skill.

  Stop for this channel.

- **iMessage on non-macOS**: if `uname -s` is not `Darwin` and the channel is `imessage`, note it's macOS-only and skip this channel.

### 3. Install plugin

Run `bun ${CLAUDE_PLUGIN_ROOT}/scripts/resolve-siblings.ts "$(pwd)"` to get the project-or-local + enabled plugin list (JSON array; user-scope, managed, disabled, and cross-project entries already dropped). Each entry carries `plugin`, `marketplace_name`, `scope`, `enabled`.

Resolve the expected marketplace for this channel:

- If `channels.<channel>.marketplace` is set in `config.json`, use that value (third-party channel plugin path).
- Otherwise, use `claude-plugins-official` (built-in channels: discord, telegram, imessage).

Then check whether the surviving set contains an entry where:

- the plugin name (substring of `id` left of `@`) equals `<channel>`, AND
- the marketplace name (substring of `id` right of `@`) equals the resolved marketplace.

(Both clauses matter — `discord@some-other-marketplace` is a different plugin from a different source and must not satisfy this gate.)

- **Found**: skip silently. The channel plugin is already installed and enabled at project or local scope for this project — the canonical filter guarantees `enabled == true`, and `*_STATE_DIR` (set by `hermit-start` at boot) points at `.claude.local/channels/<channel>/`.
- **Not found**: run, in order:
  ```bash
  claude plugin install <channel>@<marketplace> --scope local
  claude plugin enable  <channel>@<marketplace> --scope local
  ```
  Explicit `enable` covers the disabled-but-installed-at-project/local case — the filter excluded such entries (enabled-only), and `install` is a separate command from `enable` per the CLI surface, so it may no-op without re-enabling. A user-scope install elsewhere does not satisfy this gate; channel tokens and access policy are project-local.

After any install (or if already present): tell the operator to run `/reload-plugins` in this session to activate the plugin's configure and access commands before pairing.

### 4. Token configuration (AskUserQuestion)

Token env var names: `discord` → `DISCORD_BOT_TOKEN`, `telegram` → `TELEGRAM_BOT_TOKEN`.

Resolve `state_dir`:
- Read `channels.<channel>.state_dir` from config.json.
- If not set, default to `.claude.local/channels/<channel>`.
- If relative, it is relative to the project root (current directory).

Check if the token file already exists: `<state_dir>/.env` and contains the token var name.
- If yes: "Token already configured at `<state_dir>/.env`." → proceed to step 5.
- If no: display the official setup guide reference and ask for the token:

> To create your bot and get a token, follow the official guide:
> https://code.claude.com/docs/en/channels

```
questions: [
  {
    header: "Bot token",
    question: "Paste your bot token (or skip to add it later):",
    options: [
      { label: "Skip", description: "I'll add the token to <state_dir>/.env manually" }
    ]
  }
]
```

Operator pastes the token via Other, or selects Skip.

**If token provided:**
1. `mkdir -p <state_dir>`
2. Write `<TOKEN_VAR>=<pasted-token>` to `<state_dir>/.env` (overwrite if exists)
3. `chmod 600 <state_dir>/.env`
4. Ensure `.claude.local/` is in `.gitignore`: check if `.gitignore` exists and contains `.claude.local/`; if missing, append `.claude.local/`.
5. If `channels.<channel>.state_dir` was not set in config.json (a legacy entry, or one reached through the single-enabled-channel branch that never ran *Adding an entry*), run the same `hatch-config.ts … --reinit` one-liner for `<channel>` now, but with an **empty** entry — `echo '{"channels":{"<name>":{}}}' | …` — so an existing `enabled: false` is preserved (the `{"enabled":true}` payload would flip it). It fills the conventional `state_dir`, validates, and audits, leaving every other field intact. Never write the key with Edit/Write.
6. Validate `<CHANNEL_UPPERCASE>_STATE_DIR` for the next resident start. Compute the absolute path of `state_dir`, then run:
   ```bash
   bun ${CLAUDE_PLUGIN_ROOT}/scripts/apply-settings.ts .claude/settings.local.json channel-env <CHANNEL_UPPERCASE> <absolute_state_dir>
   ```
   This validates and reports the state directory without writing settings. The configured state dir takes effect in the resident environment and launch overlay at the next start. Tokens stay in the channel's `.env`. Confirm: "Configured `<CHANNEL_UPPERCASE>_STATE_DIR` → `<absolute_state_dir>` (takes effect at the next start)."

7. Capture the bot's own identity so the hermit recognizes mentions of itself:
   ```bash
   bun ${CLAUDE_PLUGIN_ROOT}/scripts/channel-bot-id.ts .claude-code-hermit <channel> --write
   ```
   Writes `bot_user_id` (and `bot_username`) into the channel's `config.json` entry, overwriting a stale value from a previous bot. A `SKIP …` line is a non-event — report it and continue; setup never fails on it.

**If token already configured:** also run steps 6 and 7 before proceeding to step 5.

**If Skip:** print the manual command:
```
echo '<TOKEN_VAR>=your-token' > <state_dir>/.env && chmod 600 <state_dir>/.env
```
Then proceed to step 5 without a token (pairing will be skipped in step 5).

### 5. Restart + pairing (AskUserQuestion)

**If no token is configured** (skipped in step 4): print restart instructions and stop:
> Restart Claude Code with channels active once you've added your token:
> - With hermit: `hermit-start` (passes `--channels` automatically)
> - Manual: `claude --channels plugin:<channel>@<marketplace>`
>   (use the same `<marketplace>` resolved in step 3 — `claude-plugins-official` for built-in channels, or `channels.<channel>.marketplace` for third-party plugins.)

**If token is configured:** check whether the channel is already active in the current session by checking if the channel's reply tool is available. If active, skip the restart prompt and go straight to the pairing question batch.

If not active, display:
> Token saved. Restart Claude Code to activate the channel:
> - With hermit: `hermit-start` (passes `--channels` automatically)
> - Manual: `claude --channels plugin:<channel>@<marketplace>`
>   (use the same `<marketplace>` resolved in step 3.)
>
> After restarting, DM your bot: it will reply with a 6-character pairing code.
> Only people who may approve tool use should be DM-paired, because every `allowFrom` DM receives and can answer native permission prompts; everyone else joins through a group whose admission is independent of `allowFrom`, and `allowed_users` narrows who can wake the hermit, never who can approve.

Then ask:

```
questions: [
  {
    header: "Pairing",
    question: "Channel state?",
    options: [
      { label: "Already paired", description: "Just verify access.json" },
      { label: "Ready to pair", description: "Restarted, DM'd the bot, have the 6-char code" },
      { label: "Skip", description: "I'll pair later" }
    ]
  }
]
```

- **Already paired**: skip pairing, go to access.json verification in step 6.
- **Ready to pair**: proceed with pairing flow below.
- **Skip**: stop — "Run `/claude-code-hermit:channel-setup` again after restarting to complete pairing."

**Pairing flow:**

Ask with `AskUserQuestion`:

```
questions: [
  {
    header: "Pairing code",
    question: "Paste the 6-character code your bot replied with:",
    options: [
      { label: "Skip", description: "Pair later" }
    ]
  }
]
```

If code provided (via Other):
1. Run `/<channel>:access pair <code>` — include the state dir hint in the message to the LLM running the tool: "save access.json to `<state_dir>/` not `~/.claude`"
2. Run `/<channel>:access policy allowlist`
3. Verify access.json landing (step 6).

If Skip: "DM the bot later, then run `/<channel>:access pair <code>` and `/<channel>:access policy allowlist`." Stop.

### 6. Verify access.json location

Check if `access.json` exists at `<state_dir>/access.json`.

- If yes: done.
- If no: check `~/.claude/channels/<channel>/access.json`. If found there, move it:
  ```bash
  mkdir -p <state_dir>
  mv ~/.claude/channels/<channel>/access.json <state_dir>/access.json
  ```
  Confirm: "Moved access.json to `<state_dir>/`."
- If found in neither location: note — "access.json not found. Pairing may not have completed. Run `/<channel>:access pair <code>` after DMing your bot."

If access.json is verified, continue to step 6b.

### 6b. Default delivery settings

Once `access.json` is at `<state_dir>/access.json` (§6), set sensible delivery defaults the operator hasn't customized.

Skip this step if the current channel is `imessage`. Otherwise:

1. Read `<state_dir>/access.json`. If `ackReaction` is already a non-empty string, skip — don't overwrite operator customization.
2. Otherwise run, with the state-dir hint (same pattern as §5):
   ```
   /<channel>:access set ackReaction 👀 — save access.json to <state_dir>/, not ~/.claude
   ```

`👀` works on Discord (any unicode emoji accepted) and is in Telegram's fixed reaction whitelist. Operators get an emoji on their inbound DM as soon as the bot receives it — fills the gap after the 5–10s typing indicator times out. Idempotent: re-running channel-setup leaves customized values alone.

### 6c. Server channel / group chat (optional)

Skip this step if the current channel is `imessage`, or if `access.json` is not present at `<state_dir>/access.json` (note: "Pairing didn't complete — skipping group setup.").

1. Ask with `AskUserQuestion` — label and prompt vary by channel:
   - `discord`: header `"Server channel"` — "Want the hermit to also listen in a Discord server channel? Channel ID: enable Developer Mode in Discord settings → right-click the channel → Copy Channel ID."
   - `telegram`: header `"Group chat"` — "Want the hermit to also listen in a Telegram group? Group ID: forward a message from the group to `@userinfobot` or use `@RawDataBot`. Group IDs are negative integers (e.g. `-1001234567890`)."
   - Options: `"Yes — add a channel"` (discord) / `"Yes — add a group"` (telegram) with ID captured via `Other`; `"Skip — DMs only"`.
2. If **Skip**: continue to §7.
3. **For each ID provided** (the first ID comes from step 1's `Other`; each subsequent ID from step 3c's `Other` — loop until "Done"):
   a. Ask both questions for this ID in one `AskUserQuestion` call (the option marked `(default)` is the Recommended pre-selection):

      | Header | Question | Options (`label`: description) |
      |---|---|---|
      | Mention required | Require an @mention for this chat? | `Yes, require @mention`: safer for noisy channels (default) / `No, respond to all messages`: respond without a mention |
      | Shared history | Let every other chat recall what is said here? | `No, private to this chat`: keep this chat's history private (default) / `Yes, shared with every chat`: let any chat on any channel recall this one |

      Shared means any chat on any channel can recall what is said here.
   b. Run the slash command directly, with the state-dir hint (same pattern as §6b):
      - With `"Yes, require @mention"`: `/<channel>:access group add <channelId> — save access.json to <state_dir>/, not ~/.claude`
      - With `"No, respond to all messages"`: `/<channel>:access group add <channelId> --no-mention — save access.json to <state_dir>/, not ~/.claude`
      After the respond-to-all command, ask once with `AskUserQuestion`: "Record the chat but wake only on @mention (passive)?" Options: **Yes**, **No**.
      Read the current `channels.<channel>.passive_chats` and `channels.<channel>.shared_chats` arrays (absent means `[]`). For passive, on Yes include this chat id once; on No remove it; if the passive question was not asked, preserve that array. For Shared history, on Yes include this chat id once; on No remove it. Preserve every other id in both arrays. After the access command, merge both **full resulting arrays** with the same `hatch-config.ts --reinit` flow used above:
      ```bash
      echo '{"channels":{"<channel>":{"passive_chats":<full_passive_array>,"shared_chats":<full_shared_array>}}}' | bun ${CLAUDE_PLUGIN_ROOT}/scripts/hatch-config.ts "$(pwd)" --reinit >/dev/null
      ```
      Substitute the actual channel key and JSON string arrays. Never use Edit/Write on `config.json`. Stop on a non-zero merge exit as in Adding an entry. Repeating the same answers must leave the arrays unchanged.
      On Yes, confirm the group's `allowFrom` is empty in the plugin settings so every member's messages can be recorded. Explain these facts in the operator's language:
      - The plugin-global `ackReaction` reacts to every member's message; `/<channel>:access set ackReaction ""` removes it.
      - Discord threads follow the channel; forum channels are unsupported. Denying Create Public/Private Threads is the zero-code alternative.
      - Telegram privacy mode must be disabled in BotFather.
   c. Ask with `AskUserQuestion` (header: `"Add another?"`) — `"Yes — add another"` with the next ID via `Other`; `"Done — continue"`. On `"Done — continue"`: exit the loop.
4. **Verify all added channels** (one `Read` after the loop): open `<state_dir>/access.json`. For each ID added in step 3, confirm `groups.<channelId>` is present with the expected `requireMention` value. For any missing: "Group entry didn't land — run `/<channel>:access group add <channelId>` manually after setup." Do not error. Then proceed to §7.

### 6d. Maintainer channel check (optional)

If `channels.<channel>.maintainer_channel_id` is set in `config.json`, this channel routes technical, operational, and spend alerts to a second outbound-only destination (same bot/token, a different chat) instead of the primary chat, used on client-facing installs so the person on the primary chat never sees ops detail. Doctor's channel-liveness probe only checks the primary chat, so a typo'd maintainer id would otherwise fail silently on every alert rather than at setup.

When it's set, send **one** test message to the maintainer chat to confirm reachability:

```
bun ${CLAUDE_PLUGIN_ROOT}/scripts/channel-send.ts .claude-code-hermit --tier maintainer -
```

with a short line on stdin (e.g. "Maintainer channel check: technical and spend alerts will arrive here."). Record the result in the §7 summary: **sent** confirms the id; a **failure** means the id is wrong or the chat isn't reachable, so surface it so the operator fixes it now. If `maintainer_channel_id` is absent, skip silently.

A maintainer-send failure means **the bot isn't present or permissioned in the target server/channel** — the fix is to invite/permission the bot there. This chat is reached by a direct API POST with the bot token, never through `access.json`, so running `/<channel>:access` will not fix a failed send here.

### 7. Summary

```
Channel setup complete!

  Channel:        <channel>
  Plugin:         installed (--scope local)
  Token:          configured (<state_dir>/.env)
  Paired:         yes / skipped
  Server channels: <id1> (mention: yes/no), <id2> (mention: no) / skipped
  State dir:      <state_dir>

  hermit-start passes --channels automatically on next boot.
```

If anything was skipped, list the remaining steps.

### 7a. Send owner welcome (once, only when exactly one channel was newly paired)

Run this once, after step 7's summary, across the *whole* run — not per channel inside the steps 2–6 loop.

Skip entirely if no channel selected "Ready to pair" in step 5 this run — an operator re-running setup against an already-paired channel ("Already paired") or one they skipped shouldn't get a repeat welcome.

Also skip, with a note in the summary ("Welcome message skipped — more than one channel was newly paired this run; let the owner know directly"), if *more than one* channel selected "Ready to pair" this run (the "All" path pairing several channels at once). `channel-send.ts` has no per-channel target — it resolves one generic outbound channel (`primary`, else first eligible in config order) — so with several freshly-paired channels there's no reliable way to know which one it would reach.

Otherwise (exactly one channel newly paired), compose a short welcome in the operator's configured `language` (`config.json`), in your own voice, so the owner has something the moment the bot can reach them. Not the full guide, just an orientation pointer covering: they can talk to you anytime in plain language; when you have a suggestion or need a decision you will ask, and yes, later, or no is enough; `/pause` stops you until `/resume` (both must start with a slash); you track AI spend and warn when it nears any configured limit; if you go quiet or something is confusing, they should reach whoever set you up (who also has the full written guide). No file paths or internal jargon: it's the owner's first message, and the only slash commands allowed are the five control commands `/pause`, `/stop`, `/resume`, `/snooze`, `/status`. Send it on stdin:

```bash
bun ${CLAUDE_PLUGIN_ROOT}/scripts/channel-send.ts .claude-code-hermit - <<'HERMIT_WELCOME'
<the composed welcome>
HERMIT_WELCOME
```

Use this send as the post-hatch delivery confirmation and report it explicitly in the summary. On success: "Test message sent — check <channel> and tell me if it didn't arrive." If the send fails, don't block setup: "Channel paired, but the test message didn't arrive (`<error>`) — check the pairing before relying on this channel."
