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

Check if the plugin is already installed:

```bash
claude plugin list 2>/dev/null | grep -i "<channel>@claude-plugins-official"
```

- Not installed → `claude plugin install <channel>@claude-plugins-official --scope local`
- Already installed → skip silently.

After any install (or if just installed): tell the operator to run `/reload-plugins` in this session to activate the plugin's configure and access commands before pairing.

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
6. Update `.claude/settings.local.json` in a single read-modify-write (create `{}` if missing):
   - Remove any stale `*_BOT_TOKEN` from the `env` block (tokens must only live in `.env`).
   - Compute the absolute path of `state_dir`. Set `env.<CHANNEL_UPPERCASE>_STATE_DIR = <absolute_state_dir>` if not already correct. Same naming convention as token vars (step 4) — suffix `_STATE_DIR` instead of `_BOT_TOKEN`.
   - Write the file. Confirm: "Wired `<CHANNEL_UPPERCASE>_STATE_DIR` → `<absolute_state_dir>` in `.claude/settings.local.json` (takes effect on next restart)."

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
> - Manual: `claude --channels plugin:<channel>@claude-plugins-official`

**If token is configured:** check whether the channel is already active in the current session by checking if the channel's reply tool is available. If active, skip the restart prompt and go straight to the pairing question batch.

If not active, display:
> Token saved. Restart Claude Code to activate the channel:
> - With hermit: `hermit-start` (passes `--channels` automatically)
> - Manual: `claude --channels plugin:<channel>@claude-plugins-official`
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

### 7. Summary

```
Channel setup complete!

  Channel:    <channel>
  Plugin:     installed (--scope local)
  Token:      configured (<state_dir>/.env)
  Paired:     yes / skipped
  State dir:  <state_dir>

  hermit-start passes --channels automatically on next boot.
```

If anything was skipped, list the remaining steps.
