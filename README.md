<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License" /></a>
  <a href="https://code.claude.com/docs/en/plugins"><img src="https://img.shields.io/badge/Claude%20Code-plugin-orange.svg" alt="Claude Code Plugin" /></a>
  <a href="CHANGELOG.md"><img src="https://img.shields.io/badge/version-1.0.17-green.svg" alt="Version 1.0.17" /></a>
  <img src="https://img.shields.io/badge/Claude-Pro%20%7C%20Max-blueviolet.svg" alt="Claude Pro/Max Compatible" />
  <img src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg" alt="PRs Welcome" />
  <a href="docs/obsidian-setup.md"><img src="https://img.shields.io/badge/obsidian-active-7c3aed.svg" alt="Obsidian Integration" /></a>
</p>

# claude-code-hermit

Turn Claude Code into an Always-on Personal AI assistant that lives in your project.

<p align="center">
  <img src="assets/demo.gif" alt="claude-code-hermit demo — Obsidian dashboard, Discord control, autonomous briefings, remote access" width="720" />
</p>

Three steps to a running 24/7 hermit:

```
# Boot claude code and install
/plugin marketplace add gtapps/claude-code-hermit
/plugin install claude-code-hermit@claude-code-hermit --scope project

# Setup Wizard
/claude-code-hermit:hatch

# Go always-on
/claude-code-hermit:docker-setup
```

Hermit is the glue between Claude Code's native capabilities and a 24/7 agent that improves itself. One subscription to run multiple hermits.

---

## How It Works

**1. Set it up anywhere.** Existing codebase, empty folder, new idea — Hermit scans what's there and generates a personal rulebook (`OPERATOR.md`) with your priorities, budget, and constraints.

**2. Give it a task and walk away.** Tell it what you need from your terminal, phone, or anywhere. It plans, works, and pings when blocked or done. Crashes, reboots, SSH drops — state is on disk, sessions resume where they stopped.

**3. It learns from experience.** Hermit spots patterns in its own memory — recurring blockers, repeated workarounds, odd spending — and proposes fixes. You decide what sticks. Under the hood, raw session notes distill into compiled artifacts that reload next session — the [raw-vs-compiled pattern](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) Karpathy described for his wiki-LLM.

**4. Routines and daily rhythm.** Morning briefs, evening summaries, background monitors. Between tasks it picks up accepted proposals and runs maintenance. Silence means everything's fine.

**5. See inside it.** Hermit Cortex (Obsidian-powered) turns your agent's memory — sessions, proposals, cost trends, learnings — into an Obsidian vault you can browse.

---

## Quick Start

> **Prerequisites:** [Claude Code](https://code.claude.com) v2.1.98+, a Claude plan (Pro, Max, Teams, or Enterprise), and Node.js 22+. Linux, macOS, and Windows via WSL2 — see [FAQ](docs/faq.md).

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

The wizard sets up your agent's identity, scans your folder, and generates `OPERATOR.md` — the rulebook Hermit reads at every session start.

> **Just want to try it?** After `hatch`, run `.claude-code-hermit/bin/hermit-start --no-tmux` in your terminal. You get sessions, routines, heartbeat, and the learning loop — minus the 24/7 autonomy. Ctrl+C exits cleanly. Want Discord or Telegram before going always-on? Run `/claude-code-hermit:channel-setup`. When you're ready for the full 24/7 setup, continue to step 3.

### 3. Go Always-on

```
/claude-code-hermit:docker-setup
```

The wizard generates the Docker files, builds the image, starts the container, and walks you through auth and channel pairing. When it's done, your hermit is running with safe permission bypass, crash recovery, and restart on reboot.

See [Always-On Setup](docs/always-on.md) for the full guide — including how to attach, detach, and manage the running container.

> **Want always-on without Docker?** See [Always-On Operations](docs/always-on-ops.md) for bare tmux — lighter, no container isolation.

### Upgrading

```
claude plugin update claude-code-hermit@claude-code-hermit --scope project
/claude-code-hermit:hermit-evolve
```

See [Upgrading](docs/upgrading.md) for details.

---

## The Learning Loop

What makes Hermit more than a one-shot agent.

Hermit reflects at natural pauses — end of task, idle ticks, end of day. Drawing on Claude Code's native memory plus its own session journals, it spots recurring patterns (a blocker, a workaround, odd spending) and writes a proposal: a structured recommendation backed by evidence.

```
/claude-code-hermit:proposal-list                  # see what Hermit found
/claude-code-hermit:proposal-act accept PROP-003   # make it the next thing to work on
```

Accept one and Hermit picks it up during idle time. If the fix works, the proposal auto-resolves. Reject, defer, dismiss — you're always in control.

You can also ask Hermit directly how it could improve. It reflects on recent sessions and suggests concrete changes. You decide what sticks.

---

## Creating Your Own Hermit

Every hermit is yours from the moment you run `/claude-code-hermit:hatch`. See [Creating Your Own Hermit](docs/creating-your-own-hermit.md) for OPERATOR.md tuning, custom agents, and building reusable hermit plugins.

Hermits ride on Claude Code's native intelligence and add a `raw/` → `compiled/` layer — raw notes distilled into durable artifacts the agent reloads next session. See [Plugin Hermit Storage](docs/plugin-hermit-storage.md).

For ready-made specialists, install a hermit plugin like the dev hermit:

```bash
/plugin marketplace add gtapps/claude-code-dev-hermit
/plugin install claude-code-dev-hermit@claude-code-dev-hermit --scope project
```

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
| [Artifact Naming](docs/artifact-naming.md)                    | You're adding a new artifact or domain and need the naming convention      |

---

## Credits

- **[OpenClaw](https://github.com/openclaw/openclaw)** — Inspiration for autonomous agent ergonomics
- **[Everything Claude Code](https://github.com/affaan-m/everything-claude-code)** — Hook patterns and lifecycle architecture
- **[Andrej Karpathy](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)** — Inspiration for the raw/compiled knowledge system

## License

[MIT](LICENSE)
