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

---

## Third-Party Plugins

> **Third-party plugins are NOT auto-installed.** Because Docker containers run with `bypassPermissions`, auto-installing third-party plugins would grant untrusted code full unrestricted execution. You must install them manually.

You can track third-party plugins in your config for documentation purposes, but the entrypoint will skip them with a warning and not install them.

### Manual Installation

To install a third-party plugin inside a running container:

```bash
# Attach to the container
.claude-code-hermit/bin/hermit-docker attach
# Then from the tmux session, or directly:
docker compose -f docker-compose.hermit.yml exec hermit bash

# Add the marketplace and install
claude plugin marketplace add obra/superpowers-marketplace
claude plugin install superpowers@superpowers-marketplace --scope project
```

You can optionally track it in config via `/hermit-settings docker`:

```bash
add superpowers obra/superpowers-marketplace
```

This writes the entry to `config.json` for reference, but the entrypoint will not auto-install it.

---

## Config Format

Each entry in `docker.recommended_plugins`:

| Field | Type | Description |
|-------|------|-------------|
| `marketplace` | string | `"claude-plugins-official"` for official, or `"org/repo"` for third-party |
| `plugin` | string | Plugin name |
| `scope` | string | `"project"` or `"local"` |
| `enabled` | boolean | Install on boot when `true` |

See [Config Reference](CONFIG-REFERENCE.md#recommended_plugins-entry-schema) for defaults.

---

## Managing Plugins

| Task | How |
|------|-----|
| Enable during Docker setup | `/docker-setup` wizard step 7b |
| Enable/disable after setup | `/hermit-settings docker` |
| Check what's installed | `docker exec <container> claude plugin list` |
| Force reinstall | Remove the cache dir and restart: `.claude-code-hermit/bin/hermit-docker restart` |
