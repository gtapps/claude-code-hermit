# Upgrading

Hermit is backwards compatible — nothing breaks if you don't upgrade. But upgrading unlocks new features and refreshes templates.

---

## Core Plugin

### One command (recommended)

From the project root, run the wrapper for your deployment: it moves the durable plugin pin, reloads the running session, and auto-runs `hermit-evolve` when the version bumped. Host installs then need the stop/start below.

```bash
# Docker hermits:
.claude-code-hermit/bin/hermit-docker update
# Local / tmux hermits:
.claude-code-hermit/bin/hermit-update
```

Always-on hermits do this on their own: the session-start upgrade banner triggers `hermit-evolve unattended` automatically.

After a host `.claude-code-hermit/bin/hermit-update`, stop the running resident with `.claude-code-hermit/bin/hermit-stop`, then start it with `.claude-code-hermit/bin/hermit-start --resume` so the launch overlay is rewritten. Both update commands send `/reload-plugins`, which drops `pause-gate`, `ask-gate`, `component-privacy`, and `permission-denied-notify` from the running session while the previous overlay has none. Docker hermits need nothing else.

### Manual

If you'd rather drive it by hand:

**1. Refresh the marketplace catalog first.** `plugin update` moves the pin against whatever version is already in the local cache — it does not git-pull the catalog itself. Auto-refresh is off by default for third-party/local marketplaces like this one, so a new upstream release stays invisible until you refresh:

```bash
claude plugin marketplace update claude-code-hermit
```

**2. Move the plugin pin (durable).** Refreshing the marketplace alone does NOT update the installed version — it only stages it; the pin reverts on the next restart. Use `plugin update` with the full marketplace-qualified id and your install scope (a bare plugin name fails with "not found"):

```bash
claude plugin update claude-code-hermit@claude-code-hermit --scope local
```

**3. Run the upgrade skill.** Inside Claude Code, in each project that uses the plugin:

```
/claude-code-hermit:hermit-evolve
```

This detects the version gap, shows what changed, prompts for new settings, refreshes templates and the Docker entrypoint, and updates the CLAUDE.md session discipline block.

### 4. What if I don't upgrade?

`hermit-start.ts` merges missing config keys from defaults at runtime. Session start shows a soft nudge: "A hermit upgrade is available."

### 5. "Stale Plugin Runtime" — the opposite case

If session start reports `---Stale Plugin Runtime---`, the session is running a plugin copy *older* than the version this hermit has already applied. That is a stale install, not a pending upgrade, and `/claude-code-hermit:hermit-evolve` cannot fix it — it would either no-op or try to stamp the older version. The notice prints the path the session loaded; find the entry with that path in `claude plugin list` and update it with that entry's own scope:

```bash
claude plugin update claude-code-hermit@claude-code-hermit --scope <local|project|user>
```

Then restart the session. A scope-less `plugin update` targets the default scope and can leave the stale entry in place. If the notice appears when running `bin/hermit-start` instead, it is the marketplace clone that lags: `claude plugin marketplace update claude-code-hermit`.

**Deliberately rolling back to an older core?** The applied-version stamp in `_hermit_versions` only moves forward — `evolve-finalize` refuses to lower it (`core_version_regression`), because lowering it would claim migrations were reversed when nothing reversed them. A genuine rollback needs the stamp edited by hand in `.claude-code-hermit/config.json` to match the version you rolled back to; re-running `hatch` will not do it (it only adds missing keys).

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
- **Container** — [Customizing the container](always-on.md#customizing-the-container).

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

Evolve compares shared CLAUDE instructions and `.claude-code-hermit/RESIDENT.md` even at an equal version. It writes resident duties first, cleans legacy local settings, then offers the shared-block shrink. Restart with `hermit-start --resume` after this migration.
