<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License" /></a>
  <a href="https://code.claude.com/docs/en/plugins"><img src="https://img.shields.io/badge/Claude%20Code-plugin-orange.svg" alt="Claude Code Plugin" /></a>
  <a href="CHANGELOG.md"><img src="https://img.shields.io/badge/version-0.2.11-green.svg" alt="Version 0.2.11" /></a>
  <img src="https://img.shields.io/badge/Claude-Pro%20%7C%20Max-blueviolet.svg" alt="Claude Pro/Max Compatible" />
  <img src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg" alt="PRs Welcome" />
</p>

# claude-code-hermit

**A personal assistant that lives in your project and gets smarter every session — pure Claude Code, no extras.**

I love Claude Code. I love what OpenClaw did for autonomous agents. Hermit is my take — a plugin that turns any Claude Code instance into a persistent, self-improving personal assistant you can talk to from your phone.

No custom runtime. No server. No API keys to manage. If you have a Claude Pro, Max, Teams, or Enterprise subscription, you already have everything you need. Each hermit is just a Claude Code process — lightweight enough to run several side by side on a single laptop.

---

## Why Hermit

|                    | Claude Code                          | With Hermit                                                |
| ------------------ | ------------------------------------ | ---------------------------------------------------------- |
| You install it     | A powerful coding tool               | A personal assistant moves into your project               |
| You go to bed      | It stops when you close the terminal | It keeps working                                           |
| You wake up        | Open laptop, start fresh             | Morning brief on your phone: here's what happened          |
| It hits a wall     | You find out next time you check     | It asks you — on your phone. You unblock it from the couch |
| It makes a mistake | You catch it (maybe)                 | It learns, proposes a fix to avoid repeating it            |
| Weeks later        | Still great, still day one           | An assistant that knows your project better than anyone    |

---

## How It Compares

|           | claude-code-hermit                              | Typical agent frameworks                 |
| --------- | ----------------------------------------------- | ---------------------------------------- |
| Runtime   | Claude Code — the CLI you already have          | Custom Python/Node runtime               |
| Cost      | Works with your Pro or Max subscription         | API keys + per-token billing             |
| Install   | One command                                     | Package manager, virtual env, build step |
| State     | Plain markdown in your repo                     | Database, vector store, or API           |
| Learning  | Detects patterns, proposes fixes, verifies them | Start from scratch every run             |
| Extension | Add a `.md` file                                | Write code against an SDK                |
| Footprint | Multiple agents on a single laptop              | Heavy per-instance overhead              |

---

## How It Works

**1. Set it up anywhere.** An existing codebase, a fresh folder for a personal assistant, a new idea you're exploring — anything. Hermit scans what's there, asks a few questions, and generates a personalized rulebook (`OPERATOR.md`) — your priorities, your constraints, your preferences.

**2. Tell it what you need.** Hermit plans the work, tracks progress in a live document, and logs everything. Disconnect? Crash? Reboot? It reads its own state from disk and picks up where it left off.

**3. It learns from experience.** Hermit reflects on its own memory — recurring blockers, repeated workarounds, rising costs. When it notices a pattern, it creates an improvement proposal. You review it. You decide. The assistant adapts.

**4. It develops a rhythm.** Morning brief on what happened overnight. Evening summary that archives the day's work. Between tasks, it picks up accepted proposals and runs maintenance — all gated by how much autonomy you give it.

---

## Quick Start

### 1. Install

```bash
cd /path/to/your/project   # or any folder — even an empty one
claude plugin marketplace add gtapps/claude-code-hermit
claude plugin install claude-code-hermit@claude-code-hermit --scope project
```

### 2. Initialize

```
/claude-code-hermit:hatch
```

The wizard sets up your agent's identity, scans your folder for context, and generates an `OPERATOR.md` — a personalized rulebook Hermit reads at every session start. Starting fresh? It'll ask what the assistant is for. Dropping into an existing codebase? It'll infer what it can and ask about the rest.

### 3. Start your first session

```
/claude-code-hermit:session
```

Tell it what you need. It plans the work, tracks progress, and logs everything. Type "status" anytime. When it finishes, it stays ready — tell it what's next.

### 4. Go always-on (recommended)

```
/claude-code-hermit:docker-setup
```

The wizard scans your project, asks a few questions, and handles everything — generates the Docker files, builds the image, starts the container, and walks you through auth and channel pairing. When it's done, your hermit is running with safe permission bypass, crash recovery, and restart on reboot.

To attach interactively (debug, check in, or run commands):

```bash
.claude-code-hermit/bin/hermit-docker attach
# Ctrl+B, D to detach without stopping
```

See [Always-On Setup](docs/ALWAYS-ON.md) for the full guide — auth, channels, takeover/hand-back, cost management, and troubleshooting.

> **Without Docker?** See [Always-On Operations](docs/ALWAYS-ON-OPS.md) for running with bare tmux — lighter but without container isolation.

### 5. Connect your phone (Recommended)

