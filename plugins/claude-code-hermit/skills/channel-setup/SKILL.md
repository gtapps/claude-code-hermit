---
name: channel-setup
description: Guided channel activation for local/tmux users — installs the plugin, configures the bot token in the project-local state dir, and walks through pairing. Run after hatch or hermit-settings to activate a configured channel.
---
# Channel Setup

Activate a channel configured in `config.json` for local/tmux operation. This mirrors what `docker-setup` does for Docker users but targets the local environment.

## Plan

### 1. Read config and detect channels

**Docker check (first):** read `.claude-code-hermit/state/runtime.json` if it exists.

- If `runtime_mode == "docker"`: stop and redirect —
  > This project is running in Docker. Channel token and pairing must happen inside the container, not on the host.
  > Run `/claude-code-hermit:docker-setup` — it configures channels container-side.
  Stop.
- If `runtime.json` is missing AND `.claude-code-hermit/docker/Dockerfile.hermit` exists (Docker scaffolded but not yet booted): same redirect.
- Otherwise: proceed.

Read `.claude-code-hermit/config.json`. Collect all entries under `channels` that are valid objects.

- If no channels configured: tell the operator — "No channels in config.json. Run `/claude-code-hermit:hatch` or `/claude-code-hermit:hermit-settings channels` to add one first." Stop.
- If exactly one channel: use it automatically.
- If multiple channels: ask with `AskUserQuestion` (header: "Channel") — list channel names as options plus **All** — which to set up.

Run steps 2–6 for each selected channel.

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
5. If `channels.<channel>.state_dir` was not set in config.json, write it now as a relative path (e.g. `.claude.local/channels/<channel>`).
6. Wire `<CHANNEL_UPPERCASE>_STATE_DIR` into `.claude/settings.local.json`. Compute the absolute path of `state_dir`, then run:
   ```bash
   bun ${CLAUDE_PLUGIN_ROOT}/scripts/apply-settings.ts .claude/settings.local.json channel-env <CHANNEL_UPPERCASE> <absolute_state_dir>
   ```
   This sets `env.<CHANNEL_UPPERCASE>_STATE_DIR` (creating the file if missing) and strips any stale `*_BOT_TOKEN` from the `env` block — tokens must live only in `.env`. Same naming convention as token vars (step 4), suffix `_STATE_DIR` instead of `_BOT_TOKEN`. Confirm: "Wired `<CHANNEL_UPPERCASE>_STATE_DIR` → `<absolute_state_dir>` in `.claude/settings.local.json` (takes effect on next restart)."

**If token already configured:** also run step 6 before proceeding to step 5.

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
> After restarting, DM your bot — it will reply with a 6-character pairing code.

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
   a. Ask with `AskUserQuestion` (header: `"Mention required"`) for this ID:
      - `"Yes — require @mention"` (default — safer for noisy channels)
      - `"No — respond to all messages"`
   b. Run the slash command directly, with the state-dir hint (same pattern as §6b):
      - With `"Yes — require @mention"`: `/<channel>:access group add <channelId> — save access.json to <state_dir>/, not ~/.claude`
      - With `"No — respond to all messages"`: `/<channel>:access group add <channelId> --no-mention — save access.json to <state_dir>/, not ~/.claude`
   c. Ask with `AskUserQuestion` (header: `"Add another?"`) — `"Yes — add another"` with the next ID via `Other`; `"Done — continue"`. On `"Done — continue"`: exit the loop.
4. **Verify all added channels** (one `Read` after the loop): open `<state_dir>/access.json`. For each ID added in step 3, confirm `groups.<channelId>` is present with the expected `requireMention` value. For any missing: "Group entry didn't land — run `/<channel>:access group add <channelId>` manually after setup." Do not error. Then proceed to §7.

### 6d. Maintainer channel check (optional)

If `channels.<channel>.maintainer_channel_id` is set in `config.json`, this channel routes technical, operational, and spend alerts to a second outbound-only destination (same bot/token, a different chat) instead of the primary chat, used on client-facing installs so the person on the primary chat never sees ops detail. Doctor's channel-liveness probe only checks the primary chat, so a typo'd maintainer id would otherwise fail silently on every alert rather than at setup.

When it's set, send **one** test message to the maintainer chat to confirm reachability:

```
bun ${CLAUDE_PLUGIN_ROOT}/scripts/channel-send.ts .claude-code-hermit --tier maintainer -
```

with a short line on stdin (e.g. "Maintainer channel check: technical and spend alerts will arrive here."). Record the result in the §7 summary: **sent** confirms the id; a **failure** means the id is wrong or the chat isn't reachable, so surface it so the operator fixes it now. If `maintainer_channel_id` is absent, skip silently.

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

Otherwise (exactly one channel newly paired), send one short, plain-language welcome so the owner has something the moment the bot can reach them. Not the full guide — a channel message can't hold it, and this is just an orientation pointer:

```bash
bun ${CLAUDE_PLUGIN_ROOT}/scripts/channel-send.ts .claude-code-hermit - <<'HERMIT_WELCOME'
Hi — I'm connected here now.

A few basics:
- Talk to me anytime, in plain language.
- If I have a suggestion or need a decision, I'll ask, and you can just reply yes, later, or no.
- Say "pause" to stop me and "resume" to continue — pausing really stops me until you say resume.
- I track what I spend on AI usage and will tell you if it's getting close to any limit that's set.
- If I ever go quiet, or something's confusing, reach out to whoever set me up for you — they can also give you the full written guide.
HERMIT_WELCOME
```

No file paths, slash commands, or internal jargon in this text — it's the owner's first message. If the send fails, note it in the summary above but don't block setup: "Welcome message couldn't be sent (`<error>`) — the channel is paired; let the owner know directly this time."
