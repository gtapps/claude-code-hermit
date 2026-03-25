# Creating a Project-Specific Agent

This guide walks through customizing claude-code-hermit into a purpose-built autonomous agent for your project.

---

## 1. Install and Initialize

```bash
# Install the plugin
cd /path/to/your/project
claude plugin marketplace add gtapps/claude-code-hermit
claude plugin install claude-code-hermit@claude-code-hermit --scope project

# Start Claude Code and initialize
claude
/claude-code-hermit:init
```

After init, your project has the state directory at `.claude/.claude-code-hermit/` with sessions, proposals, templates, and `OPERATOR.md`.

---

## 2. Customize OPERATOR.md

`.claude/.claude-code-hermit/OPERATOR.md` is the single file that turns a generic agent into *your* agent. Open it and fill in every section:

- **Project** -- What is this codebase? Who are you? What is the current goal?
- **Constraints** -- Hard rules the agent must never violate (e.g., "never modify the payments table without approval").
- **Sensitive Areas** -- Directories or files the agent should avoid touching.
- **Naming Conventions** -- Branch format, commit style, variable casing, file naming.
- **External Dependencies** -- APIs, services, where credentials live (never the credentials themselves).
- **Operator Preferences** -- How verbose you want updates, risk tolerance, review cadence.

The agent reads `OPERATOR.md` at every session start. Keep it current. If your project evolves, update this file -- it is the living contract between you and the agent.

> **Note:** `OPERATOR.md` lives inside your project at `.claude/.claude-code-hermit/OPERATOR.md`, not in the plugin repo.

---

## 3. Add Project-Specific Subagents

### When to add a custom agent

Add a new agent when you have a recurring task that:

- Requires a specific set of tools and permissions
- Benefits from a focused system prompt
- Would otherwise clutter the main orchestrator's context

The built-in agent (`session-mgr`) handles session lifecycle. Domain packs add specialized agents — for example, `claude-code-dev-hermit` provides `repo-mapper`, `implementer`, and `reviewer` for software development. Project-specific agents handle domain tasks. For the full list of built-in skills, see [SKILLS.md](SKILLS.md).

### How to define one

Create a markdown file in your project's `.claude/agents/` directory with a YAML frontmatter block and a system prompt body. These are your project's own agents, separate from the plugin's bundled agents.

```
your-project/.claude/agents/db-migrator.md
```

```markdown
---
name: db-migrator
description: Creates and validates database migrations. Use when the task involves schema changes, new tables, or index modifications.
model: sonnet
effort: high
maxTurns: 30
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
You are a database migration specialist.

## Before Starting

1. Read the current schema from `db/schema.sql` (or your ORM's schema file)
2. Check `OPERATOR.md` for any constraints on the database
3. Review recent migrations in `db/migrations/` for naming and style conventions

## While Working

- Generate both `up` and `down` migrations
- Validate SQL syntax before committing
- Never drop columns or tables without explicit operator approval
- Add appropriate indexes for any new foreign keys

## When Done

Return a summary of:
- Tables/columns affected
- Whether the migration is reversible
- Any data backfill requirements
```

### Referencing the new agent

Once the file exists in your project's `.claude/agents/`, the main orchestrator can delegate to it by name. You can also reference it from your project's `CLAUDE.md` by adding it to the Subagent Usage table.

---

## 4. Add Project-Specific Skills

### When to add a skill

Skills are for **operator-triggered workflows** -- things you invoke explicitly with a slash command. Add a skill when you have a repeatable multi-step process that should always run the same way.

### How to define one

Create a directory in your project's `.claude/skills/` containing a `SKILL.md` file. These are your project's own skills, separate from the plugin's bundled skills.

```
your-project/.claude/skills/deploy/SKILL.md
```

```markdown
---
name: deploy
description: Deploys the current branch to the specified environment. Runs tests, builds, and pushes. Use with /deploy <environment>.
---
# Deploy Skill

When the operator runs `/deploy <environment>`:

1. Validate that `<environment>` is one of: `staging`, `production`
2. Run the full test suite: `npm test`
   - If tests fail, stop and report the failures. Do not proceed.
3. Run the build: `npm run build`
4. If environment is `staging`:
   - Run `./scripts/deploy-staging.sh`
   - Report the deploy URL
5. If environment is `production`:
   - Ask for explicit confirmation: "You are about to deploy to production. Type YES to proceed."
   - Only after confirmation, run `./scripts/deploy-production.sh`
6. Update `sessions/ACTIVE.md` with a timestamped deploy entry
```

### Naming convention

The directory name becomes the slash command: `.claude/skills/deploy/` maps to `/deploy`. Plugin skills are namespaced (e.g., `/claude-code-hermit:session-start`), but your project's own skills are not.

---

## 5. Adjust Hook Profiles

The plugin ships with three hook profiles controlled by the `AGENT_HOOK_PROFILE` environment variable in your project's `.claude/settings.json`:

| Profile    | What it does                                                        | Best for                          |
|------------|---------------------------------------------------------------------|-----------------------------------|
| `minimal`  | Cost tracking only                                                  | Exploration, low-stakes work      |
| `standard` | Cost tracking + compact suggestions + session evaluation            | Day-to-day development (default)  |
| `strict`   | All of standard + additional safety hooks from domain packs          | Production repos, shared codebases|