Install the [Claude Code Channels](https://code.claude.com/docs/en/channels) plugin for your platform:

```bash
claude /plugin install discord@claude-plugins-official   # or telegram, imessage
```

Pair your account by messaging the bot — it walks you through it. Once connected, you control your hermit from your phone: send instructions, check status, get alerts. Combined with [remote control](https://code.claude.com/docs/en/remote-control) (enabled by default), you never need to touch the terminal again.

---

## The Learning Loop

This is what makes Hermit more than a one-shot agent.

Hermit learns from its own memory — not from scanning archived reports. It reflects at natural pauses: when a task finishes, during idle heartbeat ticks, and at end of day. When it notices something recurring — a blocker that keeps coming back, a workaround it's applied twice, spending that seems off — it creates a proposal: a structured recommendation with evidence from what it remembers.

```
/claude-code-hermit:proposal-list                  # see what Hermit found
/claude-code-hermit:proposal-act accept PROP-003   # make it the next thing to work on
```

Accept a proposal, and Hermit picks it up automatically during idle time. If the fix works — the pattern doesn't come back — the proposal auto-resolves. Reject it, defer it, dismiss it. You're always in control.

You can also talk to Hermit about how it can improve. Ask what slowed it down, where it keeps getting blocked, or what new sub-agents would help with your kind of work. It reflects on its experience and suggests concrete changes. You decide what sticks.

---

## What It Does

- **Crash-proof sessions** — SSH drops, terminal crashes, machine reboots. Hermit reads its state from disk and resumes exactly where it left off. Every session produces a complete handoff report — any future session (or any human) can pick up where the last one stopped.

- **Status from anywhere** — Type "status" or "brief" in the terminal or from your phone. Get a compact summary of what's happening, what's done, and what's blocking.

- **Background awareness** — Heartbeat checks run on a schedule, monitoring your project and alerting you only when something needs attention. Silence means everything is fine.

- **Self-improving** — Reflects on its own experience, proposes fixes for recurring problems, and verifies they worked. The more you use it, the smoother it runs.

- **Daily rhythm** — Morning brief on what happened overnight and what's on deck. Evening summary that archives the day's work. Automatic — you don't need to ask.

- **Idle agency** — Between tasks, Hermit doesn't just sit there. It picks up accepted proposals, runs reflection, and handles maintenance from its checklist — all gated by your escalation setting.

- **Self-aware** — If it's stuck — failing repeatedly, reverting its own work, burning through budget — it stops, says what's happening, and asks for help instead of pushing through silently.

- **Your rules, its judgment** — `OPERATOR.md` is your rulebook. Budget limits, off-limits directories, naming conventions, communication style. Set it once. Hermit reads it every session and respects it without you having to repeat yourself.

- **Operator takeover** — Stop the autonomous agent, take the wheel with full context, leave instructions, hand it back. `/hermit-takeover` and `/hermit-hand-back`.

- **Walk-away autonomy** — Boot it in Docker, connect a channel, and manage everything from your phone. Let it work overnight. Wake up to a morning brief of what happened while you slept.

---

## Creating Your Own Hermit

Every Hermit is yours from the moment you run `/claude-code-hermit:hatch`. Drop it into an existing codebase — it becomes your project's assistant. Create a fresh folder for personal finance, research, or writing — it becomes that kind of assistant. The wizard adapts to whatever it finds.

Over time, Hermit learns what your work actually needs. Ask it to suggest specialized agents based on your recent sessions — it'll propose them, you approve, and it creates them for you. A project with lots of database work might get a migration specialist. A project that keeps hitting CI failures might get a test-focused reviewer. You don't have to design these upfront — they emerge from how you actually work.

For ready-made specialists, install a hermit plugin like the dev hermit:

```bash
claude plugin marketplace add gtapps/claude-code-dev-hermit
claude plugin install claude-code-dev-hermit@claude-code-dev-hermit --scope project
```

See [Creating Your Own Hermit](docs/CREATING-YOUR-OWN-HERMIT.md) for more — from tweaking `OPERATOR.md` to building reusable [plugins](https://code.claude.com/docs/en/plugins) you can share.

---

## Documentation

| Document                                                     | Read this when...                                                          |
| ------------------------------------------------------------ | -------------------------------------------------------------------------- |
| [Getting Started](docs/HOW-TO-USE.md)                        | You're new and want a walkthrough of install, first session, and daily use |
| [Skills Reference](docs/SKILLS.md)                           | You need the exact syntax or options for a specific skill                  |
| [Always-On Setup](docs/ALWAYS-ON.md)                         | You're ready to run Hermit in Docker with crash recovery                   |
| [Always-On Operations](docs/ALWAYS-ON-OPS.md)                | You're running bare tmux (no Docker) or need the lifecycle reference       |
| [Architecture](docs/ARCHITECTURE.md)                         | You want to understand the internals — layers, memory, learning loop       |
| [Creating Your Own Hermit](docs/CREATING-YOUR-OWN-HERMIT.md) | You want to customize OPERATOR.md, add agents, or build a reusable plugin  |
| [Upgrading](docs/UPGRADING.md)                               | A new version is out and you need to update safely                         |
| [Security](docs/SECURITY.md)                                 | You need deny patterns, defense-in-depth model, or the security checklist  |
| [Recommended Plugins](docs/RECOMMENDED-PLUGINS.md)           | You want to add official or third-party plugins to your Docker setup       |
| [Config Reference](docs/CONFIG-REFERENCE.md)                 | You need the full config.json schema with every key and default            |
| [Troubleshooting](docs/TROUBLESHOOTING.md)                   | Something isn't working and you need to fix it                             |
| [FAQ](docs/FAQ.md)                                           | Common questions — Windows, costs, multi-project, API keys                 |
| [Testing](docs/TESTING.md)                                   | You're contributing and need to run or write hook tests                    |
| [Obsidian Dashboard](docs/OBSIDIAN-SETUP.md)                 | You want a visual dashboard for sessions and proposals                     |

---

## Credits

- **[Everything Claude Code](https://github.com/affaan-m/everything-claude-code)** — Hook patterns and lifecycle architecture

## License

[MIT](LICENSE)
