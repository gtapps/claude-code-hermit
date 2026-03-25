# How to Use claude-code-hermit

A step-by-step guide from install to your first autonomous session.

---

## 1. Prerequisites

| Requirement | Minimum Version | Notes |
|---|---|---|
| **Claude Code** | v2.1.80+ | Required for Channels support. v2.1.32+ works without channels. |
| **Claude Plan** | Pro or Max | Extended sessions require a paid plan. |
| **Node.js** | 18+ | Hook scripts (cost tracking, session evaluation) run on Node. |
| **Git** | Any recent version | Session archiving and file change tracking depend on it. |

Optional:
- **tmux** — required for the always-on boot scripts (`hermit-start`)
- **Bun** — required for [Channels](https://code.claude.com/docs/en/channels) (Telegram/Discord/iMessage) support

## 2. Installation

```bash
# Install the plugin into your project
cd /path/to/your/project
claude plugin marketplace add gtapps/claude-code-hermit
claude plugin install claude-code-hermit@claude-code-hermit --scope project
```

No `npm install`, no build step. The plugin is ready to use.

### Permissions (without `--dangerously-skip-permissions`)

The plugin's hooks and boot scripts execute shell commands automatically (reading git state, running Node.js hooks, loading session context). Without `--dangerously-skip-permissions`, Claude Code prompts for approval on each one.

The `/claude-code-hermit:init` wizard adds the required permissions to `.claude/settings.json` automatically. If you skip init or want to set them up manually, add these to your project's `.claude/settings.json`:

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

**What each permission enables:**

| Permission | Used by | Purpose |
|---|---|---|
| `git diff`, `git status`, `git log` | session-diff.js (Stop hook) | Auto-populates `## Changed` in SHELL.md with files modified during the session |
| `python3` | hermit-start.py, hermit-stop.py, check-upgrade.sh | Boot scripts for always-on mode and version checking |
| `node` | cost-tracker.js, suggest-compact.js, session-diff.js, evaluate-session.js | Stop hooks that run after every assistant turn |
| `bash -c 'AGENT_DIR=...` | SessionStart hook | Loads OPERATOR.md, SHELL.md, and last report on every Claude Code startup |

These go in `.claude/settings.json` (project-scoped, committed to git) so they apply to everyone using the project. Personal overrides go in `.claude/settings.local.json` (gitignored).

> **Note:** With `--dangerously-skip-permissions` (unattended/always-on mode), all permissions are granted automatically. These settings only matter for interactive use.

## 3. First Init

Start Claude Code and run the init skill:

```bash
claude
```

```
/claude-code-hermit:init
```

The init wizard walks you through two groups of questions:

**Agent Identity** — who the agent is:
- Agent name (e.g., "Atlas", "Hermit", or skip)
- Preferred language (auto-detected from your system locale)
- Timezone (auto-detected)
- Autonomy level: conservative, balanced, or autonomous
- Sign-off line for messages (e.g., "Atlas out.")

**Operational** — how the agent runs:
- Channels (Telegram / Discord / iMessage / none). For multi-agent setups, you can scope channel access locally per project (`.claude.local/channels/`) instead of the default user-level config -- see [Local-Scope Channel Config](ALWAYS-ON-OPS.md#local-scope-channel-config).
- [Remote control](https://code.claude.com/docs/en/remote-control) (connect from browser/phone via claude.ai/code)
- Morning brief (if channels are enabled)
- Heartbeat background checks (if channels are enabled)
- Budget prompting at session start
- Unattended mode (skip permission prompts)

After the wizard, the agent scans your project (README, package.json, CI config, etc.) and generates an OPERATOR.md with targeted questions to fill in what it couldn't infer.

When complete, you'll see a summary like:

```
Autonomous agent initialized!

Created:
  .claude/.claude-code-hermit/sessions/
  .claude/.claude-code-hermit/proposals/
  .claude/.claude-code-hermit/templates/ (3 templates)
  .claude/.claude-code-hermit/OPERATOR.md (onboarded)
  .claude/.claude-code-hermit/HEARTBEAT.md
  .claude/.claude-code-hermit/bin/ (hermit-start, hermit-stop)
  .claude/.claude-code-hermit/config.json

Next steps:
  1. Run /claude-code-hermit:session to start your first session
  2. Refine OPERATOR.md anytime — just tell me what changed
  3. For always-on operation: .claude/.claude-code-hermit/bin/hermit-start
```

## 4. Understanding OPERATOR.md

`.claude/.claude-code-hermit/OPERATOR.md` is the single most important file to customize. The agent reads it at the start of every session — it's how the agent knows what your project is, what to avoid, and how you prefer to work.

**Important:** The first 50 lines are loaded by the SessionStart hook. Keep critical context (project description, constraints, sensitive areas) at the top.

**Good operator context:**

```markdown
## Project
A Go-based REST API for inventory management. I'm the sole developer.
Goal: reach feature parity with the legacy PHP system by end of Q2.

## Constraints
- Never modify the `migrations/` directory without asking first.
- Monthly Claude budget: $150. Alert me at $120.

## Sensitive Areas
- /internal/auth — contains token validation logic, do not change without approval.
- .env files are gitignored and must stay that way.
```

**Bad operator context (too vague to be useful):**

```markdown
## Project
A web app.

## Constraints
Be careful.
```

The more specific you are, the better the agent performs. Include budget limits, off-limits directories, naming conventions, and communication preferences.

## 5. Your First Session

1. **Start the session:**
   ```
   /claude-code-hermit:session
   ```

2. **Set a task** when prompted:
   ```
   > What's the task for this session?
   Add input validation to the API endpoints
   ```

3. **Add tags** (optional) and **set a budget** (optional):
   ```
   > Any tags for this session? (e.g., refactor, frontend, urgent) Enter to skip.
   feature, api
   > Set a cost budget for this task?
   $5.00
   ```

4. **Review the proposed plan.** The agent presents an ordered plan and waits for your confirmation before starting work.

5. **Work progresses.** The agent updates `sessions/SHELL.md` after each significant plan item. You can track progress and resume later if interrupted.

6. **Check status anytime** — type "status" (auto-triggers) or run `/claude-code-hermit:status`:
   ```
   Session S-001 | in_progress | feature, api
   Task: Add input validation to the API endpoints
   Progress: 2/4 plan items | Current: Step 3 - Add request body validation
   Budget: $1.80 / $5.00 (36%)
   Blockers: none
   Cost: $1.80 (120K tokens)
   ```

7. **Close the session** with `/claude-code-hermit:session-close` (or the agent suggests it when the task is complete). A report is archived to `sessions/S-001-REPORT.md` with the task, plan, tags, blockers, and cost.

## 6. Understanding Session State

All state lives in `.claude/.claude-code-hermit/`:

```
.claude/.claude-code-hermit/
├── sessions/
│   ├── SHELL.md               ← live working document (current session)
│   ├── S-001-REPORT.md        ← archived report
│   └── S-002-REPORT.md
├── proposals/
│   └── PROP-001.md            ← improvement idea
├── templates/                 ← session and proposal templates
├── bin/                       ← boot scripts (hermit-start, hermit-stop)
├── config.json                ← project configuration
├── OPERATOR.md                ← your project context (you edit this)
└── HEARTBEAT.md               ← background checklist (you edit this)
```

**SHELL.md** is the live working document. It contains the task, a plan table with statuses (`planned`, `in_progress`, `blocked`, `done`), a timestamped progress log, blockers, findings, changed files (auto-populated by a hook), and cost data (auto-populated by the cost-tracker hook).

When a session closes, SHELL.md is copied to `S-NNN-REPORT.md` and a fresh SHELL.md is created for the next session.

## 7. Closing a Session

Run `/claude-code-hermit:session-close` when you're done. The agent:

1. Finalizes plan statuses and documents blockers
2. Records lessons learned and creates proposals for high-leverage improvements
3. Runs pattern detection across recent sessions (after 3+ reports exist)
4. Archives the report as `S-NNN-REPORT.md`

> **Note:** Pattern detection activates after your third completed session. Until then, this step is skipped — there isn't enough data to detect patterns. Once active, the agent analyzes recent reports for recurring blockers, repeated workarounds, cost trends, and tag correlations. See [When Self-Learning Fires](ALWAYS-ON-OPS.md#1d-when-self-learning-fires) for the full timeline.

The archived report includes: task, status (completed/partial/blocked), completed plan items, changed files, blockers, lessons, proposals created, and a "Next Start Point" describing what the next session should do first.

## 8. Common Workflows

### "I got disconnected"

Just restart Claude Code. The `session-start` skill detects the active session in SHELL.md and presents your task, progress, and blockers. Type "continue" to pick up where you left off.

### "I want to switch tasks"

Close the current session first (`/claude-code-hermit:session-close`), then start a new one (`/claude-code-hermit:session`). This archives the current work properly.

### "I found something worth improving"

Use `/claude-code-hermit:proposal-create` during a session. The agent captures the idea as a proposal file without interrupting the current task. Review proposals later with `/claude-code-hermit:proposal-list`.

### "I want to review proposals"

Run `/claude-code-hermit:proposal-list` to see all proposals with their status and age. Then act on them:

```
/claude-code-hermit:proposal-act accept PROP-003   ← becomes next session's task
/claude-code-hermit:proposal-act defer PROP-002    ← acknowledged, not now
/claude-code-hermit:proposal-act dismiss PROP-001  ← not applicable
```

Accepted proposals can generate a `NEXT-TASK.md` file that `session-start` offers as the default task next time.

## 9. Hook Profiles

Hooks run automatically at session boundaries. Three profiles are available:

| Profile | What It Does | Best For |
|---|---|---|
| `minimal` | Cost tracking only | Low overhead, experimentation |
| `standard` (default) | Cost tracking + compact suggestions + session evaluation | Day-to-day work |
| `strict` | Everything in standard + additional safety hooks from hermits | Production-adjacent work |

**To change the profile**, edit `.claude/settings.json`:

```json
{
  "env": {
    "AGENT_HOOK_PROFILE": "strict"
  }
}
```

## 10. Running Always-On

For persistent, always-on operation, use the boot scripts:

```bash
# Start the agent in tmux with channels and auto-session
.claude/.claude-code-hermit/bin/hermit-start

# Graceful shutdown (sends /session-close first)
.claude/.claude-code-hermit/bin/hermit-stop

# Immediate kill (skips session close)
.claude/.claude-code-hermit/bin/hermit-stop --force
```

The boot scripts read `config.json` for channel configuration, tmux session name, and heartbeat preferences. See [ALWAYS-ON-OPS.md](ALWAYS-ON-OPS.md) for the full operations guide.

## 11. Skills Reference

There are 15 skills grouped into 6 categories. For the complete reference with usage, auto-triggers, and examples, see **[SKILLS.md](SKILLS.md)**.

| Category | Skills |
|----------|--------|
| Session Lifecycle | session, session-start, session-close |
| Status & Reporting | status, brief |
| Monitoring | monitor, heartbeat |
| Proposals & Learning | proposal-create, proposal-list, proposal-act, pattern-detect |
| Configuration | hermit-settings, init, upgrade |
| Communication | channel-responder |

## 12. Tips

- **Use `/compact` at logical breakpoints** (between steps, not mid-task). This frees context window space without losing session state.
- **Use `/cost` to monitor spending.** The cost-tracker hook logs data automatically. If you set a session budget, it warns at 80% and 100%.
- **Keep sessions focused.** One task per session. If scope creep happens, capture the new idea as a proposal and stay on the original task.
- **Don't create session or proposal files by hand.** Always use the skills — manual creation bypasses lifecycle tracking.
- **Change settings anytime** with `/claude-code-hermit:hermit-settings`.
- **After plugin updates**, run `/claude-code-hermit:upgrade` to pick up new features and refresh templates.
