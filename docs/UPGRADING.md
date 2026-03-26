# Upgrading

Hermit is backwards compatible — nothing breaks if you don't upgrade. But upgrading unlocks new features and refreshes templates.

---

## Core Plugin

### 1. Update the plugin

```bash
claude plugin marketplace add gtapps/claude-code-hermit
```

### 2. Run the upgrade skill

Inside Claude Code, in each project that uses the plugin:

```
/claude-code-hermit:upgrade
```

This detects the version gap, shows what changed, prompts for new settings, refreshes templates, and updates the CLAUDE.md session discipline block.

### 3. What if I don't upgrade?

`hermit-start.py` merges missing config keys from defaults at runtime. Session start shows a soft nudge: "A hermit upgrade is available."

---

## Hermit Plugins

Hermits (e.g., `claude-code-dev-hermit`) upgrade the same way:

```bash
claude plugin marketplace add your-org/claude-code-dev-hermit
```

Then `/claude-code-hermit:upgrade` — it detects hermit version gaps automatically and updates their CLAUDE-APPEND blocks.

Each hermit's version is tracked independently in `config.json`:

```json
{
  "_hermit_versions": {
    "claude-code-hermit": "0.0.2",
    "claude-code-dev-hermit": "0.0.1"
  }
}
```

---

## Project Customizations

These aren't upgrades — just how your project evolves:

- **OPERATOR.md** — Edit directly or tell the agent. Keep critical context in the first 50 lines.
- **Custom agents** — Add/modify/remove files in `.claude/agents/`. Live immediately.
- **Custom skills** — Add/modify in `.claude/skills/`. Live immediately.
- **Config** — `/claude-code-hermit:hermit-settings` or edit `config.json` directly.

---

## For Hermit Authors

1. Keep `plugin.json` version updated
2. Maintain a `CHANGELOG.md`
3. Optionally provide `UPGRADE.md` with hermit-specific instructions
4. Keep `state-templates/CLAUDE-APPEND.md` current
