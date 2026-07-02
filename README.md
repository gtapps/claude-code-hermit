<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License" /></a>
  <a href="https://code.claude.com/docs/en/plugins"><img src="https://img.shields.io/badge/Claude%20Code-plugin-orange.svg" alt="Claude Code Plugin" /></a>
  <a href="plugins/claude-code-hermit/CHANGELOG.md"><img src="https://img.shields.io/badge/version-1.2.14-green.svg" alt="Version 1.2.14" /></a>
  <img src="https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/gtapps/claude-code-hermit/_gh_traffic_stats/.github/badges/clones.json" alt="Downloads" />
  <img src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg" alt="PRs Welcome" />
  <a href="https://discord.gg/54sJqAxhUh"><img src="https://img.shields.io/badge/Discord-Join-5865F2?logo=discord&logoColor=white" alt="Join" /></a>
</p>

# claude-code-hermit

Claude Code plugin that turns a instance into a 24/7 AI assistant. **Orchestrates**, **Self-improves**, **Pro-Active**, **Cost-aware**, **Observable**, **One Claude subscription, multiple hermits**.

<p align="center">
  <img src="plugins/claude-code-hermit/assets/cover.png" alt="Always-on Claude Code Agent" />
</p>


**A hermit is a Claude Code session that doesn't end**: It wires the native primitives (`/loop`, `CronCreate`, `Channels`, `Monitor`, `Auto-memory`, `native Tasks`, `Sub Agents`, etc) into an **always-on agent** that orchestrates, keeps its own state, routines, knowledge and reaches you on Discord, Telegram, or the Claude app when something needs a decision. It can run on your existing subscription, and one subscription runs several hermits.

```
# Install
claude plugin marketplace add gtapps/claude-code-hermit
claude plugin install claude-code-hermit@claude-code-hermit --scope local

# Boot Claude Code and run the setup wizard
/claude-code-hermit:hatch

# Go always-on
/claude-code-hermit:docker-setup
```

---

## What you get

Just Claude Code and everything is yours to shape: channels (Discord/Telegram), MCP servers, routines, watches, the heartbeat checklist. Hermit adds persistence, a learning loop, and a quick setup to wire everything.

- **Orchestrator** instructed to delegate tasks & exploration to other agents, main context stays clean for token efficiency.
- **Heartbeat** gates `/loop` behind a filesystem-only precheck so it stops paying the model every tick, sweeping your checklist for **zero tokens**.
- **Routines** wrap `CronCreate` jobs that expire in 7 days and fire in the machine's timezone: they self-rearm daily, run on your wall clock, and are managed by `/hermit-routines`.
- **`/watch`** wraps `Monitor` streams that die with the session: it auto-starts from config (or plain language) and routes findings to your notifications, silent when quiet.
- **Channels** let you DM a session; the hermit agent acts on it (*"accept PROP-014"*, *"status"*) and **pings you first** when something needs a yes/no.
- **Auto-memory + knowledge** Two layers. Claude Code's native auto-memory holds operator facts and preferences (how to work with you); on top, the hermit adds a `raw/` → `compiled/` knowledge base — domain outputs and living topic pages updated in place — re-injected as a catalog within a context budget at session start. `/recall` searches both.
- **Task snapshots** persist native `Tasks` past session end, so the plan survives archives.
- **Profile-gated guardrails** scope `deny patterns + sandbox` per profile, locking the unattended agent down harder than the one you're watching.

**Sessions self-manage.** Daemons auto-archive at 12h idle and at midnight when you're away, so evidence reaches the learning loop without a manual close. An external watchdog restarts dead sessions, nudges wedged ones, re-arms missed schedules, and clears stale context after a midnight close — recovery never depends on the session being conscious.

**It reaches you first.** Notifications default to a native push (headless-friendly), or a Discord/Telegram DM you can reply to if you've paired a channel.

**Cost scales with events, not time.** Nothing wakes the model until something happens, so an idle hermit is effectively free.

---

## Learning Loop

A hermit watches what keeps going wrong across sessions, proposes a fix, and asks you yes or no. It won't propose the same thing twice.

At natural pauses — session end, idle ticks, scheduled cadence — it reflects. Most reflections never reach the model: a precheck script gates whether any phase (compute, resolution check, cost spike, digest, newborn) is actually due. When one is, two subagents vet the candidate before it reaches you:

- **`reflection-judge`** confirms the cited evidence actually exists in the session reports, so a proposal can't certify itself.
- **`proposal-triage`** deduplicates against open proposals, cross-checks your `MEMORY.md` and `OPERATOR.md`, and applies a three-condition bar.

Survivors land as a proposal you can act on from anywhere — including a DM:

```
/claude-code-hermit:proposal-list                  # see what it found
/claude-code-hermit:proposal-act accept PROP-003    # or just reply "accept PROP-003"
```

