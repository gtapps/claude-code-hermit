# Creating Your Own Hermit

Every Hermit is yours from the moment you run `/claude-code-hermit:hatch`. This guide covers how to shape it — from editing a single file to packaging a reusable plugin.

---

## Start Anywhere

An existing codebase, an empty folder for a personal assistant, a research project — `/claude-code-hermit:hatch` adapts to whatever it finds. The wizard scans your folder, asks a few questions, and generates an `OPERATOR.md` that shapes how your hermit works for you.

That's the first customization lever, and for most people it's the only one they need.

---

## OPERATOR.md — The 80% Case

`OPERATOR.md` is how you turn a generic assistant into _your_ assistant. Budget limits, off-limits directories, naming conventions, communication preferences — write it once, your hermit reads it every session.

See [Getting Started](how-to-use.md#operatormd) for the good/bad examples and formatting tips.

---

## Let Your Hermit Suggest What It Needs

You don't have to design capabilities upfront. After a few sessions, ask:

- **"Suggest specialized agents for this project."** — Your hermit reviews its experience and proposes agents based on the kind of work you've been doing. A project heavy on database changes might get a migration specialist. One that keeps hitting CI failures might get a test reviewer.
- **"What would make you more efficient here?"** — Might suggest workflow changes, new skills, or configuration tweaks.
- **"Create a self-improvement proposal."** — Formalizes its suggestions into a proposal you can accept or reject.

You approve, it creates the files. The specialization emerges from how you actually work.

---

## Adding Agents Manually

For when you know exactly what you want. Create a markdown file in `.claude/agents/` with YAML frontmatter and a system prompt.

```markdown
---
name: db-migrator
description: Creates and validates database migrations. Use for schema changes.
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

## While Working

- Generate both `up` and `down` migrations
- Never drop columns without explicit operator approval

## When Done

Return: tables affected, reversibility, any data backfill needed
```

Once the file exists, your hermit can delegate to it by name. For more on [sub-agents](https://code.claude.com/docs/en/sub-agents), see the Claude Code docs.

**Conventions:** Always include `disallowedTools`. Use `memory: project` so it learns across sessions. Use `isolation: worktree` for agents that modify files. Match model to complexity: Haiku for scanning, Sonnet for reasoning.

---

## Adding Skills

Skills are multi-step workflows invoked with a slash command. Create a directory in `.claude/skills/` with a `SKILL.md` file — the directory name becomes the command.

`.claude/skills/deploy/SKILL.md` -> `/deploy`:

```markdown
---
name: deploy
description: Deploys the current branch to staging or production.
---

# Deploy

1. Validate `$1` is `staging` or `production`
2. Run `npm test` — stop on failure
3. Run `npm run build`
4. If production: ask for confirmation
5. Run `./scripts/deploy-$1.sh`
6. Update SHELL.md with a deploy entry
```

For more on [skills](https://code.claude.com/docs/en/skills), see the Claude Code docs.

---

## Building a Reusable Hermit

When you're copying the same agents between projects, package them as a [Claude Code plugin](https://code.claude.com/docs/en/plugins).

### Naming

`claude-code-{domain}-hermit`. Examples: `claude-code-data-hermit`, `claude-code-infra-hermit`.

### How it layers on core

Your hermit handles domain-specific work. Core handles session lifecycle.

```
/claude-code-hermit:session-start -> your domain workflow -> /claude-code-hermit:session-close
```

### Required files

| File                               | Purpose                                                            |
| ---------------------------------- | ------------------------------------------------------------------ |
| `skills/hatch/SKILL.md`      | Checks core prerequisite, appends CLAUDE-APPEND.md, is idempotent |
| `state-templates/CLAUDE-APPEND.md` | Agent table, safety rules, quick reference — appended to CLAUDE.md |
| `skills/domain-session/SKILL.md`   | Your main workflow, bookended with core's session lifecycle        |

### Init pattern

Every hermit needs an init that checks for core and is idempotent:

```markdown
---
name: init
description: Initialize DOMAIN hermit. Requires claude-code-hermit core.
---

Check that `.claude-code-hermit/` exists. If not: "Run `/claude-code-hermit:hatch` first."
Check if CLAUDE.md contains the marker comment. If found: "Already initialized." Stop.
Otherwise: read and append CLAUDE-APPEND.md.
```

### Hook patterns

Follow core's `scripts/` directory as reference. Profile-gate safety hooks to `strict`, quality hooks to `standard,strict`. Fail open (exit 0 on parse errors). Drain stdin. No npm dependencies.

### Docker dependencies

If your hermit needs system packages in Docker (e.g., a database client, media tools), append them to `docker.packages` in your init skill:

1. Read `.claude-code-hermit/config.json`
2. Add your packages to `docker.packages` (deduplicate against existing entries)
3. Write back config.json
4. Note to the operator: "Added [packages] to docker.packages — rebuild your container if using Docker."

The `/docker-setup` skill reads `docker.packages` and includes them in the generated Dockerfile as a separate layer. Operators can also manage packages via `/hermit-settings docker`.

### Operator notification routing

Skills should say "notify the operator" instead of referencing specific channels. Core's CLAUDE-APPEND.md includes a routing section that handles delivery transparently: conversation output in interactive mode, channel `reply` tool in always-on mode. This keeps your hermit plugin channel-agnostic.

### Checklist before publishing

- [ ] Every agent has `disallowedTools`
- [ ] Destructive agents use `isolation: worktree`
- [ ] Init checks for core and is idempotent
- [ ] CLAUDE-APPEND.md has a marker comment
- [ ] Skills use "notify the operator" instead of channel-specific references
- [ ] Hooks are profile-gated
- [ ] Zero dependencies — no `package.json`, no build step
- [ ] All scripts handle missing state files gracefully
