# Upgrading

This guide covers upgrading claude-code-hermit and its domain packs in existing projects.

---

## Core Plugin Upgrade

### 1. Update the plugin

```bash
claude plugin marketplace add gtapps/claude-code-hermit   # re-fetches latest
```

### 2. Run the upgrade skill

Inside Claude Code, in each project that uses the plugin:

```
/claude-code-hermit:upgrade
```

The upgrade skill:
- Detects the version gap between your project config and the installed plugin
- Shows what changed (reads `CHANGELOG.md`)
- Prompts for any new settings introduced in the update
- Refreshes templates (`ACTIVE.md.template`, `SESSION-REPORT.md.template`, `PROPOSAL.md.template`)
- Updates the session discipline block in your project's `CLAUDE.md`
- Stamps the new version in your config's `_hermit_versions`

### 3. What if I don't upgrade?

The plugin is backwards compatible. `hermit-start.py` merges missing config keys from defaults at runtime, so nothing breaks. You just won't be prompted about new features until you run `/upgrade`.

Session start will show a soft nudge: "A hermit upgrade is available."

### Manual alternative

If you prefer not to use the upgrade skill, you can:
1. Compare `state-templates/config.json.template` with your `.claude/.claude-code-hermit/config.json`
2. Add any missing keys manually
3. Replace the session discipline block in CLAUDE.md with the latest `state-templates/CLAUDE-APPEND.md`

---

## Domain Pack Upgrade

Domain packs (e.g., `claude-code-dev-hermit`) are upgraded the same way:

```bash
claude plugin marketplace add your-org/claude-code-dev-hermit   # re-fetch
```

Then run `/claude-code-hermit:upgrade` — it automatically detects pack version gaps and handles them:
- Updates the pack's CLAUDE-APPEND block in your project's CLAUDE.md
- Follows the pack's `UPGRADE.md` instructions if the pack provides one
- Shows the pack's changelog entries for the version gap

Each pack's version is tracked independently in `_hermit_versions`:

```json
{
  "_hermit_versions": {
    "claude-code-hermit": "0.0.1",
    "claude-code-dev-hermit": "0.0.1"
  }
}
```

---

## Project Agent Evolution

This isn't an "upgrade" — it's how your project-specific customizations evolve over time.

### OPERATOR.md

Edit directly or tell the agent: "Update OPERATOR.md with X." Keep the first 50 lines focused on critical context (the SessionStart hook reads `head -50`).

### Custom agents

Add, modify, or remove agent files in `.claude/agents/`. Changes take effect on the next Claude Code session — no restart needed.

### Custom skills

Add or modify skill directories in `.claude/skills/`. Same — changes are live immediately.

### Config

Use `/claude-code-hermit:hermit-settings` or edit `.claude/.claude-code-hermit/config.json` directly.

---

## Version Tracking

Projects initialized before version tracking was added will not have a `_hermit_versions` field in config.json. The upgrade skill treats this as version `0.0.0` and will prompt for all settings introduced since the initial release.

After upgrading, your config.json will include:

```json
{
  "_hermit_versions": {
    "claude-code-hermit": "0.0.1"
  },
  ...
}
```

This field is metadata — don't edit it manually.

---

## For Domain Pack Authors

If you maintain a domain pack and want to support upgrades:

1. **Keep `plugin.json` version updated** — the upgrade skill reads this
2. **Maintain a `CHANGELOG.md`** — the upgrade skill shows entries to the operator
3. **Optionally provide `UPGRADE.md`** — pack-specific upgrade instructions the agent follows (e.g., re-ask OPERATOR.md questions, update custom hooks)
4. **Keep `state-templates/CLAUDE-APPEND.md` current** — the upgrade skill replaces the old block automatically

See [CREATING-DOMAIN-PACK.md](CREATING-DOMAIN-PACK.md) for the full pack structure. For details on any skill mentioned in this guide, see [SKILLS.md](SKILLS.md).
