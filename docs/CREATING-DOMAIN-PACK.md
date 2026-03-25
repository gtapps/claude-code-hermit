# Creating a Domain Pack

A domain pack is a Claude Code plugin that extends `claude-code-hermit` with agents, skills,
hooks, and instructions for a specific domain. It is a separate repo, installed alongside core.

---

## What a Domain Pack Is (and Isn't)

**Is:** A reusable plugin that adds domain-specific capabilities on top of core's session
discipline. Installed once, usable across many projects in the same domain.

**Isn't:** A project-specific customization. For that, see
[CREATING-PROJECT-AGENT.md](CREATING-PROJECT-AGENT.md) — you don't need a separate repo
to add agents and skills to a single project.

**Rule of thumb:** If the same agents, skills, and hooks would be useful across multiple
projects in the same domain, make a domain pack. If they're specific to one project,
add them directly to the project.

---

## How Core Works (What You're Extending)

Before building a pack, understand what core provides. Your pack layers on top of this.

```
claude-code-hermit/
├── .claude-plugin/plugin.json             # Plugin manifest
├── agents/session-mgr.md                  # Session lifecycle agent (Sonnet)
├── hooks/hooks.json                       # 5 hooks: SessionStart + 4 Stop
├── scripts/
│   ├── cost-tracker.js                    # Token/cost logging
│   ├── suggest-compact.js                 # Context window management
│   ├── session-diff.js                    # Auto-populate changed files
│   ├── evaluate-session.js                # Session quality validation
│   ├── run-with-profile.js                # Profile-gated hook wrapper
│   ├── hermit-start.py                    # Boot script (tmux + channels)
│   └── hermit-stop.py                     # Graceful shutdown
├── skills/                                # 15 skills (see docs/SKILLS.md for full list)
└── state-templates/                       # Copied into target projects by init
```

Core gives you:

- **Session discipline** — ACTIVE.md, session reports, progress tracking
- **Cost tracking** — per-session token and cost logging with budget alerts
- **Hook infrastructure** — profile-gated hooks (SessionStart, Stop) and the `run-with-profile.js` wrapper for adding your own
- **Operator contract** — OPERATOR.md loaded at every session start
- **Boot scripts** — tmux-based headless operation with channels

Your domain pack adds domain-specific agents, skills that encode your workflows, and
hooks that enforce your safety rules.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full core architecture reference.

---

## How Packs Interact with Core

Understanding these interaction points will inform your design decisions in the steps
that follow.

### Hook Profiles

Core defines three profiles: `minimal`, `standard`, `strict`. Your pack's hooks
participate in this system. Convention:

- **Safety hooks** (blocking dangerous operations) → gate to `strict`
- **Quality hooks** (validation, suggestions) → gate to `standard,strict`
- **Essential hooks** (cost tracking, state updates) → run on all profiles

### Session Lifecycle

Your pack's skills should always delegate to core for session management:

```
/claude-code-hermit:session-start  →  your domain workflow  →  /claude-code-hermit:session-close
```

Core handles: ACTIVE.md creation, progress tracking, session archival, cost tracking,
session evaluation. Your pack handles: domain-specific agents, workflow orchestration,
domain safety rules.

### ACTIVE.md Sections

Your agents can write to standard ACTIVE.md sections during a session:

| Section | Who writes | When |
|---------|-----------|------|
| Mission | Core (session-start) | Session start |
| Steps | Your skills/agents | During work |
| Progress Log | Your skills/agents | During work |
| Blockers | Your skills/agents | When blocked |
| Discoveries | Your skills/agents | When found |
| Changed | Core (session-diff hook) or your agents | During/after work |
| Cost | Core (cost-tracker hook) | Session stop |

### Hooks and Subagents

Whether core's hooks fire on subagent tool calls is currently
[pending verification](ARCHITECTURE.md#hooks-and-subagents). Design your agents with
self-contained safety rules (`disallowedTools`, forbidden actions in the system prompt)
as the primary enforcement. Treat hooks as an additional layer.

### Plugin Environment Variables

Claude Code provides these variables at runtime for plugin scripts and skills:

- `${CLAUDE_PLUGIN_ROOT}` — path to the plugin's installation directory (use in hooks
  and skill instructions to reference your own files)
