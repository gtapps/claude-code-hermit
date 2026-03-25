# Always-On Operations Guide

How to run the Claude Code-native autonomous agent as a persistent, always-on system. This covers setup, communication channels, periodic tasks, cost management, and security.

For skill details referenced in this guide, see [SKILLS.md](SKILLS.md).

---

## Prerequisites

| Requirement | Required For | Notes |
|---|---|---|
| **tmux** | Boot scripts | `brew install tmux` (macOS) or `apt install tmux` (Linux) |
| **Node.js 18+** | Hooks (cost tracking, session evaluation) | Hook scripts run on Node |
| **Bun** | Channels (Telegram/Discord/iMessage) | `curl -fsSL https://bun.sh/install \| bash` |
| **Claude Code v2.1.80+** | Channels | Required for Channels research preview |

tmux is required for the boot scripts. Bun and Channels are optional — the agent works fine in tmux without them.

---

## 1. Setting Up a Persistent Session

The easiest way to start a persistent session is with the boot script:

```bash
cd /path/to/your/project
.claude/.claude-code-hermit/bin/hermit-start
```

This reads `.claude/.claude-code-hermit/config.json`, starts a tmux session with the configured channels and permissions, and auto-runs `/claude-code-hermit:session`. To stop:

```bash
.claude/.claude-code-hermit/bin/hermit-stop        # graceful (sends /session-close first)
.claude/.claude-code-hermit/bin/hermit-stop --force # immediate kill
```

> **How it works:** The wrapper scripts in `bin/` read `_plugin_root` from `config.json` to locate the plugin's boot scripts (`hermit-start.py`, `hermit-stop.py`) in the global plugin cache. This works across all projects using the same plugin. The path is set during `/claude-code-hermit:init` and updated by `/claude-code-hermit:upgrade`.

### Manual tmux Setup (alternative)

If you prefer manual setup or don't have the boot scripts:

```bash
# Create a named tmux session for the agent
tmux new-session -d -s claude-agent

# Attach to it
tmux attach -t claude-agent

# Inside the tmux session, start Claude Code
cd /path/to/your/project
claude --dangerously-skip-permissions
```

> **Why `--dangerously-skip-permissions`?** For an always-on agent, you need it to act without manual approval prompts. The permission deny patterns in `settings.json` and the hook-based guards provide the safety rails instead. Understand the risks before using this flag.

> **Important:** Before running headless with `--dangerously-skip-permissions`, you must first run `claude` interactively in the project directory once and accept the workspace trust prompt. This trust is persisted — subsequent launches (including headless via `hermit-start`) will not prompt again. Without this step, the agent will hang waiting for confirmation in tmux with no one to answer.

> **Running without `--dangerously-skip-permissions`?** The plugin's hooks and boot scripts need specific Bash permissions to run without prompting. `/claude-code-hermit:init` adds these to `.claude/settings.json` automatically. See the [Permissions section in HOW-TO-USE.md](HOW-TO-USE.md#permissions-without---dangerously-skip-permissions) for the full list and what each one enables.

### Recommended tmux Config

Add to `~/.tmux.conf` for a better experience:

```bash
# Keep plenty of scrollback
set -g history-limit 50000

# Don't kill the session when the terminal disconnects
set -g destroy-unattached off

# Activity alerts
setw -g monitor-activity on
```

### Reconnecting from Anywhere