What it proposes: improvements, routines, new capabilities (skills, agents, heartbeat checks), guardrails (OPERATOR.md guidance you confirm), and bugs. When it catches itself repeating the same multi-step procedure across sessions, it drafts the skill and asks before installing. It improves its own skills too: when one keeps getting corrected or reworked across sessions, that graduates into a skill-improvement proposal, and on your okay it revises the skill (via `skill-creator`). Accepted proposals can carry a measurable success signal and auto-resolve when met. You're the acceptance gate for every change. Raw session journals distill into compiled artifacts that reload next session — the [raw/compiled pattern](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) Karpathy described for his wiki-LLM.

---

## Observable

On-demand skills — pullable from the Claude app, your terminal, or a DM:

- **`/recall`** — full-text search over past sessions, compiled knowledge, and proposals ("what did I decide about X?")
- **`/hermit-brain`** — open loops, fragile zones, and key learnings from recent sessions
- **`/hermit-evolution`** — cost trend and behavior drift over weeks
- **`/hermit-health`** — alerts, routines, channels, heartbeat state
- **`/hermit-doctor`** — fifteen-check install diagnostic, from hook registration to heartbeat liveness
- **`/cost-reflect`** — structural cost audit: which token types and trigger sources drive spend
- **`/pulse`** — what it's doing right now
- **`/brief`** — summary of recent work

---

## Quick Start

> **Prerequisites:** [Claude Code](https://code.claude.com) v2.1.172+, a Claude plan (Pro, Max, Teams, or Enterprise), and [Bun](https://bun.sh) 1.3+. Linux, macOS, and Windows via WSL2 — see [FAQ](plugins/claude-code-hermit/docs/faq.md).

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

The wizard sets up your agent's identity, scans your folder, generates `OPERATOR.md`, and offers Quick (4 questions) or Advanced (full wizard).

> **Just trying it?** After `hatch`, run `.claude-code-hermit/bin/hermit-start --no-tmux` for sessions, routines, heartbeat, and the learning loop without 24/7 autonomy. Run `/claude-code-hermit:channel-setup` first if you want Discord or Telegram.

### 3. Go Always-on

```
/claude-code-hermit:docker-setup
```

Generates the Docker scaffolding, builds the image, starts the container, and walks through auth and channel pairing. The container ships with the hardening baseline (`cap_drop: ALL`, `no-new-privileges`, `pids_limit`). Want stronger isolation? Run [`/docker-security`](plugins/claude-code-hermit/docs/docker-security.md) for opt-in LAN containment + DNS allowlist + resource bounds.

See [Always-On Setup](plugins/claude-code-hermit/docs/always-on.md) for the full guide. Want always-on without Docker? See [Always-On Operations](plugins/claude-code-hermit/docs/always-on-ops.md) for bare tmux.

### Upgrading

```
claude plugin update claude-code-hermit@claude-code-hermit --scope local
/claude-code-hermit:hermit-evolve
```

---

## Configure it

Tune via `/hermit-settings` (or just by asking the hermit). Some of the settings available:

| Key | Default / options (default **bold**) |
|-----|--------------------------------------|
| `agent_name` | your assistant's name |
| `timezone` | **`UTC`** |
| `language` | **`en`** |
| `escalation` | how much it does before asking — `conservative` / **`balanced`** / `autonomous` |
| `sign_off` | optional sign-off on channel messages |
| `model` | session model — **`sonnet`** |
| `permission_mode` | how freely the unattended agent acts — **`auto`** |
| `AGENT_HOOK_PROFILE` | guardrail profile — `minimal` / **`standard`** / `strict` |
| `channels` | Discord / Telegram / iMessage (+ `allowed_users`) |
| `channels.primary` | which channel gets outbound pings |
| `push_notifications` | native/mobile push on alerts — **`true`** |
| `remote` | remote control via claude.ai/code — **`true`** |
| `idle_behavior` | **`discover`** (proactive) / `wait` (passive) |
| `heartbeat.enabled` | timed idle sweeps — **`true`** |
| `heartbeat.every` | idle sweep cadence — **`2h`** |
| `active_hours` | active window — **`08:00`–`23:00`** |
| `heartbeat.stale_threshold` | alert if no progress for — **`2h`** |
| `heartbeat.waiting_timeout` | auto `waiting`→`idle` after — **`null`** (off) |
| `routines` | persistent routines managed via `/hermit-routines` |
| `monitors` | persistent background watches managed via `/watch` |
| `scheduled_checks` | periodic skill invocations |
| `reflection.graduation_min_sessions` | proposal recurrence bar — **`1`** |
| `quality_gate.tier` | post-change cleanup spend — **`budget`** / `balanced` / `quality` |
| `knowledge.compiled_budget_chars` | catalog injected at session start — **`2500`** |
| `knowledge.raw_retention_days` | `raw/` retention — **`14`** |
| `knowledge.working_set_warn` | warn above N compiled docs — **`20`** |
| `auto_session` | auto-start session on boot — **`true`** |
| `boot_skill` / `shutdown_skill` | custom boot / teardown skill |
| `post_close_clear` | clear context after midnight close — **`true`** |
| `COMPACT_THRESHOLD` | tool-count compact hint — **`75`** |
| `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` | auto-compact at % of context — **`65`** |
| `MAX_THINKING_TOKENS` | thinking-token cap per turn — **`10000`** |
| `watchdog.enabled` | external dead-session recovery — **`false`** |


Full schema in the [Config Reference](plugins/claude-code-hermit/docs/config-reference.md)

---

## Tips & tuning

All live-editable with `/hermit-settings` (or just ask the hermit) — no reboot.

- **Model.** Defaults to Sonnet — a good balance of reasoning and cost that also preserves the default `auto` permission mode's security classifier (it won't run on Haiku). Switch to `opus` for heavier reasoning. A Haiku *session* needs `permission_mode: "bypassPermissions"` (no classifier), so reserve it for sandboxed setups; per-routine `model: "haiku"` stays safe (the shipped auto-close already uses it).

