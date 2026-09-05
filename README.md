<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License" /></a>
  <a href="https://code.claude.com/docs/en/plugins"><img src="https://img.shields.io/badge/Claude%20Code-plugin-orange.svg" alt="Claude Code Plugin" /></a>
  <a href="plugins/claude-code-hermit/CHANGELOG.md"><img src="https://img.shields.io/badge/version-1.3.1-green.svg" alt="Version 1.3.1" /></a>
  <img src="https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/gtapps/claude-code-hermit/_gh_traffic_stats/.github/badges/clones.json" alt="Downloads" />
  <img src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg" alt="PRs Welcome" />
  <a href="https://discord.gg/54sJqAxhUh"><img src="https://img.shields.io/badge/Discord-Join-5865F2?logo=discord&logoColor=white" alt="Join" /></a>
</p>

# claude-code-hermit

Claude Code plugin that turns a Claude Code instance into a 24/7 agent. **Stateful. Proactive. Self-improving through an operator-gated proposal system. Cost-aware. Observable. Works with your Claude Subscription**.

<p align="center">
  <img src="plugins/claude-code-hermit/assets/cover.png" alt="Always-on Claude Code Agent" />
</p>


Setup your agent in any folder, empty or existing project with `/hatch` and shape its identity, priorities, routines, knowledge, autonomy, guardrails and make it yours.

```bash
cd /path/to/your/project   # any folder, even an empty one — Linux, macOS, WSL2
curl -fsSL https://gtapps.github.io/claude-code-hermit/install.sh | bash
```

Checks prequirements & installs if required (CC, Bun, Tmux), registers this marketplace, and installs the plugin for this folder — then launches your agent setup wizard.

---

## What it adds

Hermit adds a persistent operating layer around Claude Code, a learning loop, and a quick setup to wire everything.

