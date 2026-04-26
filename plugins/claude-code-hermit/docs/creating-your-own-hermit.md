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

| File                                  | Purpose                                                            |
| ------------------------------------- | ------------------------------------------------------------------ |
| `skills/hatch/SKILL.md`               | Optional — setup/init skill. Checks core prerequisite, appends CLAUDE-APPEND.md, is idempotent |
| `state-templates/CLAUDE-APPEND.md`    | Agent table, safety rules, quick reference — appended to CLAUDE.md |
| `skills/domain-session/SKILL.md`      | Your main workflow, bookended with core's session lifecycle        |

### Hatch pattern (optional)

Only needed if your hermit has setup steps beyond what core's `/claude-code-hermit:hatch` does (e.g. appending a domain CLAUDE-APPEND.md, creating extra state dirs, registering scheduled_checks). If your plugin is a thin layer of agents/skills with no setup needed, skip this entirely.

Name the skill simply `hatch` — the plugin namespace already disambiguates it from core's hatch (`/claude-code-your-domain-hermit:hatch` vs `/claude-code-hermit:hatch`).

```markdown
---
name: hatch
description: Initialize your domain hermit. Requires claude-code-hermit core.
---

Check that `.claude-code-hermit/` exists. If not: "Run `/claude-code-hermit:hatch` first."
Check if CLAUDE.md contains the marker comment. If found: "Already initialized." Stop.
Otherwise: read and append CLAUDE-APPEND.md.
```

### Custom boot skill

If your hermit needs to run domain-specific setup on every always-on launch (e.g. connectivity probe, context refresh, pulling a live snapshot), declare a boot skill and wire it via your plugin manifest. Core's `hermit-start.py` will fire it into the tmux REPL at boot instead of the default `/claude-code-hermit:session`.

1. **Write the boot skill** — a normal skill at `skills/<your>-boot/SKILL.md`. First line of the skill's plan must invoke core session init: `/claude-code-hermit:session-start`. After that, run your domain setup. Example from `claude-code-homeassistant-hermit`:

   ```markdown
   1. Invoke /claude-code-hermit:session-start
   2. Run ${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab boot status --probe
   3. If stale, refresh HA context
   ```

2. **Declare it in your plugin manifest** — add a `hermit` block to `.claude-plugin/plugin.json`:

   ```json
   {
     "name": "claude-code-homeassistant-hermit",
     "version": "0.3.0",
     "hermit": {
       "boot_skill": "/claude-code-homeassistant-hermit:ha-boot"
     }
   }
   ```

   Core's `hatch` reads `hermit.boot_skill` when the operator activates your hermit and writes it to the project's `config.json` as a top-level `boot_skill` field. `hermit-start.py` then substitutes it for the default bootstrap on every launch — local tmux and Docker alike.

**Contract:** your boot skill owns the full bootstrap turn. Core does not call `session-start` before invoking it; your skill must. This keeps composition in the skill layer so core's boot script stays domain-agnostic.

**Opt-out:** omit `hermit.boot_skill` entirely if your hermit has no launch-time setup. Core's default bootstrap (`/claude-code-hermit:session`) runs instead.

**Operator override:** operators can change or clear the boot skill via `/claude-code-hermit:hermit-settings boot-skill` — useful if they install multiple domain hermits and need to pick one, or want to temporarily disable domain bootstrap.

### Hook patterns

Follow core's `scripts/` directory as reference. Profile-gate safety hooks to `strict`, quality hooks to `standard,strict`. Fail open (exit 0 on parse errors). Drain stdin. No npm dependencies.

### Docker dependencies

If your hermit needs system packages in Docker (e.g. `python3-yaml`, `postgresql-client`), declare them with a `## Docker apt dependencies` section in your `hatch` SKILL.md or in a `DOCKER.md` file at the plugin root:

```markdown
## Docker apt dependencies

- python3-yaml
- python3-dotenv
```

Rules: one Debian-bookworm package name per bullet; names must match `^[a-z0-9][a-z0-9+\-.]+$`. Lines starting with `#` are ignored.

During `/docker-setup`, the wizard reads this section for every mirrored plugin, validates the names, and presents them to the operator in a unified confirmation prompt alongside the project-level signal scan. Approved packages are baked into `Dockerfile.hermit` at build time — no runtime venv or post-install scripts needed.

**Scope:** declare only packages your plugin's own scripts need (hermit-owned). Do not declare the user's project's build deps (e.g. `libsqlite3-dev` for a native addon) — those are live-scanned from the project tree each time `/docker-setup` runs and would drift if declared statically in your plugin.

