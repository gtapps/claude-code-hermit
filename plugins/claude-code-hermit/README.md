<p align="center">
  <a href="../../LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License" /></a>
  <a href="https://code.claude.com/docs/en/plugins"><img src="https://img.shields.io/badge/Claude%20Code-plugin-orange.svg" alt="Claude Code Plugin" /></a>
  <a href="CHANGELOG.md"><img src="https://img.shields.io/badge/version-1.1.9-green.svg" alt="Version 1.1.9" /></a>
  <img src="https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/gtapps/claude-code-hermit/_gh_traffic_stats/.github/badges/clones.json" alt="Downloads" />
  <img src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg" alt="PRs Welcome" />
</p>

# claude-code-hermit

Claude Code plugin that turns it into a 24/7 personal AI assistant. **Self-learning**, **Local**, **Cost-aware**, **Observable**, **One Claude subscription, multiple hermits**.

<p align="center">
  <img src="assets/cover.png" alt="Always-on Claude Code Agent" width="720" />
</p>

Hermit wires all the native Claude Code capabilities (`/loop`, `CronCreate`, channels, Monitor, auto-memory, native Tasks) to turn CC into a self-learning personal assistant.

```
# Install
claude plugin marketplace add gtapps/claude-code-hermit
claude plugin install claude-code-hermit@claude-code-hermit --scope local

# Boot Claude Code and run the setup wizard
/claude-code-hermit:hatch

# Go always-on
/claude-code-hermit:docker-setup
```

**One Claude subscription, multiple hermits** — each with its own memory, budget, and routines.

---

## What you get

A hermit drops into any folder, runs around the clock, and is yours to shape. It's markdown and Node on top of Claude Code's own primitives, no proprietary runtime and no server, and everything it adds lives in `config.json` and `OPERATOR.md`:

- **`/loop`** re-runs a prompt on an interval; hermit turns it into a token-cheap **heartbeat** (`/heartbeat`) that sweeps a checklist you write. A Node precheck decides whether anything's worth waking the model, so a quiet heartbeat costs nothing, and alerts dedupe so a recurring one nags a few times then drops to a daily digest.
- **`CronCreate`** gives idle-gated cron jobs; hermit registers your **routines** from `config.json`. Reflection, scheduled checks, a weekly review, and midnight auto-close ship enabled; add a morning brief, an evening summary, or your own. Idle-gated, timezone-correct (your wall clock, not the server's), and self-rearming so they never expire.
- **Monitor** streams background events at zero token cost; hermit's **`/watch`** points persistent stream or poll monitors at anything (a log, a file tree, a CI run, an endpoint), declared in `config.json` or started on the fly in plain language. Silence costs nothing, so leave a dozen running.
- **Remote control and channels** let you drive a live session from the official Claude app or claude.ai/code (handy for juggling several hermits with full context) or your phone, and optionally DM a hermit on Discord or Telegram; it's an authenticated, session-aware control plane on a durable session that survives sleep and network drops.
- **Auto-memory** persists lessons; hermit layers a `raw/` to `compiled/` knowledge store with retention and budgeted re-injection into context at session start.
- **Native Tasks** track a plan in-session; hermit projects them into `tasks-snapshot.md` and carries them across session archives.
- **Deny patterns** and the **bash sandbox** fail closed; hermit makes the denylist profile-gated (the unattended agent is locked down harder than the supervised one) and `/hatch` auto-configures the sandbox and probes whether your host supports it.

**Sessions self-manage.** Long-running daemons auto-archive at 12h idle and at midnight when you're away, so evidence reaches reflect and the weekly review without a manual close.

**It reaches you first.** A hermit doesn't wait to be asked. It pings you the moment a watch or the heartbeat finds something, sends your morning brief, and surfaces decisions that need a yes/no. Delivery defaults to a native push notification (ideal for a headless dev hermit), or a Discord/Telegram DM if you've paired a channel, where you can reply to steer it. Toggle with `push_notifications`.

**Cost scales with events, not time.** An idle always-on hermit is effectively free, because nothing wakes the model until something actually happens. You pay for findings, not for waiting.

---

## The Learning Loop

Hermit reflects at natural pauses: end of session, idle ticks, scheduled-check cadence. Most reflections never hit the LLM: a precheck script gates whether any of five phases (compute, resolution check, cost spike, digest, newborn) are actually due. When something is, hermit drafts a candidate.

Two subagents gate quality before anything reaches your inbox:
- **`reflection-judge`** verifies that cited cross-session evidence actually exists in the report files.
- **`proposal-triage`** deduplicates against existing proposals, cross-checks `MEMORY.md`, and applies the three-condition rule.

Survivors land as a proposal you can act on:

```
/claude-code-hermit:proposal-list                  # see what hermit found
/claude-code-hermit:proposal-act accept PROP-003   # approve
```

What gets proposed: improvements, routines, new capabilities (skills, agents, heartbeat checks), constraints (OPERATOR.md guidance you confirm), and bugs.

Voyager-style auto-curriculum, you're editor-in-chief. Under the hood, raw session journals distill into compiled artifacts that reload next session — the [raw-vs-compiled pattern](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) Karpathy described for his wiki-LLM.

---

## Observable

Three on-demand skills give you a live read on how your hermit is doing:

- **`/hermit-brain`** — open loops, fragile zones, and key learnings surfaced from recent sessions
- **`/hermit-evolution`** — cost trends and how your hermit's behavior is shifting over time
- **`/hermit-health`** — alert state, channel availability, and heartbeat status

Each emits a compact snapshot you can pull from anywhere you're connected: the Claude app, your terminal, or a Discord/Telegram DM, with the answer coming back where you asked.

---

## Quick Start

> **Prerequisites:** [Claude Code](https://code.claude.com) v2.1.150+, a Claude plan (Pro, Max, Teams, or Enterprise), and Node.js 22+. Linux, macOS, and Windows via WSL2 — see [FAQ](docs/faq.md).

### 1. Install

```bash
cd /path/to/your/project   # or any folder — even an empty one
claude plugin marketplace add gtapps/claude-code-hermit
claude plugin install claude-code-hermit@claude-code-hermit --scope local
```

### 2. Initialize

```
claude /claude-code-hermit:hatch
```

The wizard sets up your agent's identity, scans your folder, generates `OPERATOR.md`, and offers Quick (5 questions) or Advanced (full wizard).

> **Just trying it?** After `hatch`, run `.claude-code-hermit/bin/hermit-start --no-tmux` for sessions, routines, heartbeat, and the learning loop without 24/7 autonomy. Run `/claude-code-hermit:channel-setup` first if you want Discord or Telegram.

### 3. Go Always-on

```
/claude-code-hermit:docker-setup
```

Generates the Docker scaffolding, builds the image, starts the container, and walks through auth and channel pairing. The container ships with the hardening baseline (`cap_drop: ALL`, `no-new-privileges`, `pids_limit`). Want stronger isolation? Run [`/docker-security`](docs/docker-security.md) for opt-in LAN containment + DNS allowlist + resource bounds.

See [Always-On Setup](docs/always-on.md) for the full guide. Want always-on without Docker? See [Always-On Operations](docs/always-on-ops.md) for bare tmux.

### Upgrading

```
claude plugin update claude-code-hermit@claude-code-hermit --scope local
/claude-code-hermit:hermit-evolve
```

---

## Cost & local-first

- **Per-call** token usage logged to `.claude/cost-log.jsonl` (model, input/output/cache split, USD estimate).
- **Per-session** running total in `.status.json`; carried into archived session reports as frontmatter `cost_usd`.
- **Per-day** rollup in `cost-summary.md`, regenerated on every cost-tracker tick.
- **Morning brief** (when scheduled as a routine) reads `cost-summary.md` and includes yesterday's spend.
- **`idle_budget`** is a soft cap. `hermit-doctor` warns at 80%, fails the cost check at 100% — no surprise stop-mid-task; you decide when to wind down.

No daily caps, no per-runtime-hour billing.

---

## Pre-built Hermits

Domain plugins you stack on top of any hermit you've hatched.

- [**`dev-hermit`**](../claude-code-dev-hermit/README.md) — *For software builders.* Safety layer for code-writing agents: push guard, branch discipline, gated PRs.
- [**`homeassistant-hermit`**](../claude-code-homeassistant-hermit/README.md) — *For Home Assistant users.* HA skills, safety hook, automation builder, Python CLI.
- [**`fitness-hermit`**](../claude-code-fitness-hermit/README.md) — *Fitness focused.* Strava MCP wiring, activity deep-dives, weekly-load routines.

Many operators run several hermits in parallel — one per domain. Each one is a `/hatch` away. They share nothing but the protocol; their memory, budgets, and routines are independent. See [Creating Your Own Hermit](docs/creating-your-own-hermit.md).

---

## Documentation

- [Always-On Operations](docs/always-on-ops.md)
- [Always-On Setup](docs/always-on.md)
- [Architecture](docs/architecture.md)
- [Config Reference](docs/config-reference.md)
- [Creating Your Own Hermit](docs/creating-your-own-hermit.md)
- [Docker Security](docs/docker-security.md)
- [FAQ](docs/faq.md)
- [Getting Started](docs/how-to-use.md)
- [Plugin Hermit Storage](docs/plugin-hermit-storage.md)
- [Recommended Plugins](docs/recommended-plugins.md)
- [Security](docs/security.md)
- [Skills Reference](docs/skills.md)
- [Testing](docs/testing.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Upgrading](docs/upgrading.md)

---

## Credits

- **[OpenClaw](https://github.com/openclaw/openclaw)** — Inspiration for autonomous agent ergonomics
- **[Everything Claude Code](https://github.com/affaan-m/everything-claude-code)** — Hook patterns and lifecycle architecture
- **[Andrej Karpathy](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)** — Inspiration for the raw/compiled knowledge system

## License

[MIT](../../LICENSE)
