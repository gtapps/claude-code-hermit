<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License" /></a>
  <a href="https://code.claude.com/docs/en/plugins"><img src="https://img.shields.io/badge/Claude%20Code-plugin-orange.svg" alt="Claude Code Plugin" /></a>
  <a href="plugins/claude-code-hermit/CHANGELOG.md"><img src="https://img.shields.io/badge/version-1.3.3-green.svg" alt="Version 1.3.3" /></a>
  <img src="https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/gtapps/claude-code-hermit/_gh_traffic_stats/.github/badges/clones.json" alt="Downloads" />
  <img src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg" alt="PRs Welcome" />
  <a href="https://discord.gg/54sJqAxhUh"><img src="https://img.shields.io/badge/Discord-Join-5865F2?logo=discord&logoColor=white" alt="Join" /></a>
</p>

# Keep Claude Code working for you.

If you know [Claude Tag](https://claude.com/docs/claude-tag/overview), the idea will feel familiar: hand Claude work through a [channel](https://code.claude.com/docs/en/channels), such as Discord, Telegram, or your custom integration, and get results back there.

Hermit is a Claude Code plugin that runs an always-on agent on your machine or server, for you or your team. Give it ongoing responsibilities: maintain research, monitor systems, run routines, and follow up on unfinished work. Between requests, it checks those responsibilities, carries progress across sessions, and reaches you when something needs attention.

Use your own bots and accounts, with access to the local files, tools, and services you choose.

<p align="center">
  <img src="plugins/claude-code-hermit/assets/cover.png" alt="Always-on Claude Code agent" />
</p>

<a id="quick-start"></a>

## Set up

**Choose one installation method below.** Run it from the folder where you want your agent, empty or existing. Uses your Claude subscription on Linux, macOS, or Windows via WSL2. See [prerequisites](plugins/claude-code-hermit/docs/how-to-use.md#prerequisites).

<details open>
<summary>Install the Claude Code plugin</summary>

With Claude Code 2.1.263+ and Bun 1.3+ installed:

```bash
claude plugin marketplace add gtapps/claude-code-hermit
claude plugin install claude-code-hermit@claude-code-hermit --scope local
claude "/claude-code-hermit:hatch"
```

</details>

<details>
<summary>Or use the bootstrap installer</summary>

Prepares Claude Code, Bun, and tmux, installs the plugin, and launches setup:

```bash
curl -fsSL https://gtapps.github.io/claude-code-hermit/install.sh | bash
```

</details>

Both options install the plugin personally for this folder. Hatch guides you through the agent's purpose and operating preferences, then prints the next steps. Choose Quick for defaults you can adjust later.

## Keep it running

After setup, follow the printed next steps to start your agent.

**Sign-in renewal from chat.** Use `/relogin` to renew the agent’s Claude sign-in through your connected chat: open the link, sign in, and send back the code.

**Scheduled backups.** Optional backups preserve the agent’s knowledge, session reports, settings, and Claude Code memory in Git, with an optional private remote copy. Backups run without model tokens.

### On your machine

Run in a persistent tmux session:

```bash
.claude-code-hermit/bin/hermit-start
```

Requires tmux. The watchdog recovers failed sessions while your machine stays on. Claude Code's `/sandbox` is recommended for unattended use. To connect a chat, run `/claude-code-hermit:channel-setup` as directed by the setup handoff.

[Host setup and operations](plugins/claude-code-hermit/docs/always-on-ops.md)

### In Docker

Run the guided setup in Claude Code:

```text
/claude-code-hermit:docker-setup
```

Builds and starts the container, then walks you through authentication and channel pairing. Requires Docker Compose v2.

[Docker setup](plugins/claude-code-hermit/docs/always-on.md)

**Customize the container.** Ask the agent to add tools, packages, or services to its Docker setup. For example: “Add ffmpeg to the container.”

Optional [Docker security controls](plugins/claude-code-hermit/docs/docker-security.md) cover local-network access, DNS policy, resource limits, and plugin installation auditing.

## What the plugin adds

- **Continuity.** Persistent working state and archived session handoffs carry progress across compaction and restarts. An external watchdog recovers failed sessions, while context management keeps long-running sessions manageable.

- **Proactive work.** Heartbeats regularly check the responsibilities you give the agent. Routines run scheduled work, and watches surface changes. Together, they let the agent follow up without waiting for another request.

- **Work through chat.** Assign work and receive results in your connected chat. Longer assignments get threaded progress updates, with a separate reply when the agent needs a decision.

- **Token efficiency.** With Claude Code’s [Monitor](https://code.claude.com/docs/en/tools-reference#monitor-tool), heartbeat checks and optional routine prechecks run outside the model. Quiet checks and skipped routines use no model tokens; eligible routines due together can share a wake.

- **Lasting knowledge.** Turn source material in `raw/` into maintained knowledge in `compiled/`, alongside Claude Code's auto memory. `/recall` searches past sessions, knowledge, proposals, and captured channel conversations.

- **Learning from experience.** The agent reviews evidence from its work and operation, saves useful lessons, and verifies proposed behavior changes before bringing them to you for approval.

- **Control and visibility.** Track progress, proposals, and usage through the dashboard. Pause is enforced at the tool boundary, and optional usage caps can alert you or pause further work.

**Part of your project channel.** With passive mode, the agent saves incoming group messages to look back on later, and wakes when someone you allow @mentions it. It also remembers instructions for that channel. For example: “When I ask for a status update, include blockers.”

<a id="configure-it"></a>

## Configure

Tune from a terminal with `/hermit-settings`, or change permitted settings from a trusted Discord or Telegram chat. Every write is validated and recorded in a redacted audit ledger; `/hermit-settings history [setting]` shows what changed. Some of the settings available:

| Key | Default / options (default **bold**) |
|-----|--------------------------------------|
| `agent_name` | your assistant's name |
| `operator_profile` | primary-chat audience: **`technical`** / `non-technical` |
| `timezone` | detected during setup; fallback **`UTC`** |
| `language` | detected during setup; fallback **`en`** |
| `escalation` | how much it does before asking: `conservative` / **`balanced`** / `autonomous` |
| `model` | session model: **`sonnet`** |
| `permission_mode` | how freely the unattended agent acts: **`auto`** |
| `AGENT_HOOK_PROFILE` | guardrail profile: `minimal` / **`standard`** (interactive) / **`strict`** (always-on) |
| `channels` | Discord / Telegram / iMessage / third-party channel plugins (+ `allowed_users`) |
| `channels.primary` | which channel gets outbound pings |
| `channels.<name>.maintainer_channel_id` | optional separate chat for technical alerts, diagnostics, and usage details |
| `push_notifications` | native/mobile push on alerts: **`true`** |
| `remote` | remote control; `false` also requires approval for cross-machine peer messages; **`true`** |
| `ask_gate` | route unattended questions to a paired channel: **`true`** |
| `budget` | optional daily / weekly / monthly caps; **`alert`** or binding `pause` action |
| `artifacts` | dashboard / proposals / weekly review: **all enabled** |
| `heartbeat.enabled` | timed idle sweeps: **`true`** |
| `heartbeat.every` | idle sweep cadence: **`30m`** |
| `heartbeat.active_hours` | active window: **`08:00`–`23:00`** |
| `heartbeat.stale_threshold` | alert if no progress for: **`2h`** |
| `heartbeat.waiting_timeout` | auto `waiting`→`idle` after: **`null`** (off) |
| `routines` | persistent routines managed via `/hermit-routines` |
| `monitors` | persistent background watches managed via `/watch` |
| `scheduled_checks` | session-triggered skills at task completion |
| `reflection.graduation_min_sessions` | proposal recurrence bar: **`1`** |
| `quality_gate.tier` | post-change cleanup spend: **`budget`** / `balanced` / `quality` |
| `knowledge.compiled_budget_chars` | fresh/resumed startup catalog budget: **`2500`** |
| `knowledge.raw_retention_days` | `raw/` retention: **`14`** |
| `knowledge.working_set_warn` | warn above N compiled docs: **`20`** |
| `auto_session` | auto-start session on boot: **`true`** |
| `boot_skill` / `shutdown_skill` | custom boot / teardown skill |
| `post_close_clear` | clear context after midnight close: **`true`** |
| `context_hygiene.compact` | compact long-running active context: **enabled**, `100000` compactible tokens / `4h` cooldown |
| `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` | auto-compact at % of context: **`65`** |
| `MAX_THINKING_TOKENS` | thinking-token cap per turn: **`10000`** |
| `watchdog.scheduler_enabled` | OS scheduler for the watchdog tick: **`true`** on tmux always-on (auto-installed at boot); `false` or `hermit-watchdog uninstall` opts out |
| `watchdog.enabled` | recovery/restart tier: **`false`** until first scheduler registration (or `/docker-setup`); hygiene still runs |

Full schema in the [Config Reference](plugins/claude-code-hermit/docs/config-reference.md)

## Observe

**Artifacts.** The agent uses [Claude Code Artifacts](https://code.claude.com/docs/en/artifacts) to provide an interactive dashboard and custom pages generated on demand that you can view, interact with, and share. Ask it to build your own personalized agent dashboard.

Ask for an update from your terminal or connected chat:

| Command | What it gives you |
|---------|-------------------|
| `/brief` | Current status and a summary of recent work. |
| `/recall` | Search past sessions, knowledge, proposals, and captured conversations. |
| `/hermit-health` | Alerts, routines, channels, blockers, and recent learnings. |
| `/hermit-doctor` | Diagnostics for the installation, runtime, scheduling, credentials, and permissions. |
| `/hermit-evolution` | Cost trends, proposal activity, routines, and what the agent has produced over time. |
| `/cost-reflect` | A breakdown of usage by token type, session, and what triggered the work. |
| `/hermit-dashboard-design` | A dashboard designed around what your agent actually tracks. |

## Learning loop

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

Reflection runs at eligible task or session pauses, daily, and after routines configured to reflect. Approved changes can start now, become a task, or be left for manual implementation. Proposals are resolved when verification passes or later evidence shows the problem is gone.

**Follow-up verification.** The agent checks whether a fix or prediction held up over time. For example: “`/later` check tomorrow whether those errors have returned.”

**New ways to help.** The agent proposes new capabilities based on your work and the tools available to it. For example: “What else could you be doing for me?”

## Cost

Staying online does not require a model call on every tick. With Monitor scheduling, quiet heartbeat checks and skipped routines use no model tokens. Passive channel capture also runs without waking the model for ordinary chatter. Actual work, model evaluations, and replies consume usage; context management limits the history carried into later turns.

- **See what drives usage.** Token usage is recorded per call, including the model, input/output/cache split, and whether work came from a routine, heartbeat, channel, or another source. Session and daily totals feed the dashboard, weekly review, and `/cost-reflect`.
- **Set limits.** Optional daily, weekly, and monthly caps can alert you or enforce a pause until the exceeded budget window resets. Under Claude subscription billing, dollar figures are usage estimates rather than additional per-token charges.
- **Choose where to spend.** Set the session model and optionally assign a different model to individual routines. Routine models run in isolated subagents, so use them for work that can return a concise result.

See [budgets](plugins/claude-code-hermit/docs/config-reference.md#budget) and [routine scheduling](plugins/claude-code-hermit/docs/routine-authoring.md) for configuration and scheduler fallback behavior.

## Remote work

Reach the running agent through your connected channels or Claude Code Remote Control. You can also start separate sessions for additional work:

- **Background sessions with follow-up.** Through [`/spawn-session`](plugins/claude-code-hermit/skills/spawn-session/SKILL.md), the agent launches a local Claude Code helper in its own Git worktree and relays its status when it becomes idle.
- **Local [Remote Control](https://code.claude.com/docs/en/remote-control) gate.** Through [`/rc-gate`](plugins/claude-code-hermit/skills/rc-gate/SKILL.md), the agent manages a Remote Control server on your machine or server. While the gate is open, you can spawn new Claude Code sessions from the Claude app, using your local files and tools. Each session gets its own Git worktree, while the agent keeps running.

Both session-spawning paths require a Git workspace. Remote Control requires a Claude sign-in through `/login` on the machine running the agent.

**Watch other sessions.** Through [Claude Code cross-session messaging](https://code.claude.com/docs/en/cross-session-messaging), ask the agent to watch a local Claude Code session, including one you started interactively, and notify you when it next becomes idle.

**Claude Code controls from chat.** Use `/model sonnet`, `/effort high`, `/advisor opus`, `/compact`, `/clear`, and `/permission-mode auto` directly from your connected chat. Control the agent’s work with `/pause`, `/resume`, and `/snooze 2h`. Use [`/when-done-switch-to --model sonnet`](plugins/claude-code-hermit/skills/when-done-switch-to/SKILL.md) to switch automatically at the end of the current turn.

## Extensions

Optional plugins that add domain tools and workflows to your agent.

- [dev-hermit](plugins/claude-code-dev-hermit/README.md): Branch discipline, push guards, and gated PR workflows.
- [homeassistant-hermit](plugins/claude-code-homeassistant-hermit/README.md): Home Assistant tools, automation workflows, and safety checks.
- [fitness-hermit](plugins/claude-code-fitness-hermit/README.md): Strava integration, activity analysis, and training routines.
- [feed-hermit](plugins/feed-hermit/README.md): Source curation, recurring briefs, and weekly synthesis.
- [laravel-forge-hermit](plugins/laravel-forge-hermit/README.md): Laravel Forge deployments, logs, and server management.
- [hermit-scribe](plugins/hermit-scribe/README.md): GitHub issues and comments from proposals through a dedicated bot identity.

You can run separate agents for different responsibilities, each with its own working state, knowledge, and routines. See [Creating Your Own Hermit](plugins/claude-code-hermit/docs/creating-your-own-hermit.md).

**External orchestration.** Other agents and tools can check the agent’s status, health, and recent work through its [MCP interface](plugins/claude-code-hermit/docs/external-control-surface.md), and request a wake when needed.

## Upgrading

From the project folder, run the command for your setup:

| Setup | Command |
|-------|---------|
| On your machine | `.claude-code-hermit/bin/hermit-update` |
| Docker | `.claude-code-hermit/bin/hermit-docker update` |

See the [Upgrade guide](plugins/claude-code-hermit/docs/upgrading.md) for details.

<a id="tips--tuning"></a>

## Guides

- **Configure:** the [Config Reference](plugins/claude-code-hermit/docs/config-reference.md) covers the full schema and tuning details.
- **Use:** [Getting Started](plugins/claude-code-hermit/docs/how-to-use.md) and the [Owner's Guide](plugins/claude-code-hermit/docs/owners-guide.md) cover everyday work, decisions, and controls.
- **Automate:** [Routine Authoring](plugins/claude-code-hermit/docs/routine-authoring.md) covers schedules and prechecks. [Channel configuration](plugins/claude-code-hermit/docs/config-reference.md#channels) includes third-party channel plugins.
- **Observe:** [Artifacts](plugins/claude-code-hermit/docs/artifacts.md) explains the dashboard, proposals, and weekly reviews.
- **Maintain:** [Upgrading](plugins/claude-code-hermit/docs/upgrading.md), [Backup](plugins/claude-code-hermit/docs/backup.md), [Troubleshooting](plugins/claude-code-hermit/docs/troubleshooting.md), and [Uninstalling](plugins/claude-code-hermit/docs/how-to-use.md#install).
- **Understand:** [Architecture](plugins/claude-code-hermit/docs/architecture.md), [Security](plugins/claude-code-hermit/docs/security.md), and [FAQ](plugins/claude-code-hermit/docs/faq.md).

[All documentation](plugins/claude-code-hermit/docs/)

## Community

Join the [Discord community](https://discord.gg/54sJqAxhUh) for setup help and discussion. See [CONTRIBUTING.md](CONTRIBUTING.md) for reporting bugs or contributing.

## Credits

[Andrej Karpathy](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) inspired the `raw/` → `compiled/` knowledge system.

## License

[MIT](LICENSE)
