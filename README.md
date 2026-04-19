



<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License" /></a>
  <a href="https://code.claude.com/docs/en/plugins"><img src="https://img.shields.io/badge/Claude%20Code-plugin-orange.svg" alt="Claude Code Plugin" /></a>
  <a href="CHANGELOG.md"><img src="https://img.shields.io/badge/version-1.0.10-green.svg" alt="Version 1.0.10" /></a>
  <img src="https://img.shields.io/badge/Claude-Pro%20%7C%20Max-blueviolet.svg" alt="Claude Pro/Max Compatible" />
  <img src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg" alt="PRs Welcome" />
  <a href="docs/obsidian-setup.md"><img src="https://img.shields.io/badge/obsidian-active-7c3aed.svg" alt="Obsidian Integration" /></a>
</p>

# claude-code-hermit

Turn Claude Code into a Always-on Personal AI assistant that lives in your project
<p align="center">
  <img src="assets/demo.gif" alt="claude-code-hermit demo — Obsidian dashboard, Discord control, autonomous briefings, remote access" width="720" />
</p>

Three commands to a running hermit:
> ```
> claude plugin install claude-code-hermit@claude-code-hermit --scope project
> /claude-code-hermit:hatch # setup in your project & folder
> /claude-code-hermit:docker-setup # go always-on
> ```

Hermit is the glue between Claude Code's native capabilities and a 24/7 agent that improves itself. One subscription to run multiple hermits.

---

## How It Works

**1. Set it up anywhere.** An existing codebase, a fresh folder for a personal assistant, a new idea — anything. Hermit scans what's there, asks a few questions, and generates a personalized rulebook (`OPERATOR.md`) with your priorities and constraints.

**2. Give it a task and walk away.** From your terminal, your phone, or remote — tell your hermit what you need. It plans, works, logs, and pings you when it's blocked or done. Close your laptop. Reboot your machine. Come back tomorrow. It's still there.

**3. It learns from experience.** Hermit reflects on its own memory — recurring blockers, repeated workarounds, token usage. When it spots a pattern, it creates a proposal. You review, you decide, it adapts.

**4. Routines.** Morning briefs, evening summaries, background monitors. Between tasks it picks up accepted proposals and runs maintenance — all gated by how much autonomy you give it.

**5. You can see inside it.** Obsidian Powered - browse sessions, proposals, cost trends, and learning.— Hermit Cortex turns your hermit's memory into a navigable brain you can view in Obsidian.

---

## Quick Start

