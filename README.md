# claude-code-hermit

I love Claude Code. I love what [OpenClaw](https://github.com/anthropics/claude-code/tree/main/.github/openclaw) did for autonomous agents. Hermit is my take on the Claude Code autonomous agent — a plugin that turns any Claude Code instance into a fully autonomous, always-on agent you can talk to from your phone.

No custom runtime. No server. No API keys to manage. If you have a Claude Pro, Max, Teams, or Enterprise subscription, you already have everything you need. Each agent is just a Claude Code process — lightweight enough to run several side by side on a single laptop.

---

## Quick Start

### 1. Install the plugin

```bash
cd /path/to/your/project
claude plugin marketplace add gtapps/claude-code-hermit
claude plugin install claude-code-hermit@claude-code-hermit --scope project
```

### 2. Initialize

Start Claude Code and run the init wizard. It creates the state directory, asks about agent identity and settings, and generates an `OPERATOR.md` by scanning your project.

```
/claude-code-hermit:init
```

### 3. Customize OPERATOR.md

The wizard generates a draft `OPERATOR.md` — review it, add your project constraints, sensitive areas, and preferences. This is the file the agent reads at every session start. It's how you shape its judgment without micromanaging.

### 4. Connect channels

Channels are what make hermit come alive. Install the official [Claude Code Channels](https://code.claude.com/docs/en/channels) plugin and configure your bot:

```bash
# Install the channel plugin (e.g., Discord)
claude /plugin install discord@claude-plugins-official

# Add your bot token
mkdir -p .claude/channels/discord
echo 'DISCORD_BOT_TOKEN=your-token-here' > .claude/channels/discord/.env
```

Works with **Telegram**, **Discord**, and **iMessage**. Once connected, you can send tasks, check status, and get alerts — all from your phone. Combined with [remote control](https://code.claude.com/docs/en/remote-control) (enabled by default), you never need to touch the terminal again.

### 5. Run

**Interactive:**

```
/claude-code-hermit:session
```

The agent asks for a task, plans the work, and tracks everything in `SHELL.md`. Type "status" anytime. Close with `/claude-code-hermit:session-close`.

**Always-on (persistent in tmux):**

```bash
.claude/.claude-code-hermit/bin/hermit-start    # launch with channels + heartbeat
.claude/.claude-code-hermit/bin/hermit-stop     # graceful shutdown
```

See [ALWAYS-ON-OPS.md](docs/ALWAYS-ON-OPS.md) for the full operations guide — cost management, Docker isolation, systemd/launchd auto-restart.

---

## What It Does

- **Sessions that survive anything** — Every unit of work gets a task, a tracked plan, a cost log, and an archived report. SSH drops, terminal crashes, machine reboots — the agent reads its own state from disk and picks up exactly where it left off.

- **Status from anywhere** — Type "status" for a compact summary or "brief" for a 5-line executive update. Both auto-trigger on natural language. Connected to a channel? Check in from your phone.

- **Background awareness** — `/monitor` watches for conditions during a task. `/heartbeat` runs a persistent checklist on a schedule, alerting you through channels only when something needs attention.

- **Self-improving** — After 3+ sessions, the agent analyzes its own history: recurring blockers, repeated workarounds, cost trends. It creates improvement proposals automatically. The agent suggests; you decide.

- **Your rules, its judgment** — `OPERATOR.md` holds your project context, constraints, and preferences. The agent reads it at every session start. No micromanaging — just set the boundaries and let it work.

- **Walk-away autonomy** — Boot scripts launch the agent in tmux with channels, remote control, and heartbeat. Manage everything from your phone without touching the terminal.

---

## What Makes It Different

Hermit doesn't replace Claude Code with a custom runtime. It adds structure to what's already there.

|           | claude-code-hermit                               | Typical agent frameworks           |
| --------- | ------------------------------------------------ | ---------------------------------- |
| Runtime   | Claude Code (the CLI you already use)            | Custom Python/Node runtime         |
| Subscription | Works with Pro, Max, Teams, Enterprise         | API keys + per-token billing       |
| Install   | `claude plugin install`                          | Package manager, virtual env, etc. |
| Files     | ~38 markdown, JSON, JS, and Python files         | Hundreds of source files           |
| Resources | Run multiple agents on a single laptop           | Heavy per-instance overhead        |
| Extension | Add a `.md` file to `agents/` or `skills/`       | Write code against an SDK          |
| State     | Plain markdown in your repo                      | Database, vector store, or API     |

---

## Hermits

Hermit core is intentionally generic — it handles sessions, proposals, and operational hygiene. The real power is building your own hermits for specific domains.

### Ready-made hermits

For software development workflows, install the dev hermit:

```bash
claude plugin marketplace add gtapps/claude-code-dev-hermit
claude plugin install claude-code-dev-hermit@claude-code-dev-hermit --scope project
/claude-code-dev-hermit:init
```

Adds repo-mapper, implementer, and reviewer agents; `/dev-session` and `/dev-parallel` skills; git-push-guard hook.

### Build your own

Anyone can build a specialized hermit — either as project-specific agents added directly to your repo, or as a reusable plugin you share across projects. All it takes is markdown files.

- **Project agents:** Drop a `.md` file in `.claude/agents/` with a system prompt and tool permissions. Instant specialist.
- **Reusable hermits:** Package agents, skills, and hooks into a standalone plugin others can install.

Both paths are covered in [CREATING-YOUR-OWN-HERMIT.md](docs/CREATING-YOUR-OWN-HERMIT.md).

---

## Documentation

| Document | Description |
| --- | --- |
| [HOW-TO-USE.md](docs/HOW-TO-USE.md) | Getting started guide |
| [SKILLS.md](docs/SKILLS.md) | Complete reference for all 15 skills |
| [ALWAYS-ON-OPS.md](docs/ALWAYS-ON-OPS.md) | Running as a persistent agent |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | 5-layer architecture, design decisions |
| [UPGRADING.md](docs/UPGRADING.md) | Upgrade guide for plugin updates |
| [CREATING-YOUR-OWN-HERMIT.md](docs/CREATING-YOUR-OWN-HERMIT.md) | Create your own hermit (project-level and reusable) |
| [TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | Common issues and solutions |
| [OBSIDIAN-SETUP.md](docs/OBSIDIAN-SETUP.md) | Optional Obsidian dashboard |

---

## Credits

- **[Everything Claude Code](https://github.com/affaan-m/everything-claude-code)** — Hook patterns and lifecycle architecture
- **[OpenClaw](https://github.com/anthropics/claude-code/tree/main/.github/openclaw)** — The autonomous agent structure that inspired all of this

## License

[MIT](LICENSE)