- `${CLAUDE_PLUGIN_DATA}` — persistent data directory for the plugin
- `${CLAUDE_SKILL_DIR}` — path to the current skill's directory (available in skills only)

---

## Domain Pack Structure

```
claude-code-DOMAIN-hermit/
├── .claude-plugin/
│   └── plugin.json              # Plugin manifest (required)
├── agents/                      # Domain-specific subagents
│   └── *.md                     #   One file per agent
├── hooks/
│   └── hooks.json               # Domain-specific hook registrations (optional)
├── scripts/
│   └── *.js                     #   Hook implementations (optional)
├── skills/                      # Domain workflows
│   ├── init/
│   │   └── SKILL.md             #   Pack initialization (required)
│   └── domain-session/
│       └── SKILL.md             #   Domain session workflow (recommended)
├── state-templates/
│   └── CLAUDE-APPEND.md         #   Instructions appended to CLAUDE.md (required)
└── CLAUDE.md                    #   Pack documentation
```

All public entry points are **skills** (`/claude-code-DOMAIN-hermit:skill-name`).
Claude Code auto-discovers `agents/`, `skills/`, and `hooks/hooks.json` at the plugin
root — no need to declare paths in `plugin.json`.

---

## Step 1: Create the Plugin Manifest

Create `.claude-plugin/plugin.json`:

```json
{
  "name": "claude-code-DOMAIN-hermit",
  "version": "1.0.0",
  "description": "DOMAIN agents, workflows, and safety for claude-code-hermit",
  "author": { "name": "your-org" },
  "license": "MIT",
  "keywords": ["autonomous", "agent", "DOMAIN", "gtapps"]
}
```

Only `name` is strictly required. The rest is recommended for discoverability.

**Naming convention:** `claude-code-{domain}-hermit`. Examples:
- `claude-code-data-hermit` — data engineering / analytics
- `claude-code-infra-hermit` — infrastructure / DevOps
- `claude-code-docs-hermit` — documentation workflows

---

## Step 2: Design Your Agents

Agents are the core of a domain pack. Each agent is a markdown file in `agents/` with
YAML frontmatter and a system prompt body.

### Agent Design Principles

**1. One responsibility per agent.** Don't build one monolithic "domain agent." Split by
role — a scout that reads, a builder that writes, a reviewer that validates.

**2. Least privilege.** Every agent should have the minimum tools needed:

```yaml
tools:
  - Read
  - Glob
  - Grep
  - Bash
disallowedTools:
  - Write
  - Edit
  - WebSearch
  - WebFetch
```

**3. Use isolation for destructive agents.** If an agent writes or modifies files,
consider worktree isolation:

```yaml
isolation: worktree
```

This gives the agent its own copy of the repo on a feature branch. Changes only reach
main after explicit merge.

**4. Match model to complexity.** Use Haiku for simple/fast tasks (scanning, listing),
Sonnet for complex reasoning (writing, review).

### Available Agent Frontmatter Fields

| Field | Values | Notes |
|-------|--------|-------|
| `name` | kebab-case string | Required |
| `description` | string | Used by Claude to decide when to delegate |
| `model` | `haiku`, `sonnet`, `opus`, `inherit` | Default: inherit from parent |
| `effort` | `low`, `medium`, `high`, `max` | Thinking effort level |
| `maxTurns` | number | Max agentic turns before stopping |
| `tools` | list of tool names | Allowlist |
| `disallowedTools` | list of tool names | Denylist (applied before allowlist) |
| `memory` | `user`, `project`, `local` | Persistent memory scope |
| `isolation` | `worktree` | Run in isolated git worktree |
| `skills` | list of skill names | Skills to preload |
| `background` | `true` | Always run as background task |

**Not available in plugin agents** (security restriction): `hooks`, `mcpServers`,
`permissionMode`.

### Agent Template

