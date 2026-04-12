# Getting Started

## Prerequisites

[Claude Code](https://code.claude.com) v2.1.80+ and a paid Claude plan (Pro or Max). Node.js 24+ for hooks. Optional: **tmux** for always-on mode, **Bun** for phone channels.

---

## Install

```bash
cd /path/to/your/project   # or any folder — even an empty one
claude plugin marketplace add gtapps/claude-code-hermit
claude plugin install claude-code-hermit@claude-code-hermit --scope project
```

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

---

## Your First Session

```
/claude-code-hermit:session
```

Tell it what you need, add optional tags (e.g., `feature, api`), and an optional budget. Hermit proposes a plan, creates native Tasks for each step, and waits for your go-ahead. As it works, `SHELL.md` tracks the narrative — progress log, blockers, findings — while Tasks tracks the plan steps. Cost is tracked separately in `.status.json` and injected into context at session start.

Check status anytime — just type "status":

```
Session S-001 | in_progress | feature, api
Working on: Add input validation to the API endpoints
Progress: 2/4 tasks | Current: Step 3 - Add request body validation
Budget: $1.80 / $5.00 (36%)
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

Docker is the recommended way to run your hermit autonomously. It provides container isolation so you can safely use `bypassPermissions` — no interactive prompts, no babysitting.

```bash
/claude-code-hermit:docker-setup    # generates hermit Docker files, walks you through deployment
```

See [Always-On Setup](always-on.md) for the full guide — auth, channels, takeover, cost management.

**Without Docker?** You can run directly in tmux:

```bash
.claude-code-hermit/bin/hermit-start
.claude-code-hermit/bin/hermit-stop
```

See [Always-On Operations](always-on-ops.md) for tmux setup and operational details.

---

## See What's Inside — Hermit Cortex

Hermit Cortex is an Obsidian-powered view of your hermit's brain — sessions, proposals, cost trends, learning, and cross-file connections, all linkable and searchable.

```bash
/claude-code-hermit:obsidian-setup    # one-time setup
/claude-code-hermit:cortex-refresh    # rebuild the index
```

See [Hermit Cortex](obsidian-setup.md) for the full guide.

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
├── reviews/
│   └── weekly-YYYY-WNN.md     <- weekly review reports
├── state/                     <- runtime observations (agent-owned)
│   ├── runtime.json           <- session state (in_progress/waiting/idle)
│   ├── alert-state.json       <- heartbeat alert dedup + self-eval evidence
│   ├── reflection-state.json  <- last reflection timestamp + plugin check state
│   ├── routine-queue.json     <- queued routines pending execution
│   ├── proposal-metrics.jsonl <- append-only event log
│   ├── micro-proposals.json   <- single-slot micro-approval queue
│   └── state-summary.md       <- auto-generated health snapshot
├── cortex-manifest.json       <- Obsidian Cortex index (optional)
├── OPERATOR.md                <- your rulebook
├── HEARTBEAT.md               <- background checklist
└── config.json                <- settings
```

> Files in `state/` are managed by the plugin at runtime — do not edit them manually. Files you own and can edit: `config.json`, `OPERATOR.md`, `HEARTBEAT.md`, `IDLE-TASKS.md`.

---

## Hook Profiles

| Profile                | What runs                                      | Best for                       |
| ---------------------- | ---------------------------------------------- | ------------------------------ |
| **minimal**            | Cost tracking only                             | Experimenting                  |
| **standard** (default) | + compact suggestions + session quality checks | Day-to-day work                |
| **strict**             | + safety hooks from hermits                    | Always-on, production-adjacent |

Set in `config.json` `env` (written to `.claude/settings.local.json` at boot):

```bash
/claude-code-hermit:hermit-settings env
# Then: AGENT_HOOK_PROFILE strict
```

Or edit `config.json` directly: `"env": { "AGENT_HOOK_PROFILE": "strict" }`

---

## Safety Rails

Hermit includes by default some deny patterns that block dangerous operations regardless of permission mode — `rm -rf`, `git push --force`, `chmod 777`, credential access, and more. The `/hatch` wizard generates these automatically, with a hardened set for always-on deployments.

See [Security](security.md) for the full deny list and defense-in-depth model.

---

## Permissions

The init wizard adds required permissions to `.claude/settings.json` automatically. To set up manually:

```json
{
  "permissions": {
    "allow": [
      "Bash(git diff:*)",
      "Bash(git status:*)",
      "Bash(git log:*)",
      "Bash(python3:*)",
      "Bash(node:*)",
      "Bash(bash -c 'AGENT_DIR=\".claude-code-hermit\"*)"
    ]
  }
}
```

Or just ask Hermit: "What permissions do you need?" — it'll tell you exactly what to add.

---

## All 24 Skills

Most common actions auto-trigger from natural language — just say what you mean. Slash commands (`/claude-code-hermit:*`) are the precision fallback for when auto-triggers don't fire.

| Category       | Skills                                                             |
| -------------- | ------------------------------------------------------------------ |
| **Session**    | `session`, `session-start`, `session-close`                        |
| **Status**     | `pulse`, `brief`                                                   |
| **Monitoring** | `watch`, `heartbeat`                                               |
| **Learning**   | `proposal-create`, `proposal-list`, `proposal-act`, `reflect`      |
| **Config**     | `hermit-settings`, `hatch`, `hermit-evolve`                        |
| **Docker**     | `docker-setup`, `hermit-takeover`, `hermit-hand-back`              |
| **Channels**   | `channel-responder`                                                |
| **Cortex**     | `obsidian-setup`, `cortex-refresh`, `cortex-sync`, `weekly-review` |
| **Testing**    | `smoke-test`, `test-run`                                           |

Full reference: [Skills Reference](skills.md).
