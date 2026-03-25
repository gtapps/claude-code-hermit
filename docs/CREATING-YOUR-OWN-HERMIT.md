# Create Your Own Hermit

Hermit core handles sessions, proposals, cost tracking, and operational hygiene. It knows
nothing about your domain. This guide covers how to make it yours — from quick
project-level customization to building a reusable hermit others can install.

**Two paths, one goal:**

- **Project-level** — Drop agent and skill files into your project's `.claude/` directory.
  No separate repo, no publishing. This is how most people customize hermit.
- **Reusable hermit** — Package agents, skills, and hooks into a standalone Claude
  Code plugin. Install it across multiple projects, share it with others.

Start with project-level. Graduate to a reusable plugin when you find yourself copying
the same agents between projects.

> For Claude Code's plugin system (agents, skills, hooks, frontmatter fields):
> [code.claude.com/docs/en/plugins](https://code.claude.com/docs/en/plugins)

---

## Project-Level Customization

### OPERATOR.md — Shape the Agent's Judgment

`.claude/.claude-code-hermit/OPERATOR.md` is the single file that turns a generic agent
into *your* agent. The agent reads it at the start of every session. Be specific: budget
limits, off-limits directories, naming conventions, communication preferences. The more
precise your constraints, the better the agent performs.

See [HOW-TO-USE.md, Section 4](HOW-TO-USE.md#4-understanding-operatormd) for detailed
guidance and examples.

### Adding Agents

Add an agent when you have a recurring task that needs a focused system prompt, a specific
set of tools, or would otherwise clutter the main orchestrator's context. Create a
markdown file in `.claude/agents/` with YAML frontmatter and a system prompt body.

**Hermit-specific conventions:**

- Always include `disallowedTools` — no agent should get unrestricted tool access
- Use `memory: project` so the agent accumulates lessons across sessions
- Read `OPERATOR.md` in the "Before Starting" section for project constraints
- Use `isolation: worktree` for agents that modify files — changes only reach main
  after explicit merge
- Match model to complexity: Haiku for scanning/listing, Sonnet for reasoning/writing

**Example** — a database migration specialist:

```markdown
---
name: db-migrator
description: Creates and validates database migrations. Use when the task involves schema changes.
model: sonnet
maxTurns: 30
tools: [Read, Write, Edit, Bash, Glob, Grep]
disallowedTools: [WebSearch, WebFetch]
memory: project
---
You are a database migration specialist.

## Before Starting

1. Read the current schema from `db/schema.sql`
2. Check `OPERATOR.md` for database constraints
3. Review recent migrations in `db/migrations/` for naming conventions

## While Working

- Generate both `up` and `down` migrations
- Never drop columns or tables without explicit operator approval

## When Done

Return: tables affected, reversibility, any data backfill needed
```

Once the file exists, the main orchestrator can delegate to it by name.

### Adding Skills

Skills are for repeatable multi-step workflows you invoke with a slash command. Create a
directory in `.claude/skills/` with a `SKILL.md` file. The directory name becomes the
command: `.claude/skills/deploy/` → `/deploy`.

**Hermit-specific conventions:**

- Plugin skills are namespaced (`/claude-code-hermit:session-start`), but your project's
  own skills are not — just `/deploy`
- Update `sessions/SHELL.md` with a timestamped entry when the skill does something
  significant (deploy, migration, release)

**Example** — a staging deploy:

```markdown
---
name: deploy
description: Deploys the current branch to staging or production. Use with /deploy <environment>.
---
# Deploy

1. Validate `$1` is `staging` or `production`
2. Run `npm test` — stop on failure
3. Run `npm run build`
4. If production: ask for explicit confirmation first
5. Run `./scripts/deploy-$1.sh`
6. Update `sessions/SHELL.md` with a deploy entry
```

---

### Walkthrough: Billing SaaS Hermit

A complete example of turning hermit into a purpose-built billing specialist.

#### OPERATOR.md

```markdown
# Operator Context

## Project
A multi-tenant billing SaaS (Node.js + PostgreSQL). I'm the sole engineer.
Goal: ship Stripe integration and usage-based billing by end of Q2.

## Constraints
- Never modify `src/billing/ledger.ts` without explicit approval — it handles financial calculations.
- Never DROP or ALTER existing tables without a reversible migration.
- Monthly Claude budget: $150. Alert at $120.

## Sensitive Areas
- `infrastructure/` — managed by Terraform, do not touch.
- `src/auth/` — security-critical, always flag changes for review.
- `.env*` files — never read or write credentials.

## Naming Conventions
- Branches: `feature/TICKET-short-desc` or `fix/TICKET-short-desc`
- Commits: conventional commits (`feat:`, `fix:`, `refactor:`, `test:`)
- Files: kebab-case for everything except React components (PascalCase)

## Operator Preferences
- Concise updates. Don't explain what you're about to do — just do it and report.
- Ask before any destructive action (DB drops, force pushes, dependency removal).
- I review all PRs before merge. Create the PR but don't merge.
```

#### A read-only billing validator agent

`my-saas-project/.claude/agents/billing-validator.md`:

```markdown
---
name: billing-validator
description: Validates billing logic changes against the ledger invariants. Use after any modification to billing-related code.
model: sonnet
maxTurns: 20
tools: [Read, Bash, Glob, Grep]
disallowedTools: [Write, Edit, WebSearch, WebFetch]
memory: project
---
You are a billing logic validator. Your job is read-only: verify that changes
to billing code maintain the ledger invariants.

## Invariants to Check

1. Every charge must have a corresponding ledger entry
2. Credits and debits must balance per tenant per billing period
3. Stripe webhook handlers must be idempotent
4. Usage records must reference a valid subscription and meter

## Process

1. Read the changed files provided by the caller
2. Trace the data flow from the change point to the ledger
3. Run `npm run test:billing` to verify the billing test suite passes
4. Report: PASS (all invariants hold) or FAIL (list violations)

## Rules

- Never modify any files. You are read-only.
- If you find a violation, describe it precisely with file, line, and the invariant it breaks.
```

#### Set strict hooks (financial data warrants it)

```json
{
  "env": {
    "AGENT_HOOK_PROFILE": "strict"
  }
}
```

#### The result

A purpose-built billing hermit with domain context in OPERATOR.md, a read-only
validator for billing invariants, strict hooks to prevent accidental pushes to main,
and all the session discipline from hermit core.

---

## Building a Reusable Hermit

When you find yourself copying the same agents and skills between projects, package them
as a reusable hermit — a standalone Claude Code plugin that anyone can install alongside
core.

> For the full Claude Code plugin system (manifests, structure, publishing):
> [code.claude.com/docs/en/plugins](https://code.claude.com/docs/en/plugins)

This section covers only the hermit-specific patterns.

### How Core and Your Hermit Interact

Your hermit layers on top of core. Core handles session lifecycle (SHELL.md,
archival, cost tracking, session evaluation). Your hermit handles domain-specific work.

```
/claude-code-hermit:session-start  →  your domain workflow  →  /claude-code-hermit:session-close
```

**Hook profiles:** Core defines three profiles (`minimal`, `standard`, `strict`). Your
hooks participate in this system. Safety hooks gate to `strict`, quality hooks to
`standard,strict`, essential hooks run on all profiles. Use core's `run-with-profile.js`
wrapper or check `AGENT_HOOK_PROFILE` internally.

**SHELL.md sections:** Your agents write to Plan, Progress Log, Blockers, and
Findings during work. Core manages Task, Changed (via session-diff hook), and
Cost (via cost-tracker hook).

### Naming Convention

`claude-code-{domain}-hermit`. Examples:
`claude-code-data-hermit`, `claude-code-infra-hermit`, `claude-code-docs-hermit`.

### Required Files

Beyond the standard Claude Code plugin structure, a hermit needs:

| File | Purpose |
|---|---|
| `skills/init/SKILL.md` | **Required.** Checks core prerequisite, appends CLAUDE-APPEND.md, is idempotent |
| `state-templates/CLAUDE-APPEND.md` | **Required.** Instructions appended to CLAUDE.md — subagent table, safety rules, quick reference |
| `skills/domain-session/SKILL.md` | Recommended. Bookends with core's session-start/session-close |

### Init Skill Pattern

Every hermit needs an `init` skill that:

1. **Checks core prerequisite** — `.claude/.claude-code-hermit/` must exist
2. **Is idempotent** — check for a marker comment in CLAUDE.md before appending
3. **Appends CLAUDE-APPEND.md** — tells the agent about your hermit's capabilities

```markdown
---
name: init
description: Initialize DOMAIN hermit. Requires claude-code-hermit core.
---
# Initialize DOMAIN Hermit

Check that `.claude/.claude-code-hermit/` exists. If not:
"Run `/claude-code-hermit:init` first."

Check if CLAUDE.md contains `<!-- claude-code-DOMAIN-hermit: DOMAIN Workflow -->`.
If found: "Already initialized." Stop.

Otherwise:
1. Read `${CLAUDE_PLUGIN_ROOT}/state-templates/CLAUDE-APPEND.md`
2. Append to CLAUDE.md
3. Report what was added
```

### CLAUDE-APPEND.md Pattern

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

## DOMAIN Quick Reference

- Session: `/claude-code-DOMAIN-hermit:domain-session`
- Init: `/claude-code-DOMAIN-hermit:init`
```

The marker comment is the idempotency key — same pattern core uses.

### Session Skill Pattern

Your main skill should bookend with core's lifecycle:

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
2. [Quality gates]

## On Session Close
1. [Domain-specific cleanup]
2. Run `/claude-code-hermit:session-close`
```

### Hook Patterns

Follow core's `scripts/` directory as the reference implementation:

- **Profile gating** — safety hooks gate to `strict`, quality hooks to `standard,strict`
- **Fail open** — if your guard can't parse the input, exit 0. Don't block on failures
- **Drain stdin** — Stop hooks must consume stdin to avoid broken pipe errors
- **No dependencies** — plain Node.js only, no npm packages

### Testing Locally

```bash
cd /path/to/target-project
claude --plugin-dir /path/to/claude-code-hermit --plugin-dir /path/to/your-hermit

/claude-code-hermit:init
/claude-code-DOMAIN-hermit:init
```

Verify: init is idempotent, agents are available, skills appear in `/` menu, hooks fire
at expected lifecycle points.

---

## Design Checklist

Before publishing a reusable hermit:

- [ ] Every agent has `disallowedTools` — no unrestricted tool access
- [ ] Destructive agents use `isolation: worktree` or explicit safety rules
- [ ] Init skill checks for core and is idempotent
- [ ] CLAUDE-APPEND.md has a marker comment
- [ ] Hooks are profile-gated
- [ ] Safety hooks fail open (exit 0 on parse errors)
- [ ] Zero dependencies — no `package.json`, no build step
- [ ] All scripts handle missing state files gracefully (exit 0)