```markdown
---
name: agent-name
description: One sentence. Claude Code uses this to decide when to delegate.
model: sonnet
effort: high
maxTurns: 25
tools:
  - Read
  - Write
  - Edit
  - Bash
  - Glob
  - Grep
disallowedTools:
  - WebSearch
  - WebFetch
memory: project
---
You are a [role description].

## Before Starting

1. Read OPERATOR.md for project constraints
2. [Domain-specific orientation steps]

## While Working

- [Domain-specific rules and guardrails]
- [Safety constraints — what to never do]

## When Done

Return a structured summary:
- What was done
- Files affected
- Any concerns or follow-up needed
```

---

## Step 3: Create Skills (Workflows)

Skills are the public interface of your domain pack. Each skill is a directory with
a `SKILL.md` file. The directory name becomes the slash command:
`skills/domain-session/SKILL.md` → `/claude-code-DOMAIN-hermit:domain-session`.

### Available Skill Frontmatter Fields

| Field | Values | Notes |
|-------|--------|-------|
| `name` | string | Optional (uses directory name if omitted) |
| `description` | string | When to use this skill |
| `argument-hint` | string | Autocomplete hint (e.g., `[environment]`) |
| `allowed-tools` | comma-separated | Tool allowlist for this skill |
| `model` | model name | Model override |
| `effort` | effort level | Effort override |
| `context` | `fork` | Run in a subagent context |
| `agent` | agent name | Subagent type to use with `context: fork` |
| `disable-model-invocation` | `true` | Manual only — Claude won't auto-invoke |
| `user-invocable` | `false` | Hidden from `/` menu |

### Skill Template

```markdown
---
name: domain-session
description: Full DOMAIN session workflow with quality gates.
---
# DOMAIN Session

## On Session Start

1. Run `/claude-code-hermit:session-start` to load context
2. [Domain-specific orientation]

## During Work

1. [Domain-specific workflow steps]
2. [Quality gates — e.g., validate config, run tests]

## On Session Close

1. [Domain-specific cleanup]
2. Run `/claude-code-hermit:session-close`
```

Always bookend with core's session-start and session-close. Your skill adds domain
logic in between.

### Dynamic Content in Skills

Skills support substitutions:

- `$ARGUMENTS` — all arguments passed to the skill
- `$1`, `$2`, etc. — positional arguments
- `${CLAUDE_SKILL_DIR}` — path to the skill's directory
- `${CLAUDE_SESSION_ID}` — current session ID

You can also include shell output inline: `` !`cat some-file.txt` `` executes at
skill load time and injects the result.

---

## Step 4: Add Safety Hooks (Optional)

Hooks are JavaScript scripts triggered at lifecycle points. Use them for domain-specific
safety guardrails.

### hooks/hooks.json

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "node ${CLAUDE_PLUGIN_ROOT}/scripts/your-guard.js"
          }
        ],
        "description": "Block dangerous domain-specific operations"
      }
    ]
  }
}
```

### Available Hook Events

| Event | When it fires | Common use |
|-------|--------------|------------|
| `SessionStart` | Session begins | Load context |
| `Stop` | Claude finishes responding | Cost tracking, evaluation |
| `PreToolUse` | Before tool execution | Safety guards (can block) |
| `PostToolUse` | After tool succeeds | Logging, state updates |
| `SubagentStart` | Subagent spawned | Monitor delegation |
| `SubagentStop` | Subagent finishes | Capture results |
| `PreCompact` | Before context compaction | Save state |
| `PostCompact` | After compaction | Restore state |
| `WorktreeCreate` | Worktree being created | Setup |
| `WorktreeRemove` | Worktree being removed | Cleanup |

### Hook Script Patterns

Follow the same patterns used in core's `scripts/` directory:

- **Profile gating:** Only run on `strict` profile so the hook doesn't interfere with
  casual use. Use core's `run-with-profile.js` or check internally:

  ```javascript
  const profile = (process.env.AGENT_HOOK_PROFILE || 'standard').trim().toLowerCase();
  if (profile !== 'strict') process.exit(0);
  ```

- **Read stdin for context:** PreToolUse hooks receive the tool input as JSON on stdin.
  Parse it to inspect what the agent is about to do.

- **Exit codes:** `0` = allow, `2` = block the tool call.

- **Fail open:** If your guard can't parse the input, exit 0. Don't block the agent
  on guard failures.

- **Drain stdin:** Stop hooks receive JSON on stdin. Always consume it to avoid broken
  pipe errors, even if you don't use the data (see core's `cost-tracker.js`).

- **No dependencies:** Plain Node.js only. No npm packages, no build step.

---

## Step 5: Create the Init Skill

Every domain pack needs an `init` skill that layers on top of core. It must:

1. **Check prerequisites** — core must be initialized first
2. **Be idempotent** — don't duplicate if run twice
3. **Append to CLAUDE.md** — add domain-specific instructions

### skills/init/SKILL.md

```markdown
---
name: init
description: Initialize DOMAIN pack in the current project. Requires claude-code-hermit core.
---
# Initialize DOMAIN Pack

