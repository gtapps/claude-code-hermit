<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License" /></a>
  <a href="https://code.claude.com/docs/en/plugins"><img src="https://img.shields.io/badge/Claude%20Code-plugin-orange.svg" alt="Claude Code Plugin" /></a>
  <a href="CHANGELOG.md"><img src="https://img.shields.io/badge/version-0.0.2-green.svg" alt="Version 0.0.2" /></a>
  <img src="https://img.shields.io/badge/Claude-Pro%20%7C%20Max-blueviolet.svg" alt="Claude Pro/Max Compatible" />
  <img src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg" alt="PRs Welcome" />
</p>

# claude-code-hermit

**A personal assistant that lives in your project and gets smarter every session — pure Claude Code, no extras.**

I love Claude Code. I love what [OpenClaw](https://github.com/anthropics/claude-code/tree/main/.github/openclaw) did for autonomous agents. Hermit is my take on the Claude Code autonomous agent — a plugin that turns any Claude Code instance into an autonomous, always-on personal assistant you can talk to from your phone.

No custom runtime. No server. No API keys to manage. If you have a Claude Pro, Max, Teams, or Enterprise subscription, you already have everything you need. Each hermit is just a Claude Code process — lightweight enough to run several side by side on a single laptop.

---

## It's All Claude Code

Hermit isn't a framework that replaces Claude Code — it's a layer of structure on top of everything Claude Code already gives you. Persistent [agent memory](https://code.claude.com/docs/en/sub-agents) that learns across sessions. [Subagents](https://code.claude.com/docs/en/sub-agents) with isolated context. [Hooks](https://code.claude.com/docs/en/hooks) that fire at every lifecycle point. [Skills](https://code.claude.com/docs/en/skills) as reusable workflows. [Channels](https://code.claude.com/docs/en/channels) for phone control. [Remote access](https://code.claude.com/docs/en/remote-control) from any browser. [`/loop`](https://code.claude.com/docs/en/sub-agents) for background tasks.

Hermit adds session discipline, self-learning, and operational hygiene — so all of that becomes a personal assistant that remembers what happened, learns from its mistakes, and keeps getting better at _your_ work.

---

## How It Works

**1. Set it up anywhere.** An existing codebase, a fresh folder for a personal assistant, a new idea you're exploring — anything. Hermit scans what's there, asks a few questions, and generates a personalized rulebook (`OPERATOR.md`) — your constraints, your preferences, your goals.

**2. You give it a task.** Hermit plans the work, tracks progress in a live document, and logs everything. Disconnect? Crash? Reboot? It reads its own state from disk and picks up where it left off.

**3. It starts learning.** After a few sessions, Hermit analyzes its own history — recurring blockers, repeated workarounds, rising costs. It creates improvement proposals automatically. You review them. You decide. The assistant adapts.

**4. It keeps getting better.** Accept a proposal, and it becomes the next session's task. If the fix works — no recurrence in 3 sessions — the proposal auto-resolves. The more you use Hermit, the sharper it gets at _your_ work.

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
/claude-code-hermit:init
```

The wizard sets up your agent's identity, scans your folder for context, and generates an `OPERATOR.md` — a personalized rulebook Hermit reads at every session start. Starting fresh? It'll ask what the assistant is for. Dropping into an existing codebase? It'll infer what it can and ask about the rest.

### 3. Start your first session

```
/claude-code-hermit:session
```

Give it a task. It plans the work, tracks progress, and logs everything. Type "status" anytime. Close with `/claude-code-hermit:session-close` — a full report is archived automatically.

### 4. Connect your phone (optional)

Install the [Claude Code Channels](https://code.claude.com/docs/en/channels) plugin for your platform:

```bash
claude /plugin install discord@claude-plugins-official   # or telegram, imessage
```

Pair your account by messaging the bot — it walks you through it. Once connected, you control your hermit from your phone: send tasks, check status, get alerts. Combined with [remote control](https://code.claude.com/docs/en/remote-control) (enabled by default), you never need to touch the terminal again.

### 5. Go always-on (optional)

```bash
.claude/.claude-code-hermit/bin/hermit-start    # launch in tmux with channels + heartbeat
.claude/.claude-code-hermit/bin/hermit-stop     # graceful shutdown
```

See [Always-On Operations](docs/ALWAYS-ON-OPS.md) for the full guide — cost management, Docker isolation, security, auto-restart on reboot.

---

## The Learning Loop

This is what takes Hermit from a one-shot agent to a self-learning personal assistant.

Every session produces an archived report — what was done, what failed, what's next. After your third session, Hermit starts analyzing its own history:

| What it detects          | Example                                                  |
| ------------------------ | -------------------------------------------------------- |
| **Recurring blockers**   | "Test environment down" keeps appearing across sessions  |
| **Repeated workarounds** | "Manually restarted the service" — applied twice already |
| **Cost spikes**          | Last 3 sessions cost 50%+ more than the prior 3          |
| **Correlated failures**  | Everything tagged `frontend` closes as blocked           |

When Hermit spots a pattern, it creates an **auto-proposal** — a structured recommendation backed by evidence from the sessions that triggered it.

```
/claude-code-hermit:proposal-list                  # see what Hermit found
/claude-code-hermit:proposal-act accept PROP-003   # make it the next task
```

Accept a proposal, and Hermit picks it up in the next session. If the fix works — the pattern doesn't recur in 3 sessions — the proposal auto-resolves. Reject it, defer it, dismiss it. **You're always in control.**

And it's not just automatic — you can talk to Hermit about how it can improve. Ask it what slowed it down, where it could be more efficient, or what new sub-agents would help. It'll review its recent sessions and suggest concrete changes. You decide what sticks.

---

## What It Does

- **Crash-proof sessions** — SSH drops, terminal crashes, machine reboots. Hermit reads its state from disk and resumes exactly where it left off. Every session produces a complete handoff report — any session (or any human) can pick up where the last one stopped.

- **Status from anywhere** — Type "status" or "brief" in the terminal or from your phone. Get a compact summary of what's happening, what's done, and what's blocking. Great over morning coffee.

- **Background awareness** — Heartbeat checks run on a schedule, monitoring your project and alerting you only when something needs attention. Task-specific monitors watch for conditions during active work. Silence means everything is fine.

- **Self-improving** — Pattern detection, auto-proposals, and a feedback loop that closes itself. Ask Hermit what it struggled with — it'll tell you, with evidence. Ask what permissions it keeps getting blocked on — it'll suggest the exact `settings.json` entries to add. The more you use it, the smoother it runs.

- **Your rules, its judgment** — `OPERATOR.md` is your rulebook. Budget limits, off-limits directories, naming conventions, communication style. Set it once. Hermit reads it every session and respects it without you having to repeat yourself.

- **Walk-away autonomy** — Boot it in tmux, connect a channel, and manage everything from your phone. Let it work overnight. Wake up to a morning brief of what happened while you slept.

---

## Creating Your Own Hermit

Every Hermit is yours from the moment you run `/claude-code-hermit:init`. Drop it into an existing codebase — it becomes your project's assistant. Create a fresh folder for personal finance, research, or writing — it becomes that kind of assistant. The wizard adapts to whatever it finds.

Over time, Hermit learns what your work actually needs. Ask it to suggest specialized agents based on your recent sessions — it'll propose them, you approve, and it creates them for you. A project with lots of database work might get a migration specialist. A project that keeps hitting CI failures might get a test-focused reviewer. You don't have to design these upfront — they emerge from how you actually work.

For ready-made specialists, install a hermit plugin like the dev hermit:

```bash
claude plugin marketplace add gtapps/claude-code-dev-hermit
claude plugin install claude-code-dev-hermit@claude-code-dev-hermit --scope project
```

See [Creating Your Own Hermit](docs/CREATING-YOUR-OWN-HERMIT.md) for more — from tweaking `OPERATOR.md` to building reusable [plugins](https://code.claude.com/docs/en/plugins) you can share.

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

## Documentation

| Document                                                     | What it covers                                                    |
| ------------------------------------------------------------ | ----------------------------------------------------------------- |
| [Getting Started](docs/HOW-TO-USE.md)                        | Install → first session → common workflows                        |
| [Skills Reference](docs/SKILLS.md)                           | All 15 skills with usage, auto-triggers, and examples             |
| [Always-On Operations](docs/ALWAYS-ON-OPS.md)                | Persistent sessions, channels, cost management, Docker, security  |
| [Architecture](docs/ARCHITECTURE.md)                         | 5-layer design, memory model, learning loop internals             |
| [Creating Your Own Hermit](docs/CREATING-YOUR-OWN-HERMIT.md) | Customization — OPERATOR.md, specialized agents, reusable plugins |
| [Upgrading](docs/UPGRADING.md)                               | Upgrade guide for plugin updates                                  |
| [Troubleshooting](docs/TROUBLESHOOTING.md)                   | Common issues and fixes                                           |
| [Obsidian Dashboard](docs/OBSIDIAN-SETUP.md)                 | Optional visual companion dashboard                               |

---

## Credits

- **[OpenClaw](https://github.com/anthropics/claude-code/tree/main/.github/openclaw)** — The autonomous agent structure that inspired this
- **[Everything Claude Code](https://github.com/affaan-m/everything-claude-code)** — Hook patterns and lifecycle architecture

## License

[MIT](LICENSE)
