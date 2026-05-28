<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License" /></a>
  <a href="https://code.claude.com/docs/en/plugins"><img src="https://img.shields.io/badge/Claude%20Code-plugin-orange.svg" alt="Claude Code Plugin" /></a>
  <a href="plugins/claude-code-hermit/CHANGELOG.md"><img src="https://img.shields.io/badge/version-1.1.5-green.svg" alt="Version 1.1.5" /></a>
  <img src="https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/gtapps/claude-code-hermit/_gh_traffic_stats/.github/badges/clones.json" alt="Downloads" />
  <img src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg" alt="PRs Welcome" />
</p>

# claude-code-hermit

Claude Code plugin that turns it into a 24/7 personal AI assistant. **Self-learning**, **Local**, **Cost-aware**, **One Claude subscription, multiple hermits**.

<p align="center">
  <img src="plugins/claude-code-hermit/assets/demo.gif" alt="claude-code-hermit demo — Discord control, autonomous briefings, remote access" width="720" />
</p>

Hermit wires all the native Claude Code capabilities (`/loop`, `CronCreate`, channels, Monitor, auto-memory, native Tasks) to turn CC into a self-learning personal assistant.

```
# Install
claude plugin marketplace add gtapps/claude-code-hermit
claude plugin install claude-code-hermit@claude-code-hermit --scope project

# Boot Claude Code and run the setup wizard
/claude-code-hermit:hatch

# Go always-on
/claude-code-hermit:docker-setup
```

**One Claude subscription, multiple hermits** — each with its own memory, budget, and routines.

---

## What you get

**Drops into any folder.** Existing codebase, empty directory, new idea — `/hatch` scans what's there, asks 4–5 questions, and writes a personal rulebook (`OPERATOR.md`) capturing your priorities, constraints, and approval gates.

**Drive it from anywhere.** DM your hermit on Discord or Telegram, or remote-control. Powered by Claude Code's native Channels plugin and remote control — no web app, no separate UI.

**Self-learning, operator-gated.** Reflects on its own session journals and **token usage**, applies a three-condition rule (repeated pattern + meaningful consequence + actionable change), and proposes new skills, agents, routines, or rules. You approve, defer, or dismiss.

**Cost-aware by default.** Per-call tokens logged to `.claude/cost-log.jsonl`; per-session running total in `.status.json`; per-day rollup in `cost-summary.md`. Morning briefs include yesterday's spend.

**Two guided wizards.** `/hatch` (initialize), `/docker-setup` (always-on container). Each runs a Quick path (sensible defaults) or Advanced (full wizard).

**Always-on** Docker isolation, `cap_drop: ALL`, `no-new-privileges`, `pids_limit` baseline. The opt-in `/docker-security` wizard adds LAN containment with DNS allowlist sidecar, resource bounds, and a plugin-install audit log. `/hatch` auto-configures the native bash sandbox (standard profile: credential paths denied, network unrestricted).

**Sessions self-manage.** Long-running daemons auto-archive at 12h idle and at midnight when the operator is inactive — evidence reaches reflect and weekly-review without manual close.

---

## Built on Claude Code's native stack

- **`/loop`** (scheduled tasks) — heartbeat ticks at your chosen cadence, local routines
- **`CronCreate`** — built-in **local routines** (morning brief, evening summary, scheduled checks, heartbeat restart) plus **your own custom routines**
- **Channels** — talk to your hermit via Discord or Telegram
- **Remote Control** — drive live sessions from claude.ai/code or your phone; survives sleep and network drops
- **Monitor tool** — background watches stream events as conversation notifications; zero tokens when quiet
- **Auto-memory** (`MEMORY.md`) — load-bearing memory; hermit layers `raw/` and `compiled/` for durable domain artifacts
- **Native Tasks** — `TaskCreate` for plan tracking; hooks read task files for `tasks-snapshot.md`
- **Deny patterns** — configured in `.claude/settings.json` for fail-closed safety
- **Bash sandbox** — `/hatch` auto-configures the standard profile (credential path denies, unrestricted network); opt out via `sandbox.enabled: false`

Hermit adds the integration layer — `/hatch` to spawn one, the proposal pipeline to evolve one, `OPERATOR.md` as policy.

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

On demand: `/hermit-brain` (fragile zones and learnings), `/hermit-evolution` (cost and autonomy trends), `/hermit-health` (alert state and channel availability) — each emits a compact, channel-ready snapshot.

Voyager-style auto-curriculum, you're editor-in-chief. Under the hood, raw session journals distill into compiled artifacts that reload next session — the [raw-vs-compiled pattern](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) Karpathy described for his wiki-LLM.

---

## Quick Start

> **Prerequisites:** [Claude Code](https://code.claude.com) v2.1.150+, a Claude plan (Pro, Max, Teams, or Enterprise), and Node.js 22+. Linux, macOS, and Windows via WSL2 — see [FAQ](plugins/claude-code-hermit/docs/faq.md).

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

The wizard sets up your agent's identity, scans your folder, generates `OPERATOR.md`, and offers Quick (5 questions) or Advanced (full wizard).

> **Just trying it?** After `hatch`, run `.claude-code-hermit/bin/hermit-start --no-tmux` for sessions, routines, heartbeat, and the learning loop without 24/7 autonomy. Run `/claude-code-hermit:channel-setup` first if you want Discord or Telegram.

### 3. Go Always-on

```
/claude-code-hermit:docker-setup
```

Generates the Docker scaffolding, builds the image, starts the container, and walks through auth and channel pairing. The container ships with the hardening baseline (`cap_drop: ALL`, `no-new-privileges`, `pids_limit`). Want stronger isolation? Run [`/docker-security`](plugins/claude-code-hermit/docs/docker-security.md) for opt-in LAN containment + DNS allowlist + resource bounds.

See [Always-On Setup](plugins/claude-code-hermit/docs/always-on.md) for the full guide. Want always-on without Docker? See [Always-On Operations](plugins/claude-code-hermit/docs/always-on-ops.md) for bare tmux.

### Upgrading

```
claude plugin update claude-code-hermit@claude-code-hermit --scope project
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

- [**`dev-hermit`**](plugins/claude-code-dev-hermit/README.md) — *For software builders.* Safety layer for code-writing agents: push guard, branch discipline, gated PRs.
- [**`homeassistant-hermit`**](plugins/claude-code-homeassistant-hermit/README.md) — *For Home Assistant users.* HA skills, safety hook, automation builder, Python CLI.
- [**`fitness-hermit`**](plugins/claude-code-fitness-hermit/README.md) — *Fitness focused.* Strava MCP wiring, activity deep-dives, weekly-load routines.

Many operators run several hermits in parallel — one per domain. Each one is a `/hatch` away. They share nothing but the protocol; their memory, budgets, and routines are independent. See [Creating Your Own Hermit](plugins/claude-code-hermit/docs/creating-your-own-hermit.md).

---

## Documentation

- [Always-On Operations](plugins/claude-code-hermit/docs/always-on-ops.md)
- [Always-On Setup](plugins/claude-code-hermit/docs/always-on.md)
- [Architecture](plugins/claude-code-hermit/docs/architecture.md)
- [Config Reference](plugins/claude-code-hermit/docs/config-reference.md)
- [Creating Your Own Hermit](plugins/claude-code-hermit/docs/creating-your-own-hermit.md)
- [Docker Security](plugins/claude-code-hermit/docs/docker-security.md)
- [FAQ](plugins/claude-code-hermit/docs/faq.md)
- [Getting Started](plugins/claude-code-hermit/docs/how-to-use.md)
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