## Prerequisites

Check that `.claude/.claude-code-hermit/` exists. If not, tell the operator:
"Run `/claude-code-hermit:init` first — the core plugin must be initialized before
the DOMAIN pack."

## Idempotency

Check if CLAUDE.md already contains the marker comment
`<!-- claude-code-DOMAIN-hermit: DOMAIN Workflow -->`. If found, report
"DOMAIN pack already initialized" and stop.

## Actions

1. Read `${CLAUDE_PLUGIN_ROOT}/state-templates/CLAUDE-APPEND.md`
2. Append its contents to the project's `CLAUDE.md`
3. Report what was added: agents, skills, hooks
```

---

## Step 6: Write CLAUDE-APPEND.md

This file is appended to the target project's `CLAUDE.md` during init. It tells the
agent about the domain pack's capabilities.

### state-templates/CLAUDE-APPEND.md

```markdown
---

<!-- claude-code-DOMAIN-hermit: DOMAIN Workflow -->

## DOMAIN Subagents (claude-code-DOMAIN-hermit)

| Agent | When to use | Model |
|-------|------------|-------|
| `agent-1` | Description | Haiku |
| `agent-2` | Description | Sonnet |

## DOMAIN Safety Rules

- [Domain-specific forbidden actions]
- [Guardrails the agent must follow]

## DOMAIN Quick Reference

- Session: `/claude-code-DOMAIN-hermit:domain-session`
- Init: `/claude-code-DOMAIN-hermit:init`
```

The marker comment (`<!-- claude-code-DOMAIN-hermit: ... -->`) is used by the init skill
for idempotency checks. This is the same pattern core uses.

---

## Step 7: Test Locally

Before publishing, test your pack against a target project:

```bash
cd /path/to/target-project

# Load core + your pack from local directories
claude --plugin-dir /path/to/claude-code-hermit --plugin-dir /path/to/your-pack

# Initialize core first, then your pack
/claude-code-hermit:init
/claude-code-DOMAIN-hermit:init
```

Verify:
- Init detects core prerequisite and appends CLAUDE-APPEND.md
- Running init twice is idempotent (no duplicate content)
- Your agents are available for delegation
- Your skills appear in the `/` menu
- Hooks fire at the expected lifecycle points (check stderr output)

---

## Step 8: Publish

```bash
# Create the repo
gh repo create your-org/claude-code-DOMAIN-hermit --public
git push -u origin main

# Users install with:
claude plugin marketplace add your-org/claude-code-DOMAIN-hermit
claude plugin install claude-code-DOMAIN-hermit@claude-code-DOMAIN-hermit --scope project
/claude-code-DOMAIN-hermit:init
```

---

## Design Checklist

Before publishing:

- [ ] Plugin manifest (`.claude-plugin/plugin.json`) has `name`, `version`, `description`
- [ ] Every agent has `disallowedTools` — no agent gets unrestricted tool access
- [ ] Destructive agents use `isolation: worktree` or have explicit safety rules
- [ ] Init skill checks for core prerequisite and is idempotent
- [ ] CLAUDE-APPEND.md has a marker comment for idempotency
- [ ] Hooks are profile-gated (don't fire on `minimal` unless safety-critical)
- [ ] Safety hooks fail open (exit 0 on parse errors, not exit 2)
- [ ] Zero dependencies — no `package.json`, no build step
- [ ] All scripts handle missing state files gracefully (exit 0, no crash)
- [ ] All workflows use `skills/` (Claude Code's current standard)
