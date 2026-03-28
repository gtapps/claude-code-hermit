# Getting Started

## Prerequisites

[Claude Code](https://code.claude.com) v2.1.80+ and a paid Claude plan (Pro or Max). Node.js 22+ for hooks. Optional: **tmux** for always-on mode, **Bun** for phone channels.

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
/claude-code-hermit:init
```

The wizard sets up your agent's identity (name, language, timezone, autonomy level) and operational preferences (channels, remote control, heartbeat, daily routines, idle agency, budgets). Then it scans your folder and generates an `OPERATOR.md` — your rulebook. Starting fresh with an empty folder? It'll ask what the assistant is for.

### OPERATOR.md

Hermit reads this at every session start. Be specific — the more precise you are, the better it performs.

Good:

```markdown
## Project

A Go-based REST API for inventory management. Solo developer.

## Current Priority

Feature parity with the legacy PHP system by Q2.

## Constraints

- Never modify `migrations/` without asking first.
- Monthly Claude budget: $150. Alert at $120.

## Sensitive Areas

- /internal/auth — don't touch without approval.
```

Not useful:

```markdown
## Project

A web app.

## Constraints

Be careful.
```

First 50 lines are loaded automatically — keep critical context at the top. Update anytime: just tell Hermit "update OPERATOR.md with [your change]."

---

## Your First Session

```
/claude-code-hermit:session
```

Tell it what you need, add optional tags (e.g., `feature, api`), and an optional budget. Hermit proposes a plan and waits for your go-ahead. As it works, `SHELL.md` tracks everything — plan status, progress log, blockers, cost.

Check status anytime — just type "status":

```
Session S-001 | in_progress | feature, api
Working on: Add input validation to the API endpoints
Progress: 2/4 plan items | Current: Step 3 - Add request body validation
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

See [Always-On Setup](ALWAYS-ON.md) for the full guide — auth, channels, takeover, cost management.

**Without Docker?** You can run directly in tmux:

```bash
.claude/.claude-code-hermit/bin/hermit-start
.claude/.claude-code-hermit/bin/hermit-stop
```

See [Always-On Operations](ALWAYS-ON-OPS.md) for tmux setup and operational details.

---

## Common Workflows

**Disconnected?** — Restart Claude Code. Hermit detects the active session and shows where you left off. Type "continue."

**What's next?** — When it finishes, just tell it what's next. It archives and rolls over automatically.

**Found an improvement?** — `/claude-code-hermit:proposal-create` captures it without interrupting the current work.

**What's Hermit been struggling with?** — `/claude-code-hermit:proposal-list` shows auto-detected patterns. Or just ask.

---

## Session State

```
.claude/.claude-code-hermit/
├── sessions/
│   ├── SHELL.md               <- live session
│   ├── S-001-REPORT.md        <- archived reports
│   └── NEXT-TASK.md           <- from accepted proposals
├── proposals/
│   └── PROP-001.md            <- improvement ideas
├── OPERATOR.md                <- your rulebook
├── HEARTBEAT.md               <- background checklist
└── config.json                <- settings
```

---

## Hook Profiles

| Profile                | What runs                                      | Best for                       |
| ---------------------- | ---------------------------------------------- | ------------------------------ |
| **minimal**            | Cost tracking only                             | Experimenting                  |
| **standard** (default) | + compact suggestions + session quality checks | Day-to-day work                |
| **strict**             | + safety hooks from hermits                    | Always-on, production-adjacent |

Set in `.claude/settings.json`:

```json
{ "env": { "AGENT_HOOK_PROFILE": "strict" } }
```

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
      "Bash(bash -c 'AGENT_DIR=\".claude/.claude-code-hermit\"*)"
    ]
  }
}
```

Or just ask Hermit: "What permissions do you need?" — it'll tell you exactly what to add.

---

## All 18 Skills

Most common actions auto-trigger from natural language — just say what you mean. Slash commands (`/claude-code-hermit:*`) are the precision fallback for when auto-triggers don't fire.

| Category       | Skills                                                               |
| -------------- | -------------------------------------------------------------------- |
| **Session**    | `session`, `session-start`, `session-close`                          |
| **Status**     | `status`, `brief`                                                    |
| **Monitoring** | `monitor`, `heartbeat`                                               |
| **Learning**   | `proposal-create`, `proposal-list`, `proposal-act`, `reflect` |
| **Config**     | `hermit-settings`, `init`, `upgrade`                                 |
| **Docker**     | `docker-setup`, `hermit-takeover`, `hermit-hand-back`                |
| **Channels**   | `channel-responder`                                                  |

Full reference: [Skills Reference](SKILLS.md).

---

## Tips

- **`/compact` between steps** — frees context without losing session state.
- **`/cost` to monitor spending** — budgets warn at 80% and 100%.
- **One thing at a time.** When it finishes, it stays ready for the next one. Scope creep? Capture it as a proposal, stay focused.
- **Don't create session/proposal files by hand.** Skills handle lifecycle tracking.
- **After plugin updates**, run `/claude-code-hermit:upgrade`.
- **Talk to your hermit.** Ask how it can improve. It gets better when you tell it what you need.
