<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License" /></a>
  <a href="https://code.claude.com/docs/en/plugins"><img src="https://img.shields.io/badge/Claude%20Code-plugin-orange.svg" alt="Claude Code Plugin" /></a>
  <a href="CHANGELOG.md"><img src="https://img.shields.io/badge/version-0.0.3-green.svg" alt="Version 0.0.3" /></a>
</p>

# claude-code-fitness-hermit

Turn Claude Code into a 24/7 personal fitness assistant. **Strava-aware**, **Read-only**, **Plans + flags**, **Built on `claude-code-hermit`**.

<p align="center">
  <img src="https://raw.githubusercontent.com/gtapps/claude-code-hermit/main/plugins/claude-code-hermit/assets/demo.gif" alt="claude-code-hermit demo — Obsidian dashboard, Discord control, autonomous briefings, remote access" width="720" />
</p>

Reads your Strava, spots load anomalies, drafts weekly plans, and flags recovery — never modifies your account. Wires the community Strava [MCP Server](https://github.com/r-huijts/strava-mcp-server) and the [Strava REST API](https://developers.strava.com/docs/reference/) into the [`claude-code-hermit`](https://github.com/gtapps/claude-code-hermit) loop, with write-class tools blocked at the settings layer.

```
# Install
claude plugin marketplace add gtapps/claude-code-hermit
claude plugin install claude-code-fitness-hermit@claude-code-hermit --scope project

# Setup wizard
/claude-code-fitness-hermit:hatch

# Go always-on
/claude-code-hermit:docker-setup
```

---

## What you get

**Knows your training.** Hatch wires the Strava MCP server, drops in routine prompt templates, and registers them with the core hermit. Your training history becomes the context it reasons from.

**Drive it from anywhere.** Ask about last week's load, request an activity deep-dive, or get tomorrow's session suggestion — DM the hermit on Discord or Telegram, or jump into a live session from claude.ai/code on your phone. `activity-deep-dive` produces a coaching artifact (zone breakdown, pace/HR efficiency, cardiac drift, recovery estimate) you can skim in seconds.

**It watches your training for you.** Daily checks for new activities and Strava connectivity; weekly load review on Sundays; Monday planning suggestions. Anomalies — skipped recovery, ramp-rate spikes, missing data — get flagged in your channel.

**Routines that match a training week:**

- `strava-sync` — daily 21:30 — detect new activities, log them, flag anomalies
- `strava-health-check` — daily 08:05 — verify Strava connectivity; alert if lost
- `weekly-load-review` — Sunday 18:00 — week-over-week load summary with trend flag
- `monday-planning` — Monday 09:30 — weekly training structure suggestion

Need a different cadence or a new routine? Just ask — hermit sets it up.

**Read-only by design.** Write-class Strava tools (`star-segment`, `connect-strava`, `disconnect-strava`) are blocked at the settings layer. The hermit only reads — your Strava account is never modified.

**Everything is browsable.** Activity notes, weekly summaries, and load baselines flow into your hermit Cortex — the Obsidian vault hermit maintains — so your training history is greppable, linkable, and yours.

---

## Quick Start

> **Prerequisites:** [Claude Code](https://code.claude.com) v2.1.110+, a paid Claude plan (Pro, Max, Teams, or Enterprise), Node.js (for `npx` to launch the Strava MCP server), and a [Strava developer app](https://www.strava.com/settings/api) with four OAuth credentials — `STRAVA_CLIENT_ID`, `STRAVA_CLIENT_SECRET`, `STRAVA_ACCESS_TOKEN`, `STRAVA_REFRESH_TOKEN` — and scopes `read,activity:read_all,profile:read_all`. The default `read` scope alone is not enough; activity and stream reads will return 401. See the [Strava OAuth guide](https://developers.strava.com/docs/authentication/) for the full flow.

### 1. Install

```bash
cd /path/to/your/project   # any folder — empty is fine
claude plugin marketplace add gtapps/claude-code-hermit
claude plugin install claude-code-fitness-hermit@claude-code-hermit --scope project
```

### 2. Initialize

```
/claude-code-fitness-hermit:hatch
```

The wizard triggers `claude-code-hermit:hatch` if the core hermit isn't ready, prompts you to fill in `.env` with your four Strava credentials, writes `.mcp.json` with the Strava MCP server entry, drops the four routine prompt templates into `.claude-code-hermit/compiled/`, injects the Fitness Workflow block into your `CLAUDE.md`, and registers the routines.

> **Just trying it?** After `hatch`, restart Claude Code (required to pick up the new `.mcp.json`), approve the `strava` MCP server, then run `.claude-code-hermit/bin/hermit-start --no-tmux` for sessions, routines, heartbeat, and the learning loop without 24/7 autonomy. Run `/claude-code-hermit:channel-setup` first if you want Discord or Telegram.

### 3. Go Always-On

```
/claude-code-hermit:docker-setup
```

Generates the Docker scaffolding, builds the image, starts the container, and walks through auth and channel pairing. The container ships with the hardening baseline (`cap_drop: ALL`, `no-new-privileges`, `pids_limit`). For LAN containment + DNS allowlisting + resource bounds, follow up with [`/claude-code-hermit:docker-security`](https://github.com/gtapps/claude-code-hermit/blob/main/plugins/claude-code-hermit/docs/docker-security.md).

See [Always-On Setup](https://github.com/gtapps/claude-code-hermit/blob/main/plugins/claude-code-hermit/docs/always-on.md) for the full guide. Want always-on without Docker? See [Always-On Operations](https://github.com/gtapps/claude-code-hermit/blob/main/plugins/claude-code-hermit/docs/always-on-ops.md) for bare tmux.

### Upgrading

```
claude plugin update claude-code-hermit@claude-code-hermit --scope project
claude plugin update claude-code-fitness-hermit@claude-code-hermit --scope project
/claude-code-hermit:hermit-evolve
```

---

## Safety

- **Blocked outright** — `mcp__strava__star-segment`, `mcp__strava__connect-strava`, `mcp__strava__disconnect-strava` (denied via `settings.json`). The hermit reads your Strava account and never modifies it.
- **Credentials stay local** — `.env` and `.mcp.json` are gitignored. The four Strava credentials in `.env` are written as literal values into `.mcp.json` (required for the MCP server's child process) and never committed.
- **No token leakage** — never logs, prints, or writes token values to session files, proposals, or memory.
- **TOKEN-pattern guard** — the base hermit's deny-patterns hook blocks any Bash command whose argument string contains the literal `TOKEN`. Hatch reads `.env` via the `Read` tool, not shell commands.

---

## Architecture

```
claude-code-fitness-hermit (this plugin)
  ├── skills/             hatch + activity-deep-dive
  ├── agents/             strava-data-cruncher (Haiku bulk aggregator)
  ├── state-templates/    routine-*.md + CLAUDE-APPEND.md (injected by hatch)
  ├── docs/               knowledge-schema.md
  └── settings.json       Strava read allow-list, write tools blocked

claude-code-hermit (core, required ≥ 1.0.26)
  └── Session lifecycle, routines, channels, memory, cost tracking
```

**MCP-only.** Fitness uses the Strava MCP server (registered as `strava` in `.mcp.json`, installed via `npx` on first use) for all data access. The `strava-data-cruncher` Haiku subagent caps at 30 API calls per invocation to stay under Strava's 100/15min and 1000/day rate limits.

Extension points: Garmin, Apple Health, Polar, and other fitness integrations are not included but can be added by registering additional MCP server entries in `.mcp.json`.

---

## Credits

- Built on [`claude-code-hermit`](https://github.com/gtapps/claude-code-hermit) — session discipline, routines, channels, memory, cost tracking
- Uses the community [Strava MCP Server](https://github.com/r-huijts/strava-mcp-server) and the official Strava [REST API](https://developers.strava.com/docs/reference/)

## License

[MIT](LICENSE)