**Why not write to `docker.packages` from your hatch?** The plugin directory lives in Docker's `claude-config` named volume, which is wiped on `docker compose down -v`, plugin updates, and fresh installs. Anything written there (venvs, caches, stamps) is ephemeral. Using the declaration convention bakes deps into the image at build time, making them permanent and removing the need for runtime installation.

Operators can review and adjust the approved package list via `/hermit-settings docker`.

### Knowledge outputs

All domain artifacts must live in exactly two directories — `raw/` and `compiled/`. See **[`docs/plugin-hermit-storage.md`](plugin-hermit-storage.md)** for the full convention, compliant/non-compliant path examples, and a reviewer checklist.

Short version:

- **`raw/<type>-<slug>-<date>.md`** — ephemeral inputs (API data, snapshots, logs). Archived after `knowledge.raw_retention_days`.
- **`compiled/<type>-<slug>-<date>.md`** — durable outputs (briefings, decisions, audit results). Injected into session context at startup within `compiled_budget_chars`.

**Never create new top-level folders inside `.claude-code-hermit/`** (no `audits/`, `reports/`, `reviews/`, `memory/`, `tmp/`). **Never add subdirectories inside `raw/` or `compiled/`** (e.g. `raw/audits/`). Use the `type` field in frontmatter — not the filesystem — to discriminate work products within each directory.

Tag compiled artifacts `foundational` to pin them to every session start regardless of age. Cite the raw source in compiled frontmatter (`source: raw/<type>-<slug>-<date>.md`).

Add a `knowledge-schema.md` to document what your hermit produces and when — this is the behavioral contract operators read. Your `hatch` skill should create `raw/`, `compiled/`, and `raw/.archive/` alongside the core scaffold.

### Periodic skill invocation via reflect

If your hermit has a skill that should run on a cadence (e.g. `ha-analyze-patterns` checking home patterns weekly), register it in `scheduled_checks` instead of building your own scheduler. Reflect picks one due entry per run, invokes your skill, and funnels its output through the proposal pipeline — no extra infrastructure.

**How to register.** Your init/hatch skill appends an entry to `config.json.scheduled_checks` (deduplicate by `id`):

```json
{
  "id": "ha-patterns",
  "plugin": "claude-code-homeassistant-hermit",
  "skill": "claude-code-homeassistant-hermit:ha-analyze-patterns",
  "enabled": true,
  "trigger": "interval",
  "interval_days": 7
}
```

Full schema: [`config-reference.md#scheduled_checks`](config-reference.md#scheduled_checks).

**Contract your skill must honor** (reflect's auto-tuning depends on it):

- **Idempotent** — reflect may invoke it at any point in an idle cycle.
- **Return actionable findings or nothing** — a finding becomes a proposal candidate tagged `Evidence Source: scheduled-check/<id>`, which **bypasses the cross-session recurrence check** (Three-Condition Rule #1) at every gate. Conditions #2 (meaningful consequence) and #3 (operator-actionable) still apply. Emit nothing when there's nothing to say; reflect's `consecutive_empty` counter drives automatic interval tuning.
- **Don't self-schedule** — `interval_days` is authoritative. Operators raise/lower it via accepted proposals.
- **Fail silently on unavailability** — if a prerequisite is missing, return a clear "skill unavailable" message. Reflect suppresses retries for `interval_days`.

**What you get for free:** operator opt-in at hatch (via recommended-plugins flow, if listed there), `/hermit-settings scheduled-checks` management, interval auto-tuning proposals, and unavailability suppression. No cron, no hook, no state file of your own.

### Operator notification routing

Skills should say "notify the operator" instead of referencing specific channels. Core's CLAUDE-APPEND.md includes a routing section that handles delivery transparently: conversation output in interactive mode, channel `reply` tool in always-on mode. This keeps your hermit plugin channel-agnostic.

### Checklist before publishing

- [ ] Every agent has `disallowedTools`
- [ ] Destructive agents use `isolation: worktree`
- [ ] If present, `hatch` checks for core and is idempotent
- [ ] CLAUDE-APPEND.md has a marker comment
- [ ] Skills use "notify the operator" instead of channel-specific references
- [ ] Hooks are profile-gated
- [ ] Zero dependencies — no `package.json`, no build step
- [ ] All scripts handle missing state files gracefully
- [ ] Cadence-driven skills registered in `scheduled_checks` (not a bespoke scheduler)
- [ ] Docker system packages (if any) declared in a `## Docker apt dependencies` section in the hatch SKILL.md or `DOCKER.md` at plugin root
