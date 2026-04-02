# Recommended Plugins

Plugins that complement Hermit's autonomous operation. These are optional — Hermit works fine without them — but they add capabilities that improve self-learning and self-improvement over time.

During `/docker-setup`, you're asked whether to enable recommended plugins. They're installed on container boot. You can also manage them anytime with `/hermit-settings docker`.

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

Third-party plugins require adding a marketplace first. The entrypoint handles this automatically based on the `marketplace` field in config.

### Example: Adding a Third-Party Plugin

To add a plugin from a custom marketplace (e.g., `superpowers` from `obra/superpowers-marketplace`):

```bash
/hermit-settings docker
# Then: add superpowers obra/superpowers-marketplace
```

This writes the following entry to `config.json`:

```json
{
  "marketplace": "obra/superpowers-marketplace",
  "plugin": "superpowers",
  "scope": "project",
  "enabled": true
}
```

On next container boot, the entrypoint runs `claude plugin marketplace add obra/superpowers-marketplace` (if not already cached), then `claude plugin install superpowers@superpowers-marketplace --scope project`.

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
| Force reinstall | Remove the cache dir and restart: `docker compose -f docker-compose.hermit.yml restart` |
