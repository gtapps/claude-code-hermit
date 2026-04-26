---
name: channel-setup
description: Guided channel activation for local/tmux users — installs the plugin, configures the bot token in the project-local state dir, and walks through pairing. Run after hatch or hermit-settings to activate a configured channel.
---
# Channel Setup

Activate a channel configured in `config.json` for local/tmux operation. This mirrors what `docker-setup` does for Docker users but targets the local environment.

## Plan

### 1. Read config and detect channels

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
5. Clean stale `*_BOT_TOKEN` from `.claude/settings.local.json` `env` block if present (tokens must only live in `.env`).
6. If `channels.<channel>.state_dir` was not set in config.json, write it now as a relative path (e.g. `.claude.local/channels/<channel>`).

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

Then ask (both questions in a single `AskUserQuestion` call):

```
questions: [
  {
    header: "Ready?",
    question: "Have you restarted Claude Code with the channel active?",
    options: [
      { label: "Yes — ready to pair", description: "Channel is running, I've DM'd the bot" },
      { label: "Skip", description: "I'll pair later" }
    ]
  },
  {
    header: "Pairing status",
    question: "Is this channel already paired?",
    options: [
      { label: "Not yet", description: "Need to pair now" },
      { label: "Already paired", description: "Just verify setup" }
    ]
  }
]
```

- **Skip** (first question): stop — "Run `/claude-code-hermit:channel-setup` again after restarting to complete pairing."
- **Already paired** (second question): skip pairing, go to access.json verification in step 6.
- **Yes + Not yet**: proceed with pairing flow below.

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