- **Heartbeat.** `heartbeat.every` sets the idle sweep (default `2h`; `1h` tighter, `4h`+ fewer wakes); `active_hours` bounds the window (`08:00`–`23:00`). `heartbeat.enabled: false` stops timed wakes entirely — channels and routines still fire.

- **Idle behavior.** `discover` (default) adds a priority-alignment pass against `OPERATOR.md` + cost log; `wait` is passive (tasks/channels only). Either way the daily `reflect` routine still runs — `wait` only silences between-schedule discovery, not the learning loop.

- **Routines.** Each routine takes an optional `model`: run lightweight ones on `haiku` to save cost or heavier ones on `opus` for more reasoning, in an isolated subagent. Omit `model` to keep it inline in the main session context — use that when the routine's value is its chat/transcript output, not just a status line.

- **Quiet & cheap:** `idle_behavior: "wait"` + a longer `heartbeat.every` + `quality_gate.tier: "budget"` (the default). Idle cost is already near-zero; these trim the rest.

Full reference: [Config Reference](plugins/claude-code-hermit/docs/config-reference.md).

---

## Cost & local-first

You run on your own Claude subscription — no daily caps, no per-runtime-hour billing — and every token is logged where you can see it.

- **Per-call** token usage logged to `.claude/cost-log.jsonl` (model, input/output/cache split, USD estimate, and what triggered the turn — heartbeat, routine, or interactive).
- **Per-session** running total in `.status.json`; carried into archived session reports as frontmatter `cost_usd`.
- **Per-day** rollup in `cost-summary.md`, regenerated on every cost-tracker tick.
- **Morning brief** (when scheduled as a routine) reads `cost-summary.md` and includes yesterday's spend.

Because idle always-on cost is effectively zero, one Claude subscription can run several hermits at once.

---

## Pre-built Hermits

Domain plugins you stack on top of any hermit you've hatched.

- [**`dev-hermit`**](plugins/claude-code-dev-hermit/README.md) — *For software builders.* Safety layer for code-writing agents: push guard, branch discipline, gated PRs.
- [**`homeassistant-hermit`**](plugins/claude-code-homeassistant-hermit/README.md) — *For Home Assistant users.* HA skills, safety hook, automation builder, zero-dependency CLI.
- [**`fitness-hermit`**](plugins/claude-code-fitness-hermit/README.md) — *Fitness focused.* Strava MCP wiring, activity deep-dives, weekly-load routines.
- [**`laravel-forge-hermit`**](plugins/laravel-forge-hermit/README.md) — *For Laravel Forge operators.* Deploy, logs, and server/site skills over the official Forge PHP SDK.
- [**`hermit-scribe`**](plugins/hermit-scribe/README.md) — *For maintainers.* Files GitHub issues and comments from proposals via a bot identity.

Many operators run several hermits in parallel — one per domain. Each one is a `/hatch` away. They share nothing but the protocol; their memory, cost history, and routines are independent, and a single Claude subscription covers them all. See [Creating Your Own Hermit](plugins/claude-code-hermit/docs/creating-your-own-hermit.md).

---

## Community

Join the [`claude-code-hermit` Discord community](https://discord.gg/54sJqAxhUh) for install help, always-on ops, plugin authoring, bug triage, and proposal/design discussion. Confirmed bugs and roadmap decisions should still move back to GitHub so they remain searchable and reviewable.

---

## Documentation

- [Always-On Operations](plugins/claude-code-hermit/docs/always-on-ops.md)
- [Always-On Setup](plugins/claude-code-hermit/docs/always-on.md)
- [Architecture](plugins/claude-code-hermit/docs/architecture.md)
- [Config Reference](plugins/claude-code-hermit/docs/config-reference.md)
- [Community Discord](plugins/claude-code-hermit/docs/community-discord.md)
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

- **[Andrej Karpathy](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)** — Inspiration for the raw/compiled knowledge system

## License

[MIT](LICENSE)