- **Stateful** live working state, archived session handoffs, runtime observations, lessons, findings, blockers, completed tasks, files created/modified/deleted.
- **Agent Routines** Add your own scheduled routines. Give any routine a small precheck script so it only wakes Claude when there is work. Quiet skips use zero model tokens, and routines due at the same time share one wake. Managed by `/hermit-routines`.
- **Heartbeat** uses the checks you define in `HEARTBEAT.md` together with the agent's saved state, including pending decisions, active alerts, and stale work, to know when something needs attention. You can edit the list at any time or ask the agent to update it. Claude wakes only when needed; quiet ticks use zero model tokens.
- **`/watch`** watches logs, files, and other changing sources in the background, then notifies you when something happens. It stays silent when nothing changes.
- **Operate it from your phone.** The agent pings you first when it needs a decision. From a trusted [Claude Code Channel](https://code.claude.com/docs/en/channels) (Discord or Telegram), send work, accept proposals, change settings, check on it with `/status`, hold it with `/pause`, `/resume` and `/snooze`, or drive Claude Code itself with `/model`, `/effort`, `/permission-mode`, `/compact`, `/clear`, `/advisor`, and `/doctor`. `/doctor` needs the operator's own chat. Pause is enforced at the tool boundary, not merely treated as a conversational request.
- **Spawn new sessions remotely.** You run `/rc-gate` to open a Remote Control gate so the Claude app can start sessions in isolated worktrees, with cleanup for worktrees left behind after archival.
- **Native Artifacts Integration** The agent publishes its Dashboard, open proposals, weekly reviews, and requested compiled documents as private, versioned [Claude Code Artifacts](https://code.claude.com/docs/en/artifacts). Pages update in place at stable URLs and support organization sharing where available. You can use your own artifact server instead.
- **Auto-memory + knowledge** Claude Code's auto-memory holds facts and preferences about how to work with you. The agent also maintains a `raw/` → `compiled/` living knowledge base for domain work and topic pages, carries a bounded catalog across sessions, and makes all of it searchable with `/recall`. Discord and Telegram DMs are captured locally by default so chat decisions outlive the thread; `weekly-review` distills them into memory. [Channel capture can be disabled](plugins/claude-code-hermit/docs/config-reference.md#knowledge).
- **Plan tracking** lives in the SHELL.md Progress Log — timestamped steps that survive compaction, restart, and every model tier.
- **Unattended safety** combines native permission rules (hard-block + approval-prompt tiers) + sandbox, channel-routed asks, permission-denial alerts, and injection scans on heartbeat and startup context. A second session in the same folder is mechanically recognized as a guest and framed not to answer channels, write resident state, or start schedulers.
- **Orchestrator** instructed to delegate tasks & exploration to other agents, main context stays clean for token efficiency.

**Sessions self-manage.** Daemons auto-archive at 12h idle and at midnight when you're away, so evidence reaches the learning loop without a manual close. An external watchdog restarts dead sessions, nudges wedged ones, re-arms missed schedules, clears stale context after a midnight close, and compacts long-running context so cold wakes don't re-pay the full accumulated history — recovery never depends on the session being conscious.

**Context-efficient continuity.** After compaction, the agent reloads only a bounded lifecycle/task/progress capsule instead of the full startup bundle. Structured report frontmatter lets briefs, reflections, and weekly reviews inspect history without rereading every report body.

**It reaches you first.** Notifications default to a native push (headless-friendly), or a Discord/Telegram DM you can reply to if you've paired a channel.

The agent checks whether there is work before waking Claude. Quiet heartbeats and skipped routines use no model tokens, routines due at the same time share one wake, and long-running sessions periodically trim old context.

---

## Learning Loop

The agent reviews evidence from its work and operation. Durable lessons go to memory; non-trivial ideas that would change its behavior are verified, deduplicated, and brought to you for approval.

```text
Work produces evidence
          │
          ▼
Reflect when due
          │
          ▼
Verify and deduplicate
          │
     ┌────┴────┐
     ▼         ▼
Remember    Propose
a lesson    a change
                 │
                 ▼
           You approve?
              │     │
             no    yes
              │     │
         No change  Implement
                        │
                        ▼
                  Verify result
                        │
                        ▼
                  Future evidence
```

Reflection runs at eligible task or session pauses, daily, and after routines configured with `reflect_after`. Scheduled no-op runs are skipped before the model wakes in Monitor mode. Weak signals stay in an observation ledger; approved changes can start now, become a task, or be left for manual implementation. The agent then resolves the proposal when verification passes or later evidence shows the problem is gone.

---

## Observable

The agent uses [Claude Code Artifacts](https://code.claude.com/docs/en/artifacts) for observability: its Dashboard, proposals page, and weekly review stay current at stable URLs. You can use your own artifact server instead.

On-demand skills — pullable from the Claude app, your terminal, or a DM:

- **`/hermit-dashboard-design`** — designs the Dashboard around what this hermit actually tracks; delete `.claude-code-hermit/dashboard-render.ts` to restore the built-in page
- **`/recall`** — full-text search over past sessions, compiled knowledge, proposals, and your channel DM history ("what did I decide about X?")
- **`/hermit-evolution`** — cost trend and behavior drift over weeks
- **`/hermit-health`** — alerts, routines, channels, heartbeat state, plus fragile zones, stale proposals, and recent learnings
- **`/hermit-doctor`**: proactive install diagnostic, from hook registration to heartbeat and routine-monitor liveness; its scheduled precheck stays silent when green, and every run sends one routed two-leg summary
- **`/cost-reflect`** — structural cost audit: which token types and trigger sources drive spend
- **`/brief`** — current status and a summary of recent work

---

## Quick Start

> **Prerequisites:** a Claude plan (Pro, Max, Teams, or Enterprise). Linux, macOS, or Windows via WSL2; see [FAQ](plugins/claude-code-hermit/docs/faq.md).

### 1. Install

```bash
cd /path/to/your/project   # or any folder — even an empty one
curl -fsSL https://gtapps.github.io/claude-code-hermit/install.sh | bash
```

Installs [Claude Code](https://code.claude.com) and [Bun](https://bun.sh) if they're missing, adds tmux, registers the marketplace, and installs the plugin for this folder — then launches the setup wizard.

<details>
<summary>Prefer to do it by hand?</summary>

With Claude Code and Bun already present:

```bash
cd /path/to/your/project
claude plugin marketplace add gtapps/claude-code-hermit
claude plugin install claude-code-hermit@claude-code-hermit --scope local
claude "/claude-code-hermit:hatch"
```

Details: [Manual install](plugins/claude-code-hermit/docs/how-to-use.md#manual-install).

</details>

### 2. Hatch

The wizard sets up your agent's identity, scans your folder, generates `OPERATOR.md`, and offers Quick (4 questions) or Advanced (full wizard). Skipped the countdown, or no terminal? Run it yourself:

```
claude "/claude-code-hermit:hatch"
```

> **Just trying it?** After `hatch`, run `.claude-code-hermit/bin/hermit-start --no-tmux` for sessions, routines, heartbeat, and the learning loop without 24/7 autonomy. Run `/claude-code-hermit:channel-setup` first if you want Discord or Telegram.

### 3. Go Always-on

Pick one. Same hermit either way (heartbeat, routines, channels).

**tmux** (fastest onboard). Needs [tmux](https://github.com/tmux/tmux/wiki/Installing).

```
.claude-code-hermit/bin/hermit-start
```

`/sandbox` is recommended so Bash is isolated on the host (optional; hermit does not enable it). The first always-on boot registers the watchdog scheduler so a dead session comes back. Opt out with `.claude-code-hermit/bin/hermit-watchdog uninstall` (or `watchdog.scheduler_enabled: false` before the first boot). Walkthrough: [Always-On Operations](plugins/claude-code-hermit/docs/always-on-ops.md).

**Docker** (isolated, restarts with the daemon). Needs [Docker Compose](https://docs.docker.com/compose/install/) v2.

```
/claude-code-hermit:docker-setup
```

Generates the Docker scaffolding, builds the image, starts the container, and walks through auth and channel pairing. The container ships with the hardening baseline (`cap_drop: ALL`, `no-new-privileges`, `pids_limit`). Want stronger isolation? Run [`/docker-security`](plugins/claude-code-hermit/docs/docker-security.md) for opt-in LAN containment + DNS allowlist + resource bounds. Walkthrough: [Always-On Setup](plugins/claude-code-hermit/docs/always-on.md). Comparison of the two is at the top of that page.

### Upgrading

```
claude plugin update claude-code-hermit@claude-code-hermit --scope local
/claude-code-hermit:hermit-evolve
```

Or run `.claude-code-hermit/bin/hermit-update` (local/tmux) or `.claude-code-hermit/bin/hermit-docker update` (Docker): one command that moves the pin, reloads the session, and runs `hermit-evolve` for you.

### Uninstalling

From the hermit's folder:

```
curl -fsSL https://gtapps.github.io/claude-code-hermit/uninstall.sh | bash
```

This removes the watchdog, stops the session, uninstalls the plugin, keeps state unless you confirm deletion, and prints a Claude prompt for the shared-file cleanup. To deactivate only the watchdog, run `.claude-code-hermit/bin/hermit-watchdog uninstall`; to stop always-on mode but keep the hermit, run `.claude-code-hermit/bin/hermit-stop` or `.claude-code-hermit/bin/hermit-docker down`. Only this folder is affected; the shared marketplace registration and other hermits are left untouched.

---

## Configure it

Tune from a terminal with `/hermit-settings`, or change permitted settings from a trusted Discord or Telegram chat. Every write is validated and recorded in a redacted audit ledger; `/hermit-settings history [setting]` shows what changed. Some of the settings available:

| Key | Default / options (default **bold**) |
|-----|--------------------------------------|
| `agent_name` | your assistant's name |
| `timezone` | **`UTC`** |
| `language` | **`en`** |
| `escalation` | how much it does before asking — `conservative` / **`balanced`** / `autonomous` |
| `sign_off` | optional sign-off on channel messages |
| `model` | session model — **`sonnet`** |
| `permission_mode` | how freely the unattended agent acts — **`auto`** |
| `AGENT_HOOK_PROFILE` | guardrail profile — `minimal` / **`standard`** (interactive) / **`strict`** (always-on) |
| `channels` | Discord / Telegram / iMessage (+ `allowed_users`) |
| `channels.primary` | which channel gets outbound pings |
| `push_notifications` | native/mobile push on alerts — **`true`** |
| `remote` | remote control; `false` also requires approval for cross-machine peer messages; **`true`** |
| `ask_gate` | route unattended questions to a paired channel — **`true`** |
| `budget` | optional daily / weekly / monthly caps; **`alert`** or binding `pause` action |
| `artifacts` | dashboard / proposals / weekly review — **all enabled** |
| `idle_behavior` | **`discover`** (proactive) / `wait` (passive) |
| `heartbeat.enabled` | timed idle sweeps — **`true`** |
| `heartbeat.every` | idle sweep cadence — **`30m`** |
| `active_hours` | active window — **`08:00`–`23:00`** |
| `heartbeat.stale_threshold` | alert if no progress for — **`2h`** |
| `heartbeat.waiting_timeout` | auto `waiting`→`idle` after — **`null`** (off) |
| `routines` | persistent routines managed via `/hermit-routines` |
| `monitors` | persistent background watches managed via `/watch` |
| `scheduled_checks` | periodic skill invocations |
| `reflection.graduation_min_sessions` | proposal recurrence bar — **`1`** |
| `quality_gate.tier` | post-change cleanup spend — **`budget`** / `balanced` / `quality` |
| `knowledge.compiled_budget_chars` | fresh/resumed startup catalog budget — **`2500`** |
| `knowledge.raw_retention_days` | `raw/` retention — **`14`** |
| `knowledge.working_set_warn` | warn above N compiled docs — **`20`** |
| `auto_session` | auto-start session on boot — **`true`** |
| `boot_skill` / `shutdown_skill` | custom boot / teardown skill |
| `post_close_clear` | clear context after midnight close — **`true`** |
| `context_hygiene.compact` | compact long-running active context — **enabled**, `100000` compactible tokens / `4h` cooldown |
| `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` | auto-compact at % of context — **`65`** |
| `MAX_THINKING_TOKENS` | thinking-token cap per turn — **`10000`** |
| `watchdog.scheduler_enabled` | OS scheduler for the watchdog tick — **`true`** on tmux always-on (auto-installed at boot); `false` or `hermit-watchdog uninstall` opts out |
| `watchdog.enabled` | recovery/restart tier — **`false`** until first scheduler registration (or `/docker-setup`); hygiene still runs |


Full schema in the [Config Reference](plugins/claude-code-hermit/docs/config-reference.md)

---

## Tips & tuning

Settings apply without a reboot. Execution-adjacent changes, channel enrollment, and a direct `config.json` edit raise Claude Code's native permission prompt, delivered to the operator's chat DM or the terminal pane. Everyday settings apply without a prompt.

- **Model & Auto mode.** Defaults to Sonnet — a good balance of reasoning and cost for an unattended session. Auto mode is generally available to all users across subscription plans and API usage; supported models and provider configuration can still vary, so if Claude reports the current selection unavailable, choose a supported model or another permission mode. Switch to `opus` for heavier reasoning; per-routine `model: "haiku"` remains useful for lightweight, isolated work.

- **Heartbeat.** `heartbeat.every` sets the idle sweep (default `30m`; `2h`+ for slower pickup). Quiet polls cost nothing at any cadence, so this mostly controls how fast structured checks (proposals, budget, stale sessions) are picked up. `active_hours` bounds the window (`08:00`–`23:00`). `heartbeat.enabled: false` stops timed wakes entirely — channels and routines still fire.

- **Idle behavior.** `discover` (default) adds a priority-alignment pass against `OPERATOR.md` + cost log; `wait` is passive (tasks/channels only). Either way the daily `reflect` schedule is still evaluated; when its precheck finds no due phase, it consumes the fire without invoking the learning loop. `wait` only silences between-schedule discovery.

- **Routines.** Each routine takes an optional `model`: run lightweight ones on `haiku` to save cost or heavier ones on `opus` for more reasoning, in an isolated subagent. Omit `model` to keep it inline in the main session context — use that when the routine's value is its chat/transcript output, not just a status line. In Monitor mode, exactly co-due routines batch into one wake; offset routines you want as separate turns by a few minutes to keep the prompt cache warm. CronCreate fallback always fires them separately (see [Config Reference](plugins/claude-code-hermit/docs/config-reference.md) for the full rule).

- **Quiet & cheap:** `idle_behavior: "wait"` + a longer `heartbeat.every` + `quality_gate.tier: "budget"` (the default). Idle cost is already near-zero; these trim the rest.

Full reference: [Config Reference](plugins/claude-code-hermit/docs/config-reference.md).

---

## Cost & local-first

You run on your own Claude subscription — no per-runtime-hour billing — and every token is logged where you can see it. Optional daily, weekly, and monthly Hermit caps can alert you or enforce a binding pause when a limit is reached.

- **Per-call** token usage logged to `.claude/cost-log.jsonl` (model, input/output/cache split, USD estimate, and what triggered the turn: `heartbeat`, `routine:<id>`, `routine:multi`, `channel:<name>`, `peer` for another local session, or interactive/unattributed `other`).
- **Per-session** running total in `.status.json`; carried into archived session reports as frontmatter `cost_usd`.
- **Per-day** rollup in `cost-summary.md`, regenerated on every cost-tracker tick.
- **On demand** through `/cost-reflect`, `/hermit-doctor`, and the dashboard, plus a one-line spend summary in the weekly review. Routine briefs and status replies stay outcome-only; spend interrupts them only when a cap is approached or breached.

Quiet polling usually stays outside the model, so one Claude subscription can run several agents. Actual usage depends on their routines and work.

---

## Extensions

Extension plugins you stack on top of any hermit you've hatched.

- [**`dev-hermit`**](plugins/claude-code-dev-hermit/README.md) — *For software builders.* Safety layer for code-writing agents: push guard, branch discipline, gated PRs.
- [**`homeassistant-hermit`**](plugins/claude-code-homeassistant-hermit/README.md) — *For Home Assistant users.* HA skills, safety hook, automation builder, zero-dependency CLI.
- [**`fitness-hermit`**](plugins/claude-code-fitness-hermit/README.md) — *Fitness focused.* Strava MCP wiring, activity deep-dives, weekly-load routines.
- [**`feed-hermit`**](plugins/feed-hermit/README.md) — *For feed-to-brief pipelines.* Curated source registry, fetch/score/write pipeline, weekly synthesis, source-health analytics.
- [**`laravel-forge-hermit`**](plugins/laravel-forge-hermit/README.md) — *For Laravel Forge operators.* Deploy, logs, and server/site skills over the official Forge PHP SDK.
- [**`hermit-scribe`**](plugins/hermit-scribe/README.md) — *For maintainers.* Files GitHub issues and comments from proposals via a bot identity.

Many operators run several hermits in parallel — one per domain. Each one is a `/hatch` away. They share nothing but the protocol; their memory, cost history, and routines are independent, and a single Claude subscription covers them all. See [Creating Your Own Hermit](plugins/claude-code-hermit/docs/creating-your-own-hermit.md).

---

## Community

Join the [`claude-code-hermit` Discord community](https://discord.gg/54sJqAxhUh) for install help, always-on ops, plugin authoring, bug triage, and proposal/design discussion. Confirmed bugs and roadmap decisions should still move back to GitHub so they remain searchable and reviewable. See [CONTRIBUTING.md](CONTRIBUTING.md) for filing an issue or opening a PR.

---

## Documentation

- [Artifacts](plugins/claude-code-hermit/docs/artifacts.md)
- [Always-On Operations](plugins/claude-code-hermit/docs/always-on-ops.md)
- [Always-On Setup](plugins/claude-code-hermit/docs/always-on.md)
- [Architecture](plugins/claude-code-hermit/docs/architecture.md)
- [Config Reference](plugins/claude-code-hermit/docs/config-reference.md)
- [Community Discord](plugins/claude-code-hermit/docs/community-discord.md)
- [Creating Your Own Hermit](plugins/claude-code-hermit/docs/creating-your-own-hermit.md)
- [Docker Security](plugins/claude-code-hermit/docs/docker-security.md)
- [External Control Surface](plugins/claude-code-hermit/docs/external-control-surface.md)
- [Backup](plugins/claude-code-hermit/docs/backup.md)
- [FAQ](plugins/claude-code-hermit/docs/faq.md)
- [Getting Started](plugins/claude-code-hermit/docs/how-to-use.md)
- [Owner's Guide](plugins/claude-code-hermit/docs/owners-guide.md)
- [Plugin Hermit Storage](plugins/claude-code-hermit/docs/plugin-hermit-storage.md)
- [Recommended Plugins](plugins/claude-code-hermit/docs/recommended-plugins.md)
- [Remote Endpoint](plugins/claude-code-hermit/docs/remote-endpoint.md)
- [Routine Authoring](plugins/claude-code-hermit/docs/routine-authoring.md)
- [Security](plugins/claude-code-hermit/docs/security.md)
- [Testing](plugins/claude-code-hermit/docs/testing.md)
- [Troubleshooting](plugins/claude-code-hermit/docs/troubleshooting.md)
- [Upgrading](plugins/claude-code-hermit/docs/upgrading.md)
- [What Your Assistant Can and Can't Do](plugins/claude-code-hermit/docs/what-your-assistant-can-do.md)

---

## Credits

- **[Andrej Karpathy](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)** — Inspiration for the raw/compiled knowledge system

## License

[MIT](LICENSE)
