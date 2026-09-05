# Getting Started

## Prerequisites

A paid Claude plan (Pro, Max, Teams, or Enterprise). Linux, macOS, or Windows via WSL2.

The installer below provisions the rest: [Claude Code](https://code.claude.com) v2.1.251+, **Bun** ≥1.3 (the hooks and scripts are TypeScript run directly by `bun`), and **tmux** for always-on mode.

---

## Install

```bash
cd /path/to/your/project   # or any folder — even an empty one
curl -fsSL https://gtapps.github.io/claude-code-hermit/install.sh | bash
```

To uninstall this folder's hermit later:

```bash
curl -fsSL https://gtapps.github.io/claude-code-hermit/uninstall.sh | bash
```

It installs anything missing, registers the marketplace, installs the plugin for this folder, then launches Claude Code with the `/hatch` setup wizard after a short countdown (Ctrl+C skips the launch and prints the command to run instead; so does running without a terminal, e.g. over plain ssh or in CI). It takes no arguments.

To read it before running it:

```bash
curl -fsSL https://gtapps.github.io/claude-code-hermit/install.sh -o install.sh
less install.sh
bash install.sh
```

### Manual install

The installer is a convenience, not a requirement. With Claude Code and Bun already present:

```bash
cd /path/to/your/project
claude plugin marketplace add gtapps/claude-code-hermit
claude plugin install claude-code-hermit@claude-code-hermit --scope local
```

`--scope local` keeps the hermit personal to this folder rather than committing it to the repo for everyone. `/hatch` asks the shared-vs-personal question separately.

> **Upgrading is not a second `curl`.** Once installed, use `.claude-code-hermit/bin/hermit-update` (local/tmux), `.claude-code-hermit/bin/hermit-docker update` (Docker), or `claude plugin update claude-code-hermit@claude-code-hermit --scope local`. Re-running the installer is harmless but moves nothing.

---

## Initialize

```
/claude-code-hermit:hatch
```

The wizard sets up your agent's identity (name, language, timezone, [autonomy level](config-reference.md#escalation-levels)) and operational preferences (channels, remote control, heartbeat, daily routines, idle agency, budgets). Then it scans your folder and generates an `OPERATOR.md` — your rulebook. Starting fresh with an empty folder? It'll ask what the assistant is for.

### OPERATOR.md

Hermit reads this at every session start. Be specific — the more precise you are, the better it performs.

Good:

```markdown
# Operator Context

Solo developer building a Go REST API for inventory management.
Goal: feature parity with legacy PHP system by Q2.

Never modify migrations/ without asking. Monthly Claude budget: $150 — alert at $120.
The /internal/auth package is under security review — don't touch without approval.
```

Not useful:

```markdown
# Operator Context

A web app. Be careful.
```

The whole file is loaded on session start — write what matters, keep it short. Update anytime: just tell Hermit "update OPERATOR.md with [your change]."

Behavioral "when X, do Y" rules belong in `CLAUDE.md`, not here — see [the FAQ](faq.md#operatormd-vs-claudemd--where-does-it-go).

---

## Your First Session

```
/claude-code-hermit:session
```

Tell it what you need, add optional tags (e.g., `feature, api`). Hermit proposes a plan, records its steps in the Progress Log, and waits for your go-ahead. As it works, `SHELL.md` tracks everything — the plan, progress log, blockers, findings. Cost is tracked separately in `.status.json` and injected into context at session start.

Check status anytime — just type `/status`:

```
Session S-001 | in_progress | feature, api
Working on: Add input validation to the API endpoints
Progress: Step 3 - Add request body validation
Blockers: none
```

When it finishes, it archives the report and says "What's next?" — tell it what's next and keep going. Cumulative cost and session history carry forward. Run `/session-close` when you're actually done.

---

## Talk to Your Hermit

Hermit isn't just a work engine. During any session, you can ask it to reflect and improve:

- **"What slowed you down recently?"** — Reviews its experience and tells you what caused delays.
- **"What permissions do you keep getting blocked on?"** — Suggests the exact `settings.json` entries to add so it stops getting prompted.
- **"Suggest specialized agents for this project."** — Proposes new [sub-agents](https://code.claude.com/docs/en/sub-agents) based on the kind of work you've been doing. You approve, it creates them.
- **"How can you be more efficient?"** — Suggests workflow improvements, configuration tweaks, or structural changes.
- **"Create a self-improvement proposal."** — Formalizes what it's learned into a proposal you can accept or reject.

You're always in control. Hermit suggests. You decide.

**Handing this off to a non-developer owner?** Give them the [Owner's Guide](owners-guide.md) (talk, approve, pause, spend, who to call) and [What Your Assistant Can and Cannot Do](what-your-assistant-can-do.md) — both written for someone who'll never open a terminal.

---

## Tips

- **Don't create session/proposal files by hand.** Skills handle lifecycle tracking.
- **After plugin updates**, run `/claude-code-hermit:hermit-evolve`.
- **Talk to your hermit.** Ask how it can improve. It gets better when you tell it what you need.

---

## Daily Rhythm

If daily routines are enabled (default: yes), Hermit follows a schedule tied to your active hours:

- **Morning** — first heartbeat tick of the day: reviews what happened overnight, checks pending proposals, surfaces priorities. Sends a brief via channel if configured.
- **Evening** — last heartbeat tick of the day: archives the day's work as a report (if anything happened), reflects on patterns, flags tomorrow's priorities.

Both fire once per day. Configure with `/claude-code-hermit:hermit-settings routines`.

---

## Going Always-On

Docker is the guided way to run your hermit autonomously: container isolation, a reproducible environment, and a container that restarts itself. tmux runs the same hermit on the host with no image build — see [Always-On Setup](always-on.md) for how to pick. The default `auto` mode works either way; use `bypassPermissions` as an explicit opt-in if you need zero prompts for fully unattended operation.

```bash
/claude-code-hermit:docker-setup    # generates hermit Docker files, walks you through deployment
```

See [Always-On Setup](always-on.md) for the full guide — auth, channels, pausing the hermit, cost management.

**Without Docker?** You can run directly in tmux:

```bash
.claude-code-hermit/bin/hermit-start
.claude-code-hermit/bin/hermit-stop
```

To activate a channel in tmux mode, run `/claude-code-hermit:channel-setup` — it adds the channel to `config.json` if you skipped that at hatch, installs the plugin, configures the token, and guides pairing. `hermit-start` passes `--channels` automatically on boot.

See [Always-On Operations](always-on-ops.md) for tmux setup and operational details.

---

## Common Workflows

**Disconnected?** — Restart Claude Code. Hermit detects the active session and shows where you left off. Type "continue."

**What's next?** — When it finishes, just tell it what's next. It archives and rolls over automatically.

**Found an improvement?** — `/claude-code-hermit:proposal-create` captures it without interrupting the current work.

**What's Hermit been struggling with?** — `/claude-code-hermit:proposal-list` shows auto-detected patterns. Or just ask.

---

## Session State

```
.claude-code-hermit/
├── sessions/
│   ├── SHELL.md               <- live session
│   ├── S-001-REPORT.md        <- archived reports
│   └── NEXT-TASK.md           <- from accepted proposals
├── proposals/
│   └── PROP-001.md            <- improvement ideas
├── state/                     <- runtime observations (agent-owned)
│   ├── runtime.json           <- session state + config/auth, inbox/PID, and peer-name stamp
│   ├── alert-state.json       <- heartbeat alert dedup + self-eval evidence
│   ├── reflection-state.json  <- last reflection timestamp + scheduled check state
│   ├── routine-metrics.jsonl <- append-only routine fire log
│   ├── proposal-metrics.jsonl <- append-only event log
│   ├── usage-metrics.jsonl    <- append-only compiled-read usage log
│   ├── micro-proposals.json   <- pending micro-approvals list (pending[])
│   └── state-summary.md       <- auto-generated health snapshot
├── raw/                       <- domain inputs (fetched content, snapshots, logs)
│   └── .archive/              <- expired raw artifacts
├── compiled/                  <- durable domain outputs (briefings, decisions, review-weekly-YYYY-Www.md)
├── knowledge-schema.md        <- what this hermit produces and when
├── OPERATOR.md                <- your rulebook
├── HEARTBEAT.md               <- background checklist
└── config.json                <- settings
```

> Files in `state/` are managed by the plugin at runtime — do not edit them manually. Files you own and can edit: `config.json`, `OPERATOR.md`, `HEARTBEAT.md`.

---

## Model and Effort

**`config.model`** controls which Claude model your hermit runs on. Default: `"sonnet"`. Set to `"opus"` for premium reasoning or `"haiku"` for cheap idle loops. See the [Claude Code model configuration docs](https://code.claude.com/docs/en/model-config) for aliases, version pinning, and tier behavior.

**`CLAUDE_CODE_EFFORT_LEVEL`** (optional) sets the reasoning effort level. Add it to `config.env` if you want to override the model default — note the env var takes highest priority and overrides runtime `/effort`, so omit it for interactive sessions where you want per-turn control. Valid values and defaults: [CC model-config docs](https://code.claude.com/docs/en/model-config#adjust-effort-level).

A trusted channel sender can also pair the main model with an experimental [advisor model](https://code.claude.com/docs/en/advisor) mid-session via `/advisor <model>` (and clear it with `/advisor off`) — unlike `model`/`effort` above, this selection is not re-asserted at boot. Claude Code writes it to its own user-level settings, so it persists across restarts, applies to every session sharing that config directory, and keeps adding spend until a trusted sender sends `/advisor off`.

---

## Hook Profiles

| Profile                | What runs                                      | Best for                       |
| ---------------------- | ---------------------------------------------- | ------------------------------ |
| **minimal**            | Cost tracking only                             | Experimenting                  |
| **standard** (interactive default) | + session quality checks                       | Day-to-day work                |
| **strict** (always-on default)      | + safety hooks from hermits                    | Always-on, production-adjacent |

You usually don't set this. With nothing configured, an always-on launch (tmux or Docker) resolves **strict** and an interactive one **standard**, so a managed hermit gets the safety hooks without being asked. The launch output's `Hook profile:` line tells you what was resolved and where it came from.

To override, edit `config.json` directly:

```json
"env": { "AGENT_HOOK_PROFILE": "standard" }
```

`/hermit-settings env` deliberately refuses this key: the profile is resolved at boot, and an ambient value from Docker compose or your shell outranks whatever is in `config.json`.

The value is process-scoped: it reaches the managed session through the tmux env file or the Docker compose environment block, and is never written to `.claude/settings.local.json`. A `claude` you launch by hand in the same project is unaffected by it.

---

## Safety Rails

Hermit seeds native Claude Code permission rules. Standard (the `/hatch` default) hard-blocks `rm -rf`, `chmod 777`, casual credential dumps and more in `permissions.deny`, and puts risky-but-legitimate operations (`ssh`, `docker`, `kubectl`, `npm publish`, `git push --force`, `--no-verify`, settings and OPERATOR.md edits) behind an approval prompt in `permissions.ask`. Hardened puts both classes in `permissions.deny`. The deny entries hold in every permission mode, `bypassPermissions` included; ask entries are mode-dependent (`dontAsk` turns them into denies, `bypassPermissions` skips the prompt).

See [Security](security.md) for the full rule list and defense-in-depth model.

---

## Permissions

The init wizard adds the required permissions to `.claude/settings.json` automatically — including a `Bash(bun */scripts/*.ts*)` entry per hermit script. A representative subset:

```json
{
  "permissions": {
    "allow": [
      "Bash(git diff:*)",
      "Bash(git status:*)",
      "Bash(git log:*)",
      "Bash(bun */scripts/cost-tracker.ts*)",
      "Bash(bash -c 'AGENT_DIR=\".claude-code-hermit\"*)"
    ]
  }
}
```

Or just ask Hermit: "What permissions do you need?" — it'll tell you exactly what to add.

---

## Skills at a Glance

Most common actions auto-trigger from natural language — just say what you mean. Slash commands (`/claude-code-hermit:*`) are the precision fallback for when auto-triggers don't fire.

| Category       | Skills                                                             |
| -------------- | ------------------------------------------------------------------ |
| **Session**    | `session`, `session-start`, `session-close`                        |
| **Status**     | `brief`                                                            |
| **Monitoring** | `watch`, `heartbeat`                                               |
| **Learning**   | `proposal-create`, `proposal-list`, `proposal-act`, `reflect`      |
| **Config**     | `hermit-settings`, `hatch`, `hermit-evolve`                        |
| **Docker**     | `docker-customize`; `docker-setup`, `docker-security` (type the last two; they never auto-trigger) |
| **Channels**   | `channel-responder`                                                |
| **Summaries**  | `hermit-evolution`, `hermit-health`, `weekly-review`              |