[Remote control](https://code.claude.com/docs/en/remote-control) lets you connect to a running session from a browser or mobile device. Enable it in the config (`/claude-code-hermit:hermit-settings remote`) or start Claude with `--remote-control`:

```bash
# Inside a running Claude Code session, type:
/remote-control

# Claude Code will output a URL you can open in any browser
# Or connect via claude.ai/code
```

If `remote: true` is set in config.json, the boot script adds `--remote-control` automatically and names the session after `agent_name` (or the tmux session name if no agent name is set).

If `model` is set in config.json (e.g., `"opus"`, `"sonnet"`, `"haiku"`), the boot script passes `--model` to Claude Code. When `null` or empty, the instance's default model is used.

### Using screen (Alternative)

```bash
# Create a named screen session
screen -S claude-agent

# Start Claude Code inside
cd /path/to/your/project
claude --dangerously-skip-permissions

# Detach: Ctrl+A, then D
# Reattach later:
screen -r claude-agent
```

---

## 1b. Always-On Session Lifecycle

In always-on mode, the session persists across task boundaries. This is the key model for preventing heartbeat, monitor, and channel connections from dying between tasks.

### How It Works

1. `hermit-start` launches the agent and sets `always_on: true` in config.json
2. Agent starts a session (SHELL.md created, Status: `in_progress`)
3. Task completes → `/session-close` defaults to **idle transition**:
   - Task report archived as `S-NNN-REPORT.md`
   - SHELL.md resets task fields, Status → `idle`
   - Session Summary accumulates task history
   - Heartbeat and monitors keep running
4. New task arrives (via channel, NEXT-TASK.md, or operator) → Status → `in_progress`
5. Repeat 3-4 indefinitely
6. `hermit-stop` triggers full shutdown: close task → stop heartbeat → archive session → kill tmux

### Session State Flow

```
hermit-start
  → [in_progress] → task done → [idle]
                                      │
                        new task ───┘ (repeat)
                                      │
                         hermit-stop ──→ [archived]
```

### Close Mode Decision Tree

When `/session-close` is invoked, the agent decides between two modes:

```
/session-close invoked
     │
     ├── Explicit "--shutdown" or "full close"?
     │       YES → Full Shutdown
     │
     ├── Explicit "--idle" or "task complete"?
     │       YES → Idle Transition
     │
     └── No explicit intent
             │
             ├── config.always_on == true?
             │       YES → default to Idle Transition
             │       NO  → default to Full Shutdown
             │
             └── Confirm with operator (uses default if unattended)
```

**What happens in each mode:**

| | Idle Transition | Full Shutdown |
|---|---|---|
| **When** | Task done, session stays open | Operator wants everything to stop |
| **Report archived** | Yes → S-NNN-REPORT.md | Yes → S-NNN-REPORT.md |
| **Pattern-detect runs** | Yes (self-learning fires) | Yes (self-learning fires) |
| **SHELL.md** | Reset in-place (Status → `idle`) | Replaced with fresh template |
| **Task fields cleared** | Yes (Plan, Progress, Blockers, Changed) | Yes (entire file replaced) |
| **Session fields preserved** | Yes (Monitoring, Cost, Session Summary) | No (new template) |
| **Heartbeat** | Keeps running | Stopped |
| **Channels** | Stay connected | Disconnected |
| **Remote control** | Stays accessible | Gone |
| **Next task** | Arrives via channel/terminal | Requires new `hermit-start` |

### Manual Override

During always-on operation, the operator can:

- `/session-close` — defaults to idle transition (operator can choose full shutdown in the confirmation prompt)
- `/session-close --shutdown` — force full close (same as hermit-stop's close step)
- `/session-close --idle` — explicitly request idle transition (for scripting)

### Edge Cases

- **Process death during task**: SHELL.md persists on disk with Status `in_progress`. On restart, `session-start` detects it and offers to resume.
- **Process death during idle**: SHELL.md persists with Status `idle`. On restart, `session-start` detects idle and asks for next task.
- **Manual /session-close during always-on**: The confirmation prompt shows "Idle transition" as default. Operator can choose full shutdown.
- **hermit-start when already running**: Prints guidance message and exits (no duplicate sessions).

### Why Sessions Don't Close Between Tasks

`/loop` (which powers heartbeat and monitors) is scoped to the Claude Code process. When the process ends, all loops die. By keeping the session open between tasks:

- Heartbeat keeps ticking overnight
- Channel connections stay live
- Monitors continue polling
- Remote control remains accessible

If you close the session and start a new process, all of these must be re-established -- and the heartbeat loop from the old process is gone forever.

---

## 1c. The Always-On Task Loop

Section 1b describes the state transitions. This section shows what it looks like over time — tasks arriving, reports archiving, and the learning loop activating.

```
hermit-start
  │
  ├── Sets config.always_on = true
  ├── Launches Claude Code in tmux (with channels, remote control)
  ├── Auto-sends /claude-code-hermit:session
  ├── Starts heartbeat loop (if enabled)
  │
  ▼
╔══════════════════════════════════════════════════════════════════════╗
║  ALWAYS-ON LOOP (single Claude Code process, single SHELL.md)      ║
║                                                                     ║
║  Task 1 arrives (channel, terminal, or NEXT-TASK.md)               ║
║    ├── Status → in_progress                                         ║
║    ├── Work (SHELL.md tracks plan, progress, blockers)              ║
║    ├── Stop hooks fire after every assistant turn:                   ║
║    │     cost-tracker.js    → logs cost to SHELL.md + cost-log      ║
║    │     suggest-compact.js → warns at 60% context usage            ║
║    │     session-diff.js    → auto-populates Changed section        ║
║    │     evaluate-session.js → scores session quality               ║
║    └── Task complete → /session-close (defaults to idle)            ║
║          ├── Finalize SHELL.md                                      ║
║          ├── pattern-detect (skipped — fewer than 3 reports)        ║
║          ├── Archive → S-001-REPORT.md                              ║
║          └── Status → idle                                          ║
║                                                                     ║
║  Task 2 arrives via channel                                         ║
║    ├── session-start detects Status: idle → asks for task           ║
║    ├── Status → in_progress                                         ║
║    ├── Work...                                                      ║
║    └── Task complete → idle transition                              ║
║          ├── pattern-detect (skipped — only 2 reports)              ║
║          └── Archive → S-002-REPORT.md                              ║
║                                                                     ║
║  Task 3 completes → idle transition                                 ║
║          ├── pattern-detect (NOW ACTIVE — 3 reports exist)          ║
║          │     Reads S-001, S-002, S-003                            ║
║          │     Compares blockers, workarounds, costs, tags          ║
║          │     Auto-creates proposals if patterns found             ║
║          └── Archive → S-003-REPORT.md                              ║
║                                                                     ║
║  Task 4+ — learning loop runs at every task boundary                ║
║          ├── Detects new patterns                                   ║
║          ├── Checks if accepted proposals resolved the issue        ║
║          └── Sends channel alerts for new auto-proposals            ║
║                                                                     ║
║  Throughout: heartbeat ticks every 30m (or configured interval)     ║
║     └── Every 20 ticks: self-evaluates checklist effectiveness      ║
║                                                                     ║
║  hermit-stop → /session-close --shutdown → full close → kill tmux   ║
╚══════════════════════════════════════════════════════════════════════╝
```

Each task boundary (idle transition or full shutdown) produces an archived report. These reports are the raw material for pattern detection.

---

## 1d. When Self-Learning Fires

The self-learning loop is powered by the `pattern-detect` skill. It runs at one specific moment: during session close, after SHELL.md is finalized but before the report is archived. This applies to both idle transitions and full shutdowns.

### What Triggers It

```
Task complete
  │
  ▼
session-close
  ├── 1. Finalize SHELL.md (plan, blockers, lessons)
  ├── 2. Create manual proposals (if findings found)
  ├── 3. pattern-detect ◄── SELF-LEARNING RUNS HERE
  │         ├── Read last 5 S-NNN-REPORT.md files
  │         ├── Extract: Blockers, Progress Log, Summary
  │         ├── Run 4 detection categories (see below)
  │         ├── Dedup against existing proposals
  │         ├── Auto-create PROP-NNN.md if new pattern found
  │         ├── Check if accepted proposals are resolved
  │         └── Send channel alert if new proposals created
  ├── 4. Archive → S-NNN-REPORT.md
  └── 5. Reset or replace SHELL.md
```

### The Four Detection Categories

| Category | What it detects | Threshold |
|---|---|---|
| **Blocker recurrence** | Same blocker appearing across sessions (semantic match, not exact string) | 3+ sessions |
| **Workaround repetition** | Same temporary fix applied repeatedly ("worked around", "manually", "temporary fix") | 2+ sessions |
| **Cost trend** | Spending increasing significantly across recent sessions | Last-3 avg >50% above prior-3, AND >$1.00 absolute |
| **Tag correlation** | Sessions sharing a tag consistently closing as blocked or partial | 3+ sessions with same tag closing non-successfully |

### Activation Timeline

Pattern detection requires **at least 3 archived session reports** to have enough data. Here's what happens over the first sessions:

| After Task | Reports Available | Pattern Detection | Learning Status |
|---|---|---|---|
| 1 | 1 | Skipped | No data yet |
| 2 | 2 | Skipped | Not enough data |
| 3 | 3 | **Active** | First patterns may be detected |
| 4 | 4 | Active | Compares last 5 (or all available) |
| 5+ | 5+ | Active | Rolling window of last 5 reports |

### The Feedback Loop

Self-learning is not just detection — it closes the loop:

```
Detect pattern → Create auto-proposal → Operator accepts → Fix applied
                                                               │
                 ┌─────────────────────────────────────────────┘
                 ▼
  3 sessions pass without recurrence → Auto-resolve proposal
```

1. **Detection:** Pattern-detect finds a recurring issue and creates `PROP-NNN.md` with `Source: auto-detected`
2. **Operator review:** `/proposal-list` shows auto-proposals prominently. `/proposal-act accept` marks it accepted and optionally creates a `NEXT-TASK.md`
3. **Fix:** The next session picks up `NEXT-TASK.md` as its task and implements the fix
4. **Verification:** On subsequent task closes, pattern-detect checks accepted proposals — if the pattern hasn't recurred in 3 sessions, the proposal is auto-marked `resolved`

The operator is always in the loop. Auto-proposals are created but never auto-applied. The agent suggests; you decide.

### Heartbeat Self-Evaluation

The heartbeat provides a second, lighter learning channel. It tracks a `total_ticks` counter in `config.json` (persists across tasks). Every N ticks (default 20), it evaluates checklist effectiveness:

- Items that were OK for all recent ticks → suggest removal (stale checks)
- Recent auto-proposals about recurring issues → suggest adding a relevant check

Self-evaluation suggestions are reported to the operator, never auto-applied.

---

## 2. Enabling Channels (Telegram / Discord / iMessage)

[Claude Code Channels](https://code.claude.com/docs/en/channels) is a research preview (v2.1.80+) that lets you communicate with your running agent via Telegram, Discord, or iMessage. The agent receives messages and responds using the `channel-responder` skill.

### Prerequisites

- Claude Code v2.1.80 or later
- [Bun](https://bun.sh/) runtime installed on the host machine

```bash
# Install Bun if you don't have it
curl -fsSL https://bun.sh/install | bash
```

### Pairing Flow

1. **Start Claude Code** in your project directory (inside tmux).

2. **Find the bot** on Telegram, Discord, or iMessage and send it a direct message.

3. **Get a pairing code** -- the bot will reply with a short code.

4. **Approve in Claude Code** -- in your running session, you will be prompted to approve the pairing. Enter the code to confirm.

5. **Done** -- once approved, your Telegram/Discord/iMessage account is allowlisted. Messages you send to the bot will be routed to the running Claude Code session.

### How Messages Are Handled

The `channel-responder` skill (bundled with the plugin) classifies inbound messages:

| Message Type | Example | Agent Response |
|-------------|---------|----------------|
| Status request | "what are you working on?" | Concise summary from SHELL.md |
| New instruction | "work on the auth module" | Confirms and updates task |
| Question | "why did you change X?" | Answers in session context |
| Emergency | "stop" / "abort" | Halts work, marks session blocked |

Responses are kept concise -- one short paragraph, appropriate for a chat interface.

### Local-Scope Channel Config

By default, Claude Code stores channel configuration at the user level: `~/.claude/channels/<plugin>/`. This works fine for a single agent, but for multi-agent setups -- multiple projects, each with its own bot or access policy -- you should scope channel config locally per project.

**Why local scope:**

- Each project gets its own sender allowlist and group policies
- Access policy (who can message the bot, which groups it responds in) stays with the project clone
- Bot token can be shared from user-level or overridden per project
- Nothing is committed to git -- channel config, access policies, and tokens all stay local to the machine, which is safer than project scope where you'd need to gitignore secrets manually

> **Note:** Local-scope channel config is not documented in the official Claude Code channels docs as of March 2025. The official docs only reference `~/.claude/channels/<plugin>/` paths. This works because Claude Code merges `.claude/` at user (`~/.claude/`), project (`<project>/.claude/`), and local (`<project>/.claude.local/`) levels -- the local `access.json` overrides both user-level and project-level config.

**Setup:**

1. Install the channel plugin (user-level, one-time):

   ```
   /plugin install telegram@claude-plugins-official
   ```

2. Create the local channel directory:

   ```bash
   mkdir -p .claude.local/channels/telegram
   ```

3. Add `access.json` with your access policy:

   ```json
   {
     "dmPolicy": "pairing",
     "allowFrom": ["<your-telegram-user-id>"],
     "groups": {
       "<group-or-channel-id>": {
         "requireMention": false,
         "allowFrom": []
       }
     },
     "pending": {}
   }
   ```

   `dmPolicy: "pairing"` means new senders must complete the pairing flow before the bot responds. `allowFrom` is a list of already-approved sender IDs. `groups` controls which group chats the bot listens in.

4. (Optional) Add a local `.env` if you want a different bot token per project:

   ```
   # .claude.local/channels/telegram/.env
   TELEGRAM_BOT_TOKEN=your-bot-token-here
   ```

   If omitted, it falls back to `~/.claude/channels/telegram/.env`.

5. Verify `.claude.local/` is gitignored. Claude Code adds it by default, but confirm:

   ```bash
   grep -q '.claude.local' .gitignore || echo '.claude.local/' >> .gitignore
   ```

   Since the entire `.claude.local/` directory is gitignored, neither your access policy nor your bot token will ever be committed.

6. Start Claude Code with the channel:

   ```bash
   claude --channels plugin:telegram@claude-plugins-official
   ```

   Or use the boot script, which reads channel config from `config.json` automatically.

**For Discord or iMessage:** The same directory pattern applies. Replace `telegram` with `discord` or `imessage` in the paths above, and use the corresponding plugin name (e.g., `discord@claude-plugins-official`).

**Multi-agent recommendation:** If you run multiple autonomous agents (one per project), configure channels at local scope. This ensures each agent has its own access policy, avoids cross-project message routing, and keeps all channel config off the repo entirely. Each project can use the same bot token (shared from user-level) or a dedicated bot per project (overridden in the local `.env`).

---

## 3. Using /loop for Polling Tasks

The `/loop` command runs a slash command repeatedly at a fixed interval. This turns the agent into a polling system for monitoring, maintenance, or periodic check-ins.

### Basic Usage

```
/loop 5m /session-start
```

This runs `/session-start` every 5 minutes. Each iteration:
- Loads session context (SHELL.md)
- Checks progress and blockers
- Performs the next step if the task is in progress
- Updates SHELL.md with results

### Use Cases

**Deploy monitoring:**
```
/loop 10m /session-start
```
Set the task to "Monitor the staging deployment, check logs for errors, and alert me if anything fails."

**Scheduled maintenance:**
```
/loop 15m /session-start
```
Set the task to "Run the test suite, check for dependency updates, and summarize findings."

**Periodic health checks:**
```
/loop 5m /session-start
```
Set the task to "Check application health endpoints and report any failures via channel."

### Interval Guidelines

| Interval | When to Use | Approximate Daily Cost* |
|----------|------------|------------------------|
| 5 min | Active monitoring, fast iteration | Higher -- use sparingly |
| 10 min | Standard polling, deploy watches | Moderate |
| 15 min | Background maintenance, low-priority checks | Lower |

*Actual cost depends on task complexity and token usage per iteration. See Cost Management below.

> **Tip:** Start with a longer interval (15m) and shorten it only if you need faster response times. Each loop iteration consumes tokens.

---

## 4. Cost Management

### How Cost Tracking Works

The `cost-tracker` hook (bundled with the plugin as `scripts/cost-tracker.js`) runs on every `Stop` event and:

1. Logs token usage and estimated cost to `.claude/cost-log.jsonl`
2. Injects a `## Cost` section into `sessions/SHELL.md` with running totals
3. Outputs a summary line to the console

### Monitoring Costs

Use the `/cost` command inside Claude Code to see accumulated spending:

```
/cost
```

You can also inspect the raw log:

```bash
cat .claude/cost-log.jsonl | tail -20
```

Each line is a JSON object:

```json
{
  "timestamp": "2026-03-23T14:30:00.000Z",
  "session_id": "abc123",
  "model": "sonnet",
  "input_tokens": 15000,
  "output_tokens": 3000,
  "total_tokens": 18000,
  "estimated_cost_usd": 0.09
}
```

### Token Optimization

The plugin recommends these settings for cost efficiency in `.claude/settings.json`:

```json
{
  "env": {
    "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE": "50",
    "MAX_THINKING_TOKENS": "10000",
    "CLAUDE_CODE_SUBAGENT_MODEL": "haiku"
  }
}
```

**What these do:**

| Setting | Value | Effect |
|---------|-------|--------|
| `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` | `50` | Auto-compacts context when it hits 50% of the window, keeping the working set smaller |
| `MAX_THINKING_TOKENS` | `10000` | Caps extended thinking to 10K tokens, preventing runaway reasoning costs |
| `CLAUDE_CODE_SUBAGENT_MODEL` | `haiku` | Uses the cheapest model for subagent exploration tasks |

**Model selection strategy:**

| Model | Per-1M Input | Per-1M Output | Use For |
|-------|-------------|---------------|---------|
| Haiku | $0.80 | $4.00 | Exploration, file scanning, orientation |
| Sonnet | $3.00 | $15.00 | 80% of work -- coding, reviews, session management |
| Opus | $15.00 | $75.00 | Complex reasoning, architecture decisions, multi-file refactors |

### Setting a Budget

**Per-session budgets** are built in. When starting a new session, the agent asks for a cost budget (configurable via `/claude-code-hermit:hermit-settings budget`). The cost-tracker hook warns at 80% and 100% of the budget.

You can also set project-level budgets in `OPERATOR.md`:

```markdown
## Constraints
Monthly Claude budget: $200. Alert at $150.
```

The agent reads OPERATOR.md at session start and will respect stated constraints.

---

## 5. Reconnecting After Disconnects

The agent's state is designed to survive any disconnect -- SSH drops, terminal crashes, machine reboots. Here is how.

### Where State Lives

All session state is in `sessions/SHELL.md`. This is a plain file on disk, not in memory. A disconnect loses the in-memory conversation context, but the task, progress, and blockers are all persisted.

### What Happens on Reconnect

1. **You reattach to tmux** and start Claude Code again (or it is already running if the process survived):

```bash
tmux attach -t claude-agent
# If Claude Code exited, restart it:
claude --dangerously-skip-permissions
```

2. **The SessionStart hook fires automatically** and loads:
   - `OPERATOR.md` -- project context and constraints
   - `sessions/SHELL.md` -- current task, progress, blockers
   - The most recent `sessions/S-*-REPORT.md` -- continuity from past sessions

3. **The `session-start` skill detects the active session** and presents:
   - What the task was
   - Which plan items are done, in progress, or blocked
   - What to do next

4. **You confirm whether to resume or start fresh.**

### Example Recovery

```
$ tmux attach -t claude-agent
# Claude Code starts, SessionStart hook runs automatically

> [Session Context Loaded]
> Active session found: "Migrate auth module to OAuth2"
> Progress: 3/5 plan items complete
> Current step: "Update token refresh logic" (in_progress)
> Blockers: None
>
> Continue this task, or start a new one?
```

You just type "continue" and the agent picks up where it left off.

---

## 6. Security Considerations

### Permission Deny Patterns

The `settings.json` file defines hard denials that cannot be overridden:

```json
{
  "permissions": {
    "deny": [
      "Bash(rm -rf /)",
      "Bash(git push --force)",
      "Write(.env)",
      "Write(*.pem)",
      "Write(*.key)"
    ]
  }
}
```

These block the agent from:
- Destructive filesystem operations
- Force-pushing to any remote
- Writing secrets or key files

Add your own deny patterns for project-specific sensitive areas.

### Hook Profiles

The `AGENT_HOOK_PROFILE` environment variable controls hook strictness:

| Profile | What It Enables |
|---------|----------------|
| `minimal` | Cost tracking only |
| `standard` | Cost tracking + compact suggestions + session evaluation |
| `strict` | All of standard + additional safety hooks from hermit agents |

For always-on production-adjacent work, use `strict`:

```json
{
  "env": {
    "AGENT_HOOK_PROFILE": "strict"
  }
}
```

### Hermit Agent Hooks

Hermit agents can register additional hooks. For example, `claude-code-dev-hermit` provides `git-push-guard` on the `strict` profile, blocking direct pushes to main, `--no-verify`, and `--force`.

### Secrets Handling

- **Never** store secrets (API keys, tokens, passwords) in repo files
- The deny patterns block writing to `.env`, `.pem`, and `.key` files
- Reference secrets via environment variables or a secrets manager
- If you need the agent to use an API, set the key as an environment variable before starting Claude Code:

```bash
# Set secrets as env vars BEFORE starting the agent
export MY_API_KEY="sk-..."
tmux new-session -d -s claude-agent
tmux send-keys -t claude-agent "cd /path/to/project && claude --dangerously-skip-permissions" Enter
```

---

## 7. Example: 24/7 Dev Agent on a Mac Mini / VPS

A complete walkthrough for setting up a persistent Claude Code agent on a dedicated machine.

### Prerequisites

- A Mac Mini, VPS, or any always-on Linux/macOS machine
- Claude Code installed (`npm install -g @anthropic-ai/claude-code`)
- Bun installed (for Channels support)
- tmux installed (`brew install tmux` or `apt install tmux`)
- The claude-code-hermit plugin installed in your project

### Step 1: Install and Configure

```bash
# Install the plugin into your project
cd ~/my-project
claude plugin marketplace add gtapps/claude-code-hermit
claude plugin install claude-code-hermit@claude-code-hermit --scope project

# Initialize and fill in your project context
claude
/claude-code-hermit:init
# Then exit and edit OPERATOR.md
vim .claude/.claude-code-hermit/OPERATOR.md
```

Edit `OPERATOR.md` with your project details, constraints, and budget.

### Step 2: Set Hook Profile to Strict

For an always-on agent, use the `strict` profile. Edit `.claude/settings.json`:

```json
{
  "env": {
    "AGENT_HOOK_PROFILE": "strict"
  }
}
```

### Step 3: Start with the Boot Script

```bash
cd ~/my-project
.claude/.claude-code-hermit/bin/hermit-start
```

The boot script reads `config.json`, starts a tmux session with channels, and auto-runs `/claude-code-hermit:session`. Verify it's running:

```bash
tmux attach -t hermit-my-project
```

### Step 4: Set Up a Telegram Channel

If you configured Telegram in the init wizard, the channel is already active. Open Telegram and DM the Claude Code bot:

1. The bot sends a pairing code
2. In Claude Code, approve the pairing when prompted
3. Test by sending "status" via Telegram — the `/claude-code-hermit:status` skill auto-triggers and responds with the current session state

Now you can communicate with the agent from your phone. Try "brief" for a 5-line summary.

### Step 5: Enable Heartbeat

If you enabled heartbeat during init (or via `/claude-code-hermit:hermit-settings heartbeat`), the boot script auto-starts the heartbeat loop. It periodically runs `.claude/.claude-code-hermit/HEARTBEAT.md` — a checklist you can edit:

```
/claude-code-hermit:heartbeat edit
```

The default checklist checks for unblocked steps, changed conditions, and unreviewed proposals. Customize it for your project:

```markdown
# Heartbeat Checklist
- Check if CI pipeline has new results
- Check if any open PRs have new reviews
- Check if the staging deploy is healthy
```

Heartbeat respects `active_hours` (default 08:00-23:00) and only sends channel alerts when something needs attention. OK results are logged silently to SHELL.md.

### Step 5b: Ad-hoc Monitoring

For task-specific monitoring (not background health), use the monitor skill:

```
/claude-code-hermit:monitor check API health at https://api.example.com/health — every 10m
```

Findings are automatically logged to SHELL.md.

### Step 6: Access Remotely

Enable remote control in config (`/claude-code-hermit:hermit-settings remote`), or inside the running session:

```
/remote-control
```

Connect via the URL or at [claude.ai/code](https://claude.ai/code) from your phone or laptop. See the [remote control docs](https://code.claude.com/docs/en/remote-control) for details.

### Step 7: Verify Everything Is Running

From another terminal (or SSH session):

```bash
# Check tmux session is alive
tmux list-sessions

# Check cost log is being written
tail -5 ~/my-project/.claude/cost-log.jsonl

# Check SHELL.md has recent updates
cat ~/my-project/.claude/.claude-code-hermit/sessions/SHELL.md
```

### Putting It All Together

Once set up, your always-on agent:

1. **Runs continuously** in a tmux session that survives disconnects
2. **Accepts commands** via Telegram/Discord/iMessage from your phone
3. **Polls periodically** via `/loop` for monitoring or maintenance tasks
4. **Tracks costs** automatically, with data visible in SHELL.md and via `/cost`
5. **Recovers from crashes** by reading session state from disk on restart
6. **Stays safe** via permission denials, hook profiles, and hermit agent safety hooks

---

## 8. Security Best Practices

Running an autonomous agent with `--dangerously-skip-permissions` means the agent can execute any command on the host machine. These practices keep the blast radius small and prevent the most common mistakes.

> **Note:** Sections 8.1 and 9 (Docker) are aimed at agents running with `--dangerously-skip-permissions`. Running in a container is your decision — we suggest it because the official Claude Code docs advise using that flag only in isolated environments. If you run without the flag, the standard permission system provides its own safety.

### 8.1 Consider Docker When Using `--dangerously-skip-permissions`

Claude Code's own documentation states:

> "Only use [--dangerously-skip-permissions] in isolated environments like containers or VMs where Claude Code cannot cause damage."

If the agent runs a destructive command -- `rm -rf /`, a bad `chmod`, an accidental `curl | bash` -- the damage is contained to the container. Your host machine, other projects, and credentials remain untouched.

**Minimum container hygiene:**

- Run as a **non-root user** inside the container
- Mount only your **project directory** as a volume, not the entire filesystem
- Never use `--privileged` mode
- Never mount the Docker socket (`/var/run/docker.sock`)

See [Section 9: Running in Docker](#9-running-in-docker) for a complete setup.

> **Without `--dangerously-skip-permissions`:** Many operators run always-on agents on bare metal with tmux (Sections 1-7). Claude Code's normal permission prompts, deny patterns, and hook profiles provide safety on their own. Docker is entirely up to you.

### 8.2 Use Deny Patterns

Deny patterns in `.claude/settings.json` block specific tool invocations. They work **even with `--dangerously-skip-permissions`** -- the agent cannot override them.

Deny patterns use glob matching. Use wildcards generously to catch variations.

**Recommended deny list:**

```json
{
  "permissions": {
    "deny": [
      "Bash(rm -rf *)",
      "Bash(chmod 777*)",

      "Bash(*sudo *)",
      "Bash(*> /etc/*)",
      "Bash(*> /usr/*)",

      "Bash(curl * | bash)",
      "Bash(wget * | bash)",
      "Bash(curl * | sh)",
      "Bash(ssh *)",
      "Bash(scp *)",

      "Bash(docker *)",
      "Bash(kubectl *)",

      "Bash(npm publish*)",
      "Bash(pip upload*)",

      "Bash(git push --force*)",
      "Bash(git push origin main*)",
      "Bash(*--no-verify*)",

      "Bash(env)",
      "Bash(printenv)",
      "Bash(cat ~/.ssh/*)",
      "Bash(cat ~/.aws/*)",
      "Bash(*API_KEY*)",
      "Bash(*SECRET*)",
      "Bash(*PASSWORD*)",
      "Bash(*TOKEN*)"
    ]
  }
}
```

This covers the most dangerous categories: destructive commands, privilege escalation, network abuse, container escape, package publishing, unsafe git operations, and secret exfiltration. Add project-specific patterns as needed.

### 8.3 Defense in Depth -- Five Layers

No single layer is foolproof. Stack them:

| Layer | Where It Lives | How It Works |
|-------|---------------|--------------|
| **1. Deny patterns** | `.claude/settings.json` | Enforced by the Claude Code runtime. Blocks matching tool calls before execution. |
| **2. Agent-level rules** | `agents/*.md` | Behavioral instructions the agent follows. Not enforced -- relies on instruction-following. |
| **3. Hook enforcement** | `hooks.json` | PreToolUse hooks intercept tool calls and can block them programmatically. |
| **4. Container isolation** | Docker / VM | Limits blast radius. Even if layers 1-3 fail, damage stays inside the container. |
| **5. OPERATOR.md constraints** | `.claude/.claude-code-hermit/OPERATOR.md` | Behavioral constraints read at session start. The agent treats these as operating rules. |

Layers 1, 3, and 4 are enforced mechanically. Layers 2 and 5 depend on the model following instructions -- effective but not airtight. We suggest using all five when running unattended.

### 8.4 Restrict Network Access

Four options, from most to least restrictive:

**A. No network at all (Docker `--network=none`)**

The agent cannot make any outbound connections. This breaks channels, `git push/pull`, and package installation. Use this only for fully offline tasks where all dependencies are pre-installed.

**B. Outbound-only with a domain allowlist**

Allow HTTPS to a short list of domains: `api.anthropic.com` (required for Claude API), your channel API (e.g., `api.telegram.org`), and `github.com`. Block everything else with firewall rules or a proxy. This is the best balance of safety and functionality.

**C. Deny network tools in settings.json**

Add `curl`, `wget`, `ssh`, and `nc` to your deny patterns (see 8.2). This prevents the agent from using shell-based network tools but does **not** block HTTP requests from Node.js or Python libraries. A partial measure -- combine with container isolation.

**D. Unrestricted (default)**

The agent can reach any host. Mitigate with deny patterns and container isolation. This is the simplest setup but the largest attack surface.

### 8.5 Separate Secrets from the Agent's Reach

The agent does not need access to your production credentials, cloud configs, or SSH keys. Keep them out of reach:

- **Do not mount** `~/.aws/`, `~/.ssh/`, or `~/.config/gcloud/` into the container
- **Do not set** production API keys as environment variables the agent can read
- **Use a dedicated `.env.agent`** file with only `ANTHROPIC_API_KEY` (and channel tokens if needed)
- **Create scoped API keys** with the minimum permissions required for the task
- **Add a deny pattern** for `Bash(cat ~/.env*)` to block the agent from reading env files directly

If the agent needs to interact with an external service, create a dedicated API key with read-only or narrowly scoped permissions, and pass it as an environment variable.

### 8.6 Review Session Reports Before Committing

Session reports (`sessions/S-NNN-REPORT.md`) are committed to the repo by default. Before pushing, review them for:

- **File paths** that reveal internal infrastructure
- **Error messages** that include connection strings or credentials
- **Progress log entries** that accidentally include sensitive data from command output

For public repositories, consider adding `sessions/` to `.gitignore` to prevent accidental exposure.

### 8.7 Use the Strict Hook Profile

The `strict` hook profile activates all safety hooks from the base plugin and any installed hermit agents, with no performance penalty. Set it in `.claude/settings.json`:

```json
{
  "env": {
    "AGENT_HOOK_PROFILE": "strict"
  }
}
```

We suggest `strict` for always-on agents — there is no performance penalty.

### 8.8 Set a Task Budget

Hermit's task budget caps spending per session. The `cost-tracker` hook warns at 80% of the budget and recommends closing the session at 100%.

Configure the default budget via `/claude-code-hermit:hermit-settings budget`. Starting conservative ($5-10) is reasonable for overnight sessions. You can always start a new session with a higher budget if the work needs it. Without a budget, a confused agent can burn through your quota before you wake up.

### 8.9 Monitor with Heartbeat

For always-on agents, set `active_hours` to `00:00-23:59` (24/7) in your heartbeat config so the agent monitors itself around the clock. Heartbeat detects:

- **Stalled agents** -- no progress updates for an extended period
- **Changed conditions** -- new CI results, new PR reviews, deployment failures
- **Rate limits** -- the agent hits API limits and stops making progress

Without heartbeat, a stalled agent wastes time silently. You will not know anything is wrong until you manually check.

### 8.10 Quick Security Checklist

Run through this before starting an always-on agent:

- [ ] Running in Docker or a VM if using `--dangerously-skip-permissions`
- [ ] Non-root user inside the container (if using Docker)
- [ ] Deny patterns configured in `.claude/settings.json`
- [ ] No host filesystem mounts beyond the project directory (if using Docker)
- [ ] No Docker socket mounted (if using Docker)
- [ ] No production credentials accessible to the agent
- [ ] Strict hook profile enabled (`AGENT_HOOK_PROFILE=strict`)
- [ ] Task budget set (start with $5-10 for overnight)
- [ ] Heartbeat enabled (if using channels)
- [ ] OPERATOR.md includes approval constraints (e.g., "do not merge without human review")
- [ ] Session reports reviewed before pushing to remote
- [ ] Network restricted to minimum required access

---

## 9. Running in Docker

If you are running with `--dangerously-skip-permissions` (unattended mode), Docker provides containment, reproducibility, and crash recovery via container restarts. See [Section 8.1](#81-consider-docker-when-using---dangerously-skip-permissions) for why we suggest it.

### Authentication

You need to authenticate Claude Code inside the container. Two options:

**Option A: OAuth (Pro/Max plans)**

Authenticate on the host first, then mount the credentials into the container:

```bash
# On your host machine, authenticate once:
claude login

# The credentials are stored in ~/.claude/
# Mount this directory into the container (see docker-compose.yml below)
```

OAuth credentials persist and auto-refresh. No browser is needed inside the container.

**Option B: API Key**

Pass your API key as an environment variable. No browser or login step needed:

```bash
docker run -e ANTHROPIC_API_KEY=sk-ant-... your-agent-image
```

### Dockerfile

```dockerfile
FROM node:22-slim

# System dependencies
RUN apt-get update && apt-get install -y \
    tmux \
    python3 \
    git \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Install Bun (needed for Channels)
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:$PATH"

# Install Claude Code
RUN npm install -g @anthropic-ai/claude-code

# Create non-root user
RUN useradd -m -s /bin/bash claude
USER claude
WORKDIR /home/claude/project

# The boot script path inside the container — set by hermit-start
CMD ["python3", ".claude/.claude-code-hermit/bin/hermit-start"]
```

> **Note:** The `CMD` assumes the project is mounted at `/home/claude/project` with the hermit state directory already initialized. Run `/claude-code-hermit:init` in your project on the host before building the container.

### docker-compose.yml

```yaml
services:
  claude-agent:
    build: .
    volumes:
      # Mount your project directory
      - /path/to/your/project:/home/claude/project
      # Mount Claude credentials (for OAuth auth)
      - ~/.claude:/home/claude/.claude
    environment:
      # Use EITHER OAuth (mount above) OR API key (uncomment below)
      # - ANTHROPIC_API_KEY=sk-ant-...
      - AGENT_HOOK_PROFILE=strict
    restart: unless-stopped
    # Uncomment for full network isolation (breaks channels, git, package install):
    # network_mode: "none"
```

> **Important:** If you use `network_mode: "none"`, the agent cannot reach the Anthropic API, channel APIs, or git remotes. Only use this for fully offline tasks with a local model endpoint.

### Network and Channels

If you are using channels (Telegram/Discord/iMessage), do **not** use `--network=none`. Channel plugins need outbound HTTPS access to their respective APIs.

For a middle ground:

- Allow outbound HTTPS (the agent needs `api.anthropic.com` and your channel API)
- Deny network tools in `settings.json` to prevent the agent from using `curl`, `wget`, or `ssh` directly

This lets the agent communicate via channels while blocking it from making arbitrary network requests from the shell.

### Crash Recovery

Container restarts (OOM-kill, orchestrator restart, host reboot) trigger hermit's crash recovery automatically:

1. The container restarts and runs the boot script
2. The boot script starts Claude Code, which fires the SessionStart hook
3. The hook detects an orphaned `sessions/SHELL.md` (from the crashed session)
4. The agent offers to resume the previous task or start fresh

This is the same recovery flow described in [Section 5](#5-reconnecting-after-disconnects), but it happens automatically inside the container.

### Limitations

- **IDE integration** (VS Code, Cursor) does not work inside containers. Use remote control or channels to interact with the agent instead.
- **File permissions:** Ensure the non-root container user (`claude`) owns the project mount. If files are owned by a different UID, the agent cannot read or write them. Use `chown` on the host or match UIDs.
- **GPU passthrough** is not needed. Claude Code is API-based -- all inference happens on Anthropic's servers. The container only needs CPU, memory, and network.

---

## 10. Operational Concerns

### Rate Limits and Unattended Sessions

Claude Max 20x ($200/month) is the recommended plan for overnight agents. The Pro plan ($20/month) will stall during multi-hour sessions due to rate limits.

Rate limit pauses are **silent** -- the agent does not throw an error or send a notification. It simply waits until the limit resets, then continues. From the outside, this looks like a stalled agent.

**Mitigation:** Add this instruction to your `OPERATOR.md`:

```markdown
## Constraints
If you hit a rate limit, update SHELL.md with a note: "Rate limited at [timestamp]. Waiting for reset."
```

This ensures the agent documents the pause, so you can see what happened when you check in.

### Data Persistence

`sessions/SHELL.md` is gitignored by default. If the disk fails or the container is destroyed, the in-progress session state is lost. Completed session reports (`sessions/S-NNN-REPORT.md`) are committed and survive.

Three options for protecting in-progress state:

1. **Docker named volume** -- attach a named volume to the `.claude/.claude-code-hermit/sessions/` directory. Survives container rebuilds.
2. **Remove from .gitignore** -- commit `SHELL.md` along with reports. Adds noise to your git history but ensures nothing is lost.
3. **Periodic commit to a separate branch** -- add an instruction in the heartbeat checklist to commit session state to a `hermit/session-state` branch periodically.

### Channel Resilience

If Telegram, Discord, or iMessage goes down, the agent keeps running -- it just loses the remote communication channel. You will not be able to send commands or receive status updates until the service recovers.

**Mitigations:**

- **Enable Remote Control** as a backup path. It uses Anthropic's servers, independent of Telegram/Discord/iMessage. See [Section 1: Reconnecting from Anywhere](#reconnecting-from-anywhere).
- **Heartbeat continues running** when channels are down. Pending alerts are not replayed when the channel comes back, but the full history is recorded in `SHELL.md`.
- **Check SHELL.md directly** via SSH or tmux if channels are unavailable.

### Multi-Operator Warning

Hermit assumes a **single operator per project**. If two people start sessions in the same project directory simultaneously:

- Session ID collisions will occur (both agents write to the same `SHELL.md`)
- Cost tracking will merge data from both agents
- Session reports may contain interleaved progress from different tasks

**For team use:** Give each operator a separate branch or git worktree, each with its own `.claude/.claude-code-hermit/` state directory. This keeps session state isolated.

---

### Automating Restart on Reboot

To survive machine reboots, add a systemd service (Linux) or launchd plist (macOS):

**Linux (systemd):**

```bash
# /etc/systemd/system/claude-agent.service
[Unit]
Description=Claude Code Agent
After=network.target

[Service]
Type=forking
User=your-username
ExecStart=/usr/bin/tmux new-session -d -s claude-agent -c /home/your-username/my-project \; send-keys "claude --dangerously-skip-permissions" Enter
ExecStop=/usr/bin/tmux kill-session -t claude-agent
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable claude-agent
sudo systemctl start claude-agent
```

**macOS (launchd):**

```bash
# ~/Library/LaunchAgents/com.claude.agent.plist
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.claude.agent</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/tmux</string>
        <string>new-session</string>
        <string>-d</string>
        <string>-s</string>
        <string>claude-agent</string>
        <string>-c</string>
        <string>/Users/your-username/agent</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <false/>
</dict>
</plist>
```

```bash
launchctl load ~/Library/LaunchAgents/com.claude.agent.plist
```

> **Note:** The launchd plist starts the tmux session. You still need to manually start Claude Code inside it after reboot, or chain the commands as shown in the systemd example. The SessionStart hook will automatically reload session context when Claude Code starts.
