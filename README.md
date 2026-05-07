<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License" /></a>
  <a href="https://code.claude.com/docs/en/plugins"><img src="https://img.shields.io/badge/Claude%20Code-plugin-orange.svg" alt="Claude Code Plugin" /></a>
  <a href="plugins/claude-code-hermit/CHANGELOG.md"><img src="https://img.shields.io/badge/version-1.0.32-green.svg" alt="Version 1.0.32" /></a>
  <img src="https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/gtapps/claude-code-hermit/_gh_traffic_stats/.github/badges/clones.json" alt="Downloads" />
  <img src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg" alt="PRs Welcome" />
  <a href="plugins/claude-code-hermit/docs/obsidian-setup.md"><img src="https://img.shields.io/badge/obsidian-active-7c3aed.svg" alt="Obsidian Integration" /></a>
</p>

# claude-code-hermit

Turn Claude Code into an Always-on Personal AI assistant that lives in your project.

<p align="center">
  <img src="plugins/claude-code-hermit/assets/demo.gif" alt="claude-code-hermit demo — Obsidian dashboard, Discord control, autonomous briefings, remote access" width="720" />
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

**4. Routines and daily rhythm.** Morning briefs, evening summaries, background monitors, **custom routines**. Between tasks it picks up accepted proposals and runs maintenance. Silence means everything's fine.

**5. See inside it.** Hermit Cortex (Obsidian-powered) turns your agent's memory — sessions, proposals, cost trends, learnings — into an Obsidian vault you can browse.

**6. Safe to leave running.**  Docker isolation, deny-pattern hooks that block destructive commands, optional kernel-level hardening via `/docker-security`. See [Security](plugins/claude-code-hermit/docs/security.md) for more.

---

## Quick Start

> **Prerequisites:** [Claude Code](https://code.claude.com) v2.1.110+, a Claude plan (Pro, Max, Teams, or Enterprise), and Node.js 22+. Linux, macOS, and Windows via WSL2 — see [FAQ](plugins/claude-code-hermit/docs/faq.md).

### 1. Install

```bash
cd /path/to/your/project   # or any folder — even an empty one
claude plugin marketplace add gtapps/claude-code-hermit
claude plugin install claude-code-hermit@claude-code-hermit --scope project
```

> See the [Pre-built Hermits](#pre-built-hermits) below for existing plug-and-play domain hermits.

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

See [Always-On Setup](plugins/claude-code-hermit/docs/always-on.md) for the full guide — including how to attach, detach, and manage the running container.

> **Want always-on without Docker?** See [Always-On Operations](plugins/claude-code-hermit/docs/always-on-ops.md) for bare tmux — lighter, no container isolation.

### Upgrading

```
claude plugin update claude-code-hermit@claude-code-hermit --scope project
/claude-code-hermit:hermit-evolve
```

See [Upgrading](plugins/claude-code-hermit/docs/upgrading.md) for details.

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

Every hermit is yours from the moment you run `/claude-code-hermit:hatch`. See [Creating Your Own Hermit](plugins/claude-code-hermit/docs/creating-your-own-hermit.md) for OPERATOR.md tuning, custom agents, and building reusable hermit plugins.

Hermits ride on Claude Code's native intelligence and add a `raw/` → `compiled/` layer — raw notes distilled into durable artifacts the agent reloads next session. See [Plugin Hermit Storage](plugins/claude-code-hermit/docs/plugin-hermit-storage.md).

For ready-made specialists, install another hermit plugin from the same marketplace — see [Pre-built Hermits](#pre-built-hermits) below.

---

## Pre-built Hermits

- [**`dev-hermit`**](plugins/claude-code-dev-hermit/README.md) — *For software builders.* Safety layer for code-writing agents: push guard, branch discipline, gated PRs.
- [**`homeassistant-hermit`**](plugins/claude-code-homeassistant-hermit/README.md) — *For Home Assistant users.* HA skills, safety hook, automation builder, Python CLI.
- [**`fitness-hermit`**](plugins/claude-code-fitness-hermit/README.md) — *Fitness focused.* Strava MCP wiring, activity deep-dives, weekly-load routines.

---

## Documentation

- [Always-On Operations](plugins/claude-code-hermit/docs/always-on-ops.md)
- [Always-On Setup](plugins/claude-code-hermit/docs/always-on.md)
- [Architecture](plugins/claude-code-hermit/docs/architecture.md)
- [Artifact Naming](plugins/claude-code-hermit/docs/artifact-naming.md)
- [Config Reference](plugins/claude-code-hermit/docs/config-reference.md)
- [Creating Your Own Hermit](plugins/claude-code-hermit/docs/creating-your-own-hermit.md)
- [FAQ](plugins/claude-code-hermit/docs/faq.md)
- [Getting Started](plugins/claude-code-hermit/docs/how-to-use.md)
- [Hermit Cortex (Powered by Obsidian)](plugins/claude-code-hermit/docs/obsidian-setup.md)
- [Plugin Hermit Storage](plugins/claude-code-hermit/docs/plugin-hermit-storage.md)
- [Recommended Plugins](plugins/claude-code-hermit/docs/recommended-plugins.md)
- [Security](plugins/claude-code-hermit/docs/security.md)
- [Skills Reference](plugins/claude-code-hermit/docs/skills.md)
- [Testing](plugins/claude-code-hermit/docs/testing.md)
- [Troubleshooting](plugins/claude-code-hermit/docs/troubleshooting.md)
- [Upgrading](plugins/claude-code-hermit/docs/upgrading.md)

---

## Credits

- **[OpenClaw](https://github.com/openclaw/openclaw)** — Inspiration for autonomous agent ergonomics
- **[Everything Claude Code](https://github.com/affaan-m/everything-claude-code)** — Hook patterns and lifecycle architecture
- **[Andrej Karpathy](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)** — Inspiration for the raw/compiled knowledge system

## License

[MIT](LICENSE)
