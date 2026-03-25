# claude-code-hermit

I love Claude Code. I love what [OpenClaw](https://github.com/anthropics/claude-code/tree/main/.github/openclaw) did for autonomous agents. Hermit is my take on the Claude Code autonomous agent -- a plugin that adds session discipline, progress tracking, and a learning loop so it can run unsupervised. Plain markdown, no dependencies, no build step.

---

## What It Does

- **Session tracking** -- Every unit of work gets a mission, tracked steps, a cost log, and an archived report. Get disconnected? The agent picks up exactly where it left off.
- **Status & brief** -- Type "status" for a quick summary or "brief" for a 5-line executive update. Both auto-trigger on natural language -- just say it.
- **Monitoring & heartbeat** -- `/monitor` watches for conditions during a task. `/heartbeat` runs a background checklist on a schedule, alerting you via Telegram, Discord, or iMessage when something needs attention.
- **Learning loop** -- After 3+ sessions, the agent spots patterns: recurring blockers, repeated workarounds, cost trends. It creates improvement proposals automatically.
- **Proposals** -- Ideas captured as numbered proposals, reviewed and acted on at your pace. The agent suggests; you decide.
- **Operator contract** -- `OPERATOR.md` holds your project context, constraints, and preferences. Written by you, read by the agent at every session start. It's how you shape the agent's judgment.
- **Always-on** -- Boot scripts launch the agent in tmux with channels, remote control, and heartbeat. Walk away from the terminal and manage everything from your phone.

## What Makes It Different

|           | claude-code-hermit                               | Typical agent frameworks           |
| --------- | ------------------------------------------------ | ---------------------------------- |
| Runtime   | Claude Code (the CLI you already use)            | Custom Python/Node runtime         |
| Install   | `claude plugin install`                          | Package manager, virtual env, etc. |
| Files     | ~38 markdown, JSON, JS, and Python files         | Hundreds of source files           |
| Extension | Add a `.md` file to `agents/` or `skills/`       | Write code against an SDK          |
| State     | Plain markdown in your repo                      | Database, vector store, or API     |

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

The two things that make hermit come alive:

- **[Channels](https://code.claude.com/docs/en/channels)** -- connect to Telegram, Discord, or iMessage. Send missions, check status, and get alerts from your phone.
- **[Remote control](https://code.claude.com/docs/en/remote-control)** -- access the running agent from any browser via claude.ai/code. Enabled by default.

With both configured, you can manage the agent entirely from your phone.

### 3. Customize OPERATOR.md

The wizard generates a draft `OPERATOR.md` -- review it, add your project constraints, sensitive areas, and preferences. This is the file the agent reads at every session start. It's how you shape its judgment without micromanaging.

### 4. Run

**Interactive:**

```
/claude-code-hermit:session
```

The agent asks for a mission, plans steps, tracks everything in `ACTIVE.md`. Type "status" anytime. Close with `/claude-code-hermit:session-close`.

**Always-on (persistent in tmux):**

```bash
.claude/.claude-code-hermit/bin/hermit-start    # launch with channels + heartbeat
.claude/.claude-code-hermit/bin/hermit-stop     # graceful shutdown
```

See [ALWAYS-ON-OPS.md](docs/ALWAYS-ON-OPS.md) for the full operations guide -- cost management, Docker isolation, systemd/launchd auto-restart.

---

## Domain Packs

Hermit core is domain-agnostic. For software development workflows, install the dev pack:

```bash
claude plugin marketplace add gtapps/claude-code-dev-hermit
claude plugin install claude-code-dev-hermit@claude-code-dev-hermit --scope project
/claude-code-dev-hermit:init
```

Adds repo-mapper, implementer, and reviewer agents; `/dev-session` and `/dev-parallel` skills; git-push-guard hook.

---

## Documentation

| Document | Description |
| --- | --- |
| [HOW-TO-USE.md](docs/HOW-TO-USE.md) | Getting started guide |
| [SKILLS.md](docs/SKILLS.md) | Complete reference for all 15 skills |
| [ALWAYS-ON-OPS.md](docs/ALWAYS-ON-OPS.md) | Running as a persistent agent |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | 5-layer architecture, design decisions |
| [UPGRADING.md](docs/UPGRADING.md) | Upgrade guide for plugin updates |
| [CREATING-PROJECT-AGENT.md](docs/CREATING-PROJECT-AGENT.md) | Customizing agents for your project |
| [CREATING-DOMAIN-PACK.md](docs/CREATING-DOMAIN-PACK.md) | Building a reusable domain pack |
| [TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | Common issues and solutions |
| [OBSIDIAN-SETUP.md](docs/OBSIDIAN-SETUP.md) | Optional Obsidian dashboard |

---

## Credits

- **[Everything Claude Code](https://github.com/affaan-m/everything-claude-code)** -- Hook patterns and lifecycle architecture
- **[OpenClaw](https://github.com/anthropics/claude-code/tree/main/.github/openclaw)** -- The autonomous agent structure that inspired all of this

## License

[MIT](LICENSE)