> **Prerequisites:** [Claude Code](https://code.claude.com) v2.1.98+, a Claude plan (Pro, Max, Teams, or Enterprise), and Node.js 22+.

> **Platform support:** Linux, macOS, and Windows via WSL2. See [FAQ](docs/faq.md) for details.

### 1. Install

```bash
cd /path/to/your/project   # or any folder — even an empty one
claude plugin marketplace add gtapps/claude-code-hermit
claude plugin install claude-code-hermit@claude-code-hermit --scope project
```

### 2. Initialize

```
claude /claude-code-hermit:hatch
```

The wizard sets up your agent's identity, scans your folder for context, and generates an `OPERATOR.md` — a personalized rulebook Hermit reads at every session start. Starting fresh? It'll ask what the assistant is for. Dropping into an existing codebase? It'll infer what it can and ask about the rest.

### 3. Go Always-on

```
/claude-code-hermit:docker-setup
```

The wizard scans your project, asks a few questions, and handles everything — generates the Docker files, builds the image, starts the container, and walks you through auth and channel pairing. When it's done, your hermit is running with safe permission bypass, crash recovery, and restart on reboot.

To attach interactively (debug, check in, or run commands):

```bash
.claude-code-hermit/bin/hermit-docker attach
# Ctrl+B, D to detach without stopping
```

For more, check out [Always-On Setup](docs/always-on.md).

> **Don't want to use Docker?** See [Always-On Operations](docs/always-on-ops.md) for running with bare tmux — lighter but without container isolation.

---

## The Learning Loop

This is what makes Hermit more than a one-shot agent.

Hermit learns from its own memory. It reflects at natural pauses: when a task finishes, during idle heartbeat ticks, and at end of day. When it notices something recurring — a blocker that keeps coming back, a workaround it's applied twice, spending that seems off — it creates a proposal: a structured recommendation with evidence from what it remembers.

```
/claude-code-hermit:proposal-list                  # see what Hermit found
/claude-code-hermit:proposal-act accept PROP-003   # make it the next thing to work on
```

Accept a proposal, and Hermit picks it up automatically during idle time. If the fix works — the pattern doesn't come back — the proposal auto-resolves. Reject it, defer it, dismiss it. You're always in control.

You can also talk to Hermit about how it can improve. Ask what slowed it down, where it keeps getting blocked, or what new sub-agents would help with your kind of work. It reflects on its experience and suggests concrete changes. You decide what sticks.

---

## What It Does

- **Crash-proof sessions** — SSH drops, terminal crashes, machine reboots. Hermit reads its state from disk and resumes exactly where it left off. Every session produces a complete handoff report — any future session (or any human) can pick up where the last one stopped.

- **Status from anywhere** — Type "pulse" or "brief" in the terminal or from your phone. Get a compact summary of what's happening, what's done, and what's blocking.

- **Background awareness** — Heartbeat checks run on a schedule, monitoring your project and alerting you only when something needs attention. Silence means everything is fine.

- **Self-improving** — Reflects on its own experience, proposes fixes, verifies they worked. The more you use it, the smoother it runs.

- **Daily rhythm** — Morning brief on what happened overnight and what's on deck. Evening summary that archives the day's work. Automatic — you don't need to ask.

- **Idle agency** — Between tasks, Hermit picks up accepted proposals, runs reflection, handles maintenance from its checklist.

- **Your rules, its judgment** — OPERATOR.md` is your rulebook. Budget limits, off-limits directories, communication style. Set it once.

---

## Creating Your Own Hermit

Every hermit is yours from the moment you run `/claude-code-hermit:hatch`. Drop it into an existing codebase — it becomes your project's assistant. Create a fresh folder for personal finance, research, or writing — it becomes that kind of assistant. The wizard adapts to whatever it finds.

Over time, Hermit learns what your work actually needs. Ask it to suggest specialized agents based on your recent sessions — it'll propose them, you approve, and it creates them for you. You don't design these upfront — they emerge from how you actually work.

For ready-made specialists, install a hermit plugin like the dev hermit:

```bash
claude plugin marketplace add gtapps/claude-code-dev-hermit
claude plugin install claude-code-dev-hermit@claude-code-dev-hermit --scope project
```

See [Creating Your Own Hermit](docs/creating-your-own-hermit.md) for more.

---

## Documentation

| Document                                                      | Read this when...                                                          |
| ------------------------------------------------------------- | -------------------------------------------------------------------------- |
| [Getting Started](docs/how-to-use.md)                         | You're new and want a walkthrough of install, first session, and daily use |
| [Skills Reference](docs/skills.md)                            | You need the exact syntax or options for a specific skill                  |
| [Always-On Setup](docs/always-on.md)                          | You're ready to run Hermit in Docker with crash recovery                   |
| [Always-On Operations](docs/always-on-ops.md)                 | You're running bare tmux (no Docker) or need the lifecycle reference       |
| [Architecture](docs/architecture.md)                          | You want to understand the internals — layers, memory, learning loop       |
| [Creating Your Own Hermit](docs/creating-your-own-hermit.md)  | You want to customize OPERATOR.md, add agents, or build a reusable plugin  |
| [Upgrading](docs/upgrading.md)                                | A new version is out and you need to update safely                         |
| [Security](docs/security.md)                                  | You need deny patterns, defense-in-depth model, or the security checklist  |
| [Recommended Plugins](docs/recommended-plugins.md)            | You want to add official or third-party plugins to your Docker setup       |
| [Config Reference](docs/config-reference.md)                  | You need the full config.json schema with every key and default            |
| [Troubleshooting](docs/troubleshooting.md)                    | Something isn't working and you need to fix it                             |
| [FAQ](docs/faq.md)                                            | Common questions — Windows, costs, multi-project, API keys                 |
| [Testing](docs/testing.md)                                    | You're contributing and need to run or write hook tests                    |
| [Hermit Cortex (Powered by Obsidian)](docs/obsidian-setup.md) | You want to see inside your hermit's brain                                 |
| [Plugin Hermit Storage](docs/plugin-hermit-storage.md)        | You're building a hermit plugin and need the raw/compiled storage rules    |

---

## Credits

- **[OpenClaw](https://github.com/openclaw/openclaw)** — Inspiration for autonomous agent ergonomics
- **[Everything Claude Code](https://github.com/affaan-m/everything-claude-code)** — Hook patterns and lifecycle architecture
- **[Andrej Karpathy](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)** — Inspiration for the raw/compiled knowledge system

## License

[MIT](LICENSE)