To change the profile, edit `.claude/settings.json`:

```json
{
  "env": {
    "AGENT_HOOK_PROFILE": "strict"
  }
}
```

You can also add your own hooks via your project's `.claude/settings.json` or `.claude/settings.local.json`. Each hook is a Node.js script invoked at a specific lifecycle point (`SessionStart`, `Stop`, `PreToolUse`, `PostToolUse`). See the plugin's `scripts/` directory for examples.

---

## 6. Domain Packs

The plugin is intentionally generic. It provides session discipline, subagent delegation, and hook infrastructure -- but no domain-specific agents or skills.

Each project adds its own:

- **Agents** for domain tasks (migrations, API testing, security scanning)
- **Skills** for operator workflows (deploy, release, onboard)
- **OPERATOR.md** context for project-specific constraints

**Domain packs** extend the base plugin with pre-built sets of agents, skills, and hooks for specific domains. The first domain pack is `claude-code-dev-hermit`, which adds the `repo-mapper`, `implementer`, and `reviewer` agents, the `dev-session` and `dev-parallel` skills, and the `git-push-guard` safety hook for software development workflows. Domain packs are installed separately on top of the base plugin, not baked in.

When you run `/claude-code-hermit:init`, the init wizard automatically detects installed domain packs by scanning sibling plugin directories for matching names. If a pack is found, you're asked whether to activate it for the current project. Activation appends the pack's CLAUDE.md additions to your project.

---

## 7. Example: "my-saas-agent"

Walk-through of creating an agent for a billing SaaS application.

### Step 1: Install and initialize

```bash
cd my-saas-project
claude plugin marketplace add gtapps/claude-code-hermit
claude plugin install claude-code-hermit@claude-code-hermit --scope project
claude
/claude-code-hermit:init
```

### Step 2: Customize OPERATOR.md

```markdown
# Operator Context

## Project
A multi-tenant billing SaaS (Node.js + PostgreSQL). I'm the sole engineer.
Goal: ship Stripe integration and usage-based billing by end of Q2.

## Constraints
- Never modify `src/billing/ledger.ts` without explicit approval -- it handles financial calculations.
- Never DROP or ALTER existing tables without a reversible migration.
- Monthly Claude budget: $150. Alert at $120.

## Sensitive Areas
- `infrastructure/` -- managed by Terraform, do not touch.
- `src/auth/` -- security-critical, always flag changes for review.
- `.env*` files -- never read or write credentials.

## Naming Conventions
- Branches: `feature/TICKET-short-desc` or `fix/TICKET-short-desc`
- Commits: conventional commits (`feat:`, `fix:`, `refactor:`, `test:`)
- Files: kebab-case for everything except React components (PascalCase)

## External Dependencies
- Stripe API -- keys in `.env` (gitignored). Docs: https://stripe.com/docs/api
- PostgreSQL -- local via Docker Compose, staging on AWS RDS.
- Redis -- used for job queues. Connection config in `src/config/redis.ts`.

## Operator Preferences
- Concise updates. Don't explain what you're about to do -- just do it and report.
- Ask before any destructive action (DB drops, force pushes, dependency removal).
- I review all PRs before merge. Create the PR but don't merge.
```

### Step 3: Add a "billing-validator" agent

Create `my-saas-project/.claude/agents/billing-validator.md`:

```markdown
---
name: billing-validator
description: Validates billing logic changes against the ledger invariants. Use after any modification to billing-related code.
model: sonnet
effort: high
maxTurns: 20
tools:
  - Read
  - Bash
  - Glob
  - Grep
disallowedTools:
  - Write
  - Edit
  - WebSearch
  - WebFetch
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

### Step 4: Add a "deploy-staging" skill

Create `my-saas-project/.claude/skills/deploy-staging/SKILL.md`:

```markdown
---
name: deploy-staging
description: Deploys the current branch to the staging environment after running tests and build.
---
# Deploy to Staging

1. Run the test suite: `npm test`
   - If any test fails, stop and report. Do not deploy.
2. Run the build: `npm run build`
   - If the build fails, stop and report.
3. Run `docker compose -f docker-compose.staging.yml up -d --build`
4. Wait 10 seconds, then hit the health check: `curl -sf http://staging.internal/health`
5. Report the result:
   - Success: "Deployed to staging. Health check passed."
   - Failure: "Deploy failed at step N." with the error output.
6. Update `.claude/.claude-code-hermit/sessions/ACTIVE.md` with a deploy entry.
```

### Step 5: Update CLAUDE.md subagent table

Add the new agent to the Subagent Usage table in your project's `CLAUDE.md`:

```markdown
| `billing-validator` | After billing code changes | Sonnet |
```

### Step 6: Set hook profile to strict

Since this handles financial data:

```json
{
  "env": {
    "AGENT_HOOK_PROFILE": "strict"
  }
}
```

### Result

You now have a purpose-built billing SaaS agent with:

- Domain context in `OPERATOR.md`
- A read-only validator agent for billing invariants
- A one-command staging deploy skill
- Strict hooks to prevent accidental pushes to main
- All the session discipline, progress tracking, and proposal infrastructure from claude-code-hermit
