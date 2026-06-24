<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License" /></a>
  <a href="https://code.claude.com/docs/en/plugins"><img src="https://img.shields.io/badge/Claude%20Code-plugin-orange.svg" alt="Claude Code Plugin" /></a>
  <a href="CHANGELOG.md"><img src="https://img.shields.io/badge/version-0.2.2-green.svg" alt="Version 0.2.2" /></a>
  <img src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg" alt="PRs Welcome" />
  <a href="https://discord.gg/54sJqAxhUh"><img src="https://img.shields.io/badge/Discord-Join-5865F2?logo=discord&logoColor=white" alt="Join" /></a>
</p>

# claude-code-homeassistant-hermit

Turn Claude Code into a 24/7 personal AI for your Home Assistant. **HA-aware**, **Read-first**, **Safe-by-default**, **Built on `claude-code-hermit`**.

<p align="center">
  <img src="../claude-code-hermit/assets/cover.png" alt="Always-on Claude Code Home Assistant Agent" width="720" />
</p>

Understands your house, spots the patterns, drafts automations, catches things breaking while you sleep — and never flips a switch without your say-so. Wires the official Home Assistant [MCP Server](https://www.home-assistant.io/integrations/mcp_server/) and [REST API](https://www.home-assistant.io/integrations/api/) into the [`claude-code-hermit`](https://github.com/gtapps/claude-code-hermit) loop with a fail-closed safety hook in front of every actuation call.

```
# Install
claude plugin marketplace add gtapps/claude-code-hermit
claude plugin install claude-code-homeassistant-hermit@claude-code-hermit --scope local

# Setup wizard
/claude-code-homeassistant-hermit:hatch

# Go always-on
/claude-code-hermit:docker-setup
```

---

## What you get

**Knows your house.** Hatch points the hermit at HA, then learns your entities, areas, automations, and patterns — your house becomes the context it reasons from. `daily-ha-context` keeps it fresh.

**Drive it from anywhere.** Ask what's on, draft an automation, or ask why the porch light fired at 3am. Reach it from the Claude app or claude.ai/code on your phone (handy if you run several hermits), and optionally DM it on Discord or Telegram. Replies are conversational; YAML drafts get isolated, simulated, and only applied after you approve.

**It watches the house for you.** Daily integration health, silence detection (dead automations, sensors that stopped triggering, long-unavailable entities), and automation error checks; weekly pattern analysis, history-backed automation suggestions, and safety re-audit. Anomalies surface as proposals you can act on — never silent edits.

**Safety is the default.** `lock`, `alarm_control_panel`, and security-tagged `cover`/`button`/`switch` domains are blocked outright. Vague targets (an area or device with no resolvable entity) fail closed. Every block becomes a proposal — never a surprise.

**Routines that respect your day.** Morning and evening briefs (morning off until you confirm the house profile; evening confirms security before night), daily context refresh, weekly safety audit, daily integration-health and automation-error checks. Need a different cadence or a new routine? Just ask — hermit sets it up.

**Everything is searchable.** HA sessions, proposals, pattern findings, and cost tracking land in your hermit's compiled knowledge and auto-memory — surfaceable on demand via `/hermit-brain` and `/hermit-health`, greppable from the state tree.

---

## Quick Start

> **Prerequisites:** [Claude Code](https://code.claude.com) v2.1.172+, a paid Claude plan (Pro, Max, Teams, or Enterprise), [Bun](https://bun.sh) 1.3+ (Python 3 is still needed for the safety hooks), and a running [Home Assistant](https://www.home-assistant.io/) instance with the official [MCP Server](https://www.home-assistant.io/integrations/mcp_server/) integration enabled and a Long-Lived Access Token (create one under `/profile/security` on your HA instance).

### 1. Install

```bash
cd /path/to/your/project   # any folder — empty is fine
claude plugin marketplace add gtapps/claude-code-hermit
claude plugin install claude-code-homeassistant-hermit@claude-code-hermit --scope local
```

### 2. Initialize

```
/claude-code-homeassistant-hermit:hatch
```

The wizard triggers `claude-code-hermit:hatch` if the core hermit isn't ready, prompts for your `.env` (HA URL + Long-Lived Access Token), wires up the official Home Assistant MCP server, and registers the routines.

> **Just trying it?** After `hatch`, run `.claude-code-hermit/bin/hermit-start --no-tmux` for sessions, routines, heartbeat, and the learning loop without 24/7 autonomy. Ctrl+C exits cleanly. Run `/claude-code-hermit:channel-setup` first if you want Discord or Telegram.

### 3. Go Always-On

```
/claude-code-hermit:docker-setup
```

Generates the Docker scaffolding, builds the image, starts the container, and walks through auth and channel pairing. The container ships with the hardening baseline (`cap_drop: ALL`, `no-new-privileges`, `pids_limit`). For LAN containment + DNS allowlisting + resource bounds, follow up with [`/claude-code-hermit:docker-security`](https://github.com/gtapps/claude-code-hermit/blob/main/plugins/claude-code-hermit/docs/docker-security.md).

See [Always-On Setup](https://github.com/gtapps/claude-code-hermit/blob/main/plugins/claude-code-hermit/docs/always-on.md) for the full guide. Want always-on without Docker? See [Always-On Operations](https://github.com/gtapps/claude-code-hermit/blob/main/plugins/claude-code-hermit/docs/always-on-ops.md) for bare tmux.

### Upgrading

```
claude plugin update claude-code-hermit@claude-code-hermit --scope local
claude plugin update claude-code-homeassistant-hermit@claude-code-hermit --scope local
/claude-code-hermit:hermit-evolve
```

---

## The Learning Loop

The hermit watches your house every day — integration drops, automation errors, safety drift, usage patterns you haven't automated yet. When something crosses the three-condition rule (repeated + meaningful + actionable), it writes a proposal:

```
/claude-code-hermit:proposal-list                   # see what it found
/claude-code-hermit:proposal-act accept PROP-003    # make it the next thing to work on
```

Accept one and the hermit picks it up during idle time. Reject, defer, dismiss — you're always in control.

---

## Safety

Every actuation call is pre-screened by a safety hook before it reaches Home Assistant.

- **Blocked outright** — `lock`, `alarm_control_panel`, security-tagged `cover` / `button` / `switch` domains
- **Fail closed** — area-only or device-only targets where no concrete entity ID can be resolved
- **Blocked ≠ silent** — every block becomes a proposal for human review

Policy overrides (allow-lists, extra sensitive domains/keywords) are configured through `.env`. See [SAFETY.md](SAFETY.md) for the full policy and override reference.

---

## Configure it

| Key | Default / options (default **bold**) |
|-----|--------------------------------------|
| `HOMEASSISTANT_URL` | `.env` — HA instance URL (required) |
| `HOMEASSISTANT_LOCAL_URL` | `.env` — optional LAN URL |
| `HOMEASSISTANT_REMOTE_URL` | `.env` — optional remote URL (e.g. Nabu Casa) |
| `HOMEASSISTANT_TOKEN` | `.env` — Long-Lived Access Token (required) |
| `HOMEASSISTANT_TIMEOUT_SECONDS` | `.env` — request timeout — **`15`** |
| `HOMEASSISTANT_RETRY_COUNT` | `.env` — request retries — **`2`** |
| `HOMEASSISTANT_USER_AGENT` | `.env` — optional custom User-Agent |
| `ha_safety_mode` | actuation gate (`config.json`) — **`strict`** (never actuate autonomously; blocked work becomes a proposal) / `ask` (prompt before any sensitive actuation) |
| `HA_SAFE_ENTITIES` | `.env` — per-entity allow-list, exact IDs (always allowed) |
| `HA_EXTRA_SENSITIVE_DOMAINS` | `.env` — block additional domains entirely |
| `HA_EXTRA_SENSITIVE_KEYWORDS` | `.env` — block extra keywords in conditionally-sensitive domains |

Full policy in [SAFETY.md](SAFETY.md). Everything else — model, heartbeat, idle behavior, per-routine model — is core, tuned with `/hermit-settings`: see core's [Configure it](https://github.com/gtapps/claude-code-hermit/blob/main/plugins/claude-code-hermit/README.md#configure-it) and [Tips & tuning](https://github.com/gtapps/claude-code-hermit/blob/main/plugins/claude-code-hermit/README.md#tips--tuning).

---

## Architecture

```
claude-code-homeassistant-hermit (this plugin)
  ├── skills/             HA workflow skills
  ├── agents/             HA subagents (safety-reviewer, automation-builder, pattern-analyst)
  ├── hooks/              mcp-safety-gate.ts + hooks.json
  ├── bin/ha-agent-lab    CLI launcher (runs src/cli.ts with bun)
  ├── src/*.ts            TypeScript modules (REST client, policy, simulation, apply, history, silence)
  └── state-templates/    CLAUDE-APPEND.md (injected by hatch)

claude-code-hermit (core, required ≥ 1.1.1)
  └── Session lifecycle, proposals, reflect, memory, cost tracking
```

**MCP vs CLI.** MCP handles live ops — light/cover/fan control, live context queries. The CLI (`bin/ha-agent-lab`) handles bulk work — context refresh, YAML simulation, policy checks, audits, apply.

---

## Credits

- Built on [`claude-code-hermit`](https://github.com/gtapps/claude-code-hermit) — session discipline, proposals, memory, reflect pipeline
- Uses the official Home Assistant [API](https://www.home-assistant.io/integrations/api/) & [MCP Server](https://www.home-assistant.io/integrations/mcp_server/)

## License

[MIT](LICENSE)
