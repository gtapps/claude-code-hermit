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

The wizard sets up your agent's identity (name, language, timezone, autonomy level) and operational preferences (channels, remote control, heartbeat, budgets). Then it scans your folder and generates an `OPERATOR.md` — your rulebook. Starting fresh with an empty folder? It'll ask what the assistant is for.

### OPERATOR.md

Hermit reads this at every session start. Be specific — the more precise you are, the better it performs.

Good:

```markdown
## Project

A Go-based REST API for inventory management. Solo developer.
Goal: feature parity with the legacy PHP system by Q2.

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

Give it a task, optional tags (e.g., `feature, api`), and an optional budget. Hermit proposes a plan and waits for your go-ahead. As it works, `SHELL.md` tracks everything — plan status, progress log, blockers, cost.

Check status anytime — just type "status":

```
Session S-001 | in_progress | feature, api
Task: Add input validation to the API endpoints
Progress: 2/4 plan items | Current: Step 3 - Add request body validation
Budget: $1.80 / $5.00 (36%)
Blockers: none
```

Close with `/claude-code-hermit:session-close` — a full report is archived automatically.

When a task finishes, the agent archives the report and says "What's next?" — give it the next task and keep going. Cumulative cost and session history carry forward. Run `/session-close` when you're actually done.

---

## Talk to Your Hermit

Hermit isn't just a task runner. During any session, you can ask it to reflect and improve:

- **"What slowed you down recently?"** — Reviews recent sessions and tells you what caused delays, with evidence.
- **"What permissions do you keep getting blocked on?"** — Suggests the exact `settings.json` entries to add so it stops getting prompted.
- **"Suggest specialized agents for this project."** — Proposes new [sub-agents](https://code.claude.com/docs/en/sub-agents) based on the kind of work you've been doing. You approve, it creates them.
- **"How can you be more efficient?"** — Suggests workflow improvements, configuration tweaks, or structural changes.
- **"Create a self-improvement proposal."** — Formalizes what it's learned into a proposal you can accept or reject.

You're always in control. Hermit suggests. You decide.

---

## Going Always-On

```bash
.claude/.claude-code-hermit/bin/hermit-start    # launch in tmux with channels + heartbeat
.claude/.claude-code-hermit/bin/hermit-stop     # graceful shutdown
```

In always-on mode, the session stays open between tasks — heartbeat, monitors, and channels keep running. Send tasks from your phone. Let it work overnight.

See [Always-On Operations](ALWAYS-ON-OPS.md) for the full guide.

---

## Common Workflows

**Disconnected?** — Restart Claude Code. Hermit detects the active session and shows where you left off. Type "continue."

**Next task?** — When the current task finishes, just give the agent the next one. It archives and rolls over automatically.

**Found an improvement?** — `/claude-code-hermit:proposal-create` captures it without interrupting the current task.

**What's Hermit been struggling with?** — `/claude-code-hermit:proposal-list` shows auto-detected patterns. Or just ask.

---

## Session State

```
.claude/.claude-code-hermit/
├── sessions/
│   ├── SHELL.md               ← live session
│   ├── S-001-REPORT.md        ← archived reports
│   └── NEXT-TASK.md           ← from accepted proposals
├── proposals/
│   └── PROP-001.md            ← improvement ideas
├── OPERATOR.md                ← your rulebook
├── HEARTBEAT.md               ← background checklist
└── config.json                ← settings
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

## All 15 Skills

| Category       | Skills                                                               |
| -------------- | -------------------------------------------------------------------- |
| **Session**    | `session`, `session-start`, `session-close`                          |
| **Status**     | `status`, `brief`                                                    |
| **Monitoring** | `monitor`, `heartbeat`                                               |
| **Learning**   | `proposal-create`, `proposal-list`, `proposal-act`, `pattern-detect` |
| **Config**     | `hermit-settings`, `init`, `upgrade`                                 |
| **Channels**   | `channel-responder`                                                  |

Full reference: [Skills Reference](SKILLS.md).

---

## Tips

- **`/compact` between steps** — frees context without losing session state.
- **`/cost` to monitor spending** — budgets warn at 80% and 100%.
- **One task at a time.** When a task finishes, the agent stays ready for the next one. Scope creep mid-task? Capture it as a proposal, stay on task.
- **Don't create session/proposal files by hand.** Skills handle lifecycle tracking.
- **After plugin updates**, run `/claude-code-hermit:upgrade`.
- **Talk to your hermit.** Ask how it can improve. It gets better when you tell it what you need.
