# Upgrading

Hermit is backwards compatible — nothing breaks if you don't upgrade. But upgrading unlocks new features and refreshes templates.

---

## Core Plugin

### One command (recommended)

From the project root, run the wrapper for your deployment — it moves the durable plugin pin, reloads the running session, and auto-runs `hermit-evolve` when the version bumped:

```bash
# Docker hermits:
.claude-code-hermit/bin/hermit-docker update
# Local / tmux hermits:
.claude-code-hermit/bin/hermit-update
```

Always-on hermits do this on their own: the session-start upgrade banner triggers `hermit-evolve unattended` automatically.

### Manual

If you'd rather drive it by hand:

**1. Move the plugin pin (durable).** Refreshing the marketplace alone does NOT update the installed version — it only stages it; the pin reverts on the next restart. Use `plugin update` with the full marketplace-qualified id and your install scope (a bare plugin name fails with "not found"):

```bash
claude plugin update claude-code-hermit@claude-code-hermit --scope local
```

**2. Run the upgrade skill.** Inside Claude Code, in each project that uses the plugin:

```
/claude-code-hermit:hermit-evolve
```

This detects the version gap, shows what changed, prompts for new settings, refreshes templates and the Docker entrypoint, and updates the CLAUDE.md session discipline block.

### 3. What if I don't upgrade?

`hermit-start.ts` merges missing config keys from defaults at runtime. Session start shows a soft nudge: "A hermit upgrade is available."

---

## Hermit Plugins

Hermits (e.g., `claude-code-dev-hermit`) upgrade the same way — the wrappers above update every installed hermit plugin in one pass. To do it by hand, move each hermit's pin with its own id and scope:

```bash
claude plugin update claude-code-dev-hermit@your-org --scope local
```

Then `/claude-code-hermit:hermit-evolve` — it detects hermit version gaps automatically and updates their CLAUDE-APPEND blocks.

Each hermit's version is tracked independently in `config.json`:

```json
{
  "_hermit_versions": {
    "claude-code-hermit": "1.0.6",
    "claude-code-dev-hermit": "1.0.0"
  }
}
```

## Project Customizations

These aren't upgrades — just how your project evolves:

- **OPERATOR.md** — Edit directly or tell your hermit. Keep critical context in the first 50 lines.
- **Custom agents** — Add/modify/remove files in `.claude/agents/`. Live immediately.
- **Custom skills** — Add/modify in `.claude/skills/`. Live immediately.
- **Config** — `/claude-code-hermit:hermit-settings` or edit `config.json` directly.

---

## For Hermit Authors

1. Keep `plugin.json` version updated
2. Maintain a `CHANGELOG.md`
3. Optionally provide `UPGRADE.md` with hermit-specific instructions
4. Keep `state-templates/CLAUDE-APPEND.md` current

---

## Version History

Per-version upgrade instructions live in [CHANGELOG.md](../CHANGELOG.md) under each version's `### Upgrade Instructions` section. `hermit-evolve` reads and executes those instructions automatically — you don't need to apply them manually.

For a full list of what changed in each release, see [CHANGELOG.md](../CHANGELOG.md).
