# Recommended Plugins

Plugins that complement Hermit's autonomous operation. These are optional — Hermit works fine without them — but they add capabilities that improve self-learning and self-improvement over time.

> **Disclaimer:** Hermit does not vet, audit, or take responsibility for any plugin — including official ones. Plugins run with the same permissions as Hermit. In Docker mode (`bypassPermissions`), this means full unrestricted execution. You are responsible for evaluating any plugin you install. Review the plugin's source, understand what it does, and only install plugins you trust.

Nothing is pre-shipped or pre-configured. During `/docker-setup`, you're asked whether to install each recommended plugin. Only plugins you explicitly opt into are added to your config and installed on container boot. You can manage them anytime with `/hermit-settings docker`.

---

## Official Plugins

### claude-code-setup

**Source:** [claude.com/plugins/claude-code-setup](https://claude.com/plugins/claude-code-setup)
**Marketplace:** `claude-plugins-official` (no marketplace add needed)
**Install:** `claude plugin install claude-code-setup@claude-plugins-official`

Analyzes your codebase and recommends Claude Code automations — skills, hooks, MCP servers, subagents, and slash commands. Detects your tech stack (package.json, language files, directory structure) and surfaces the highest-value recommendations.

**Why it matters for Hermit:** Hermit already reflects on its own experience and proposes improvements. With claude-code-setup installed, it can also analyze your project structure and recommend automations it wouldn't discover through reflection alone — like MCP servers for your database, or hooks for your CI pipeline. This feeds the learning loop: better tooling leads to better sessions, which leads to better proposals.

### claude-md-management

**Source:** [claude.com/plugins/claude-md-management](https://claude.com/plugins/claude-md-management)
**Marketplace:** `claude-plugins-official` (no marketplace add needed)
**Install:** `claude plugin install claude-md-management@claude-plugins-official`

Audits and improves CLAUDE.md files across your project. Scans for all variants, grades quality (A–F), identifies gaps in command documentation, architectural clarity, and project patterns, then proposes targeted fixes — dense, actionable, no generic advice.

Two capabilities:
- **`claude-md-improver`** (skill) — full audit and quality grading. Invoked periodically via scheduled checks (default: weekly).
- **`revise-claude-md`** (command) — lightweight session-end revision, captures learnings into CLAUDE.md. Invoked automatically at task completion.

**Why it matters for Hermit:** CLAUDE.md is Hermit's primary project context. Better CLAUDE.md means better sessions — fewer misunderstandings, less wasted context asking about project structure.

### skill-creator

**Source:** [claude.com/plugins/skill-creator](https://claude.com/plugins/skill-creator)
**Marketplace:** `claude-plugins-official` (no marketplace add needed)
**Install:** `claude plugin install skill-creator@claude-plugins-official`

Builds, tests, and refines new skills through structured iteration — from intent capture through benchmarked, production-ready deployment. Includes performance testing with parallel subagent runs and optimization loops.

**Why it matters for Hermit:** When Hermit's reflect skill notices "this workflow keeps repeating" and creates a proposal, skill-creator gives it the tools to actually build and validate a new skill from that proposal. Closes the loop from observation to automation.

---

## Third-Party Plugins

The entrypoint installs every enabled entry in `docker.recommended_plugins`, regardless of marketplace. This includes domain hermits (e.g. `claude-code-homeassistant-hermit`) and any other third-party plugin.

The safety gate is at **configuration time**: entries only land in `docker.recommended_plugins` when the operator explicitly confirms the mirrored plugin list during `/docker-setup` or `/hermit-settings docker`. The host-installed list is the vetted set — the operator already installed these plugins on the host before triggering docker-setup.

> **Reminder:** Plugins run with the same permissions as Hermit. In Docker mode (`bypassPermissions`), this means full unrestricted execution. Only add plugins you trust.

### Trust model

1. **Preselection safelist.** During `/docker-setup`, only plugins from `claude-plugins-official` or any `gtapps/*` marketplace (hermit's own org) are preselected. Third-party and unknown-source plugins are shown deselected — the operator must explicitly opt in. This prevents careless click-through from auto-installing arbitrary code.

2. **No re-confirmation on rebuild.** Once an entry is in `config.json`, the entrypoint installs it on every fresh volume without prompting again. If a marketplace repo is compromised between the original install and a later rebuild, the container will silently pull the updated version. Review `docker.recommended_plugins` periodically with `/hermit-settings docker`, and remove entries you no longer trust.

3. **`org/repo` validation.** Marketplace sources written to `config.json` must match `^[A-Za-z0-9][\w.-]*/[A-Za-z0-9][\w.-]*$`. Typos or junk values are rejected before landing in config.

### Adding a plugin after initial setup

Use `/hermit-settings docker` to add a plugin to `docker.recommended_plugins`:

```bash
add superpowers obra/superpowers-marketplace
```

Then restart the container to install it:

```bash
.claude-code-hermit/bin/hermit-docker restart
```

---

## Config Format

Each entry in `docker.recommended_plugins`:

| Field | Type | Description |
|-------|------|-------------|
| `marketplace` | string | `"claude-plugins-official"` for official, or `"org/repo"` for third-party |
| `plugin` | string | Plugin name |
| `scope` | string | `"project"` or `"local"` |
| `enabled` | boolean | Install on boot when `true` |

See [Config Reference](config-reference.md#recommended_plugins-entry-schema) for defaults.

---

## Scheduled Checks (Automatic Invocation)

When you accept a recommended plugin during `/hatch` or `/docker-setup`, Hermit adds corresponding `scheduled_checks` entries to `config.json`:

| Plugin | Check ID | Skill Invoked | Trigger | Cadence |
|--------|----------|---------------|---------|---------|
| `claude-code-setup` | `automation-recommender` | `/claude-code-setup:claude-automation-recommender` | `interval` | 7 days |
| `claude-md-management` | `md-audit` | `/claude-md-management:claude-md-improver` | `interval` | 7 days |
| `claude-md-management` | `md-revise` | `/claude-md-management:revise-claude-md` | `session` | At task completion |
| `skill-creator` | _(none)_ | Event-driven via `proposal-act` | — | On demand |

**Interval checks** run during idle reflection. If a check is due (past its `interval_days`), reflect invokes the skill, evaluates the output, and routes actionable findings through the proposal pipeline. One check per reflect cycle.

**Session checks** run at completed task boundaries (before idle transition). All enabled session checks invoke once per task completion.

**Interval tuning:** 3+ consecutive empty runs → propose increasing interval. 3+ actionable findings in a single run → propose decreasing. Always through PROP-NNN.

**Managing checks:** `/hermit-settings scheduled-checks` to view, enable/disable, change intervals, or add checks for any installed plugin's skills. All checks are optional — disable or remove any time.

---

## Managing Plugins

| Task | How |
|------|-----|
| Enable during Docker setup | `/docker-setup` wizard step 7b |
| Enable/disable after setup | `/hermit-settings docker` |
| Check what's installed | `docker exec <container> claude plugin list` |
| Force reinstall | Remove the cache dir and restart: `.claude-code-hermit/bin/hermit-docker restart` |
