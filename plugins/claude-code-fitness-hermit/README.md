<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License" /></a>
  <a href="https://code.claude.com/docs/en/plugins"><img src="https://img.shields.io/badge/Claude%20Code-plugin-orange.svg" alt="Claude Code Plugin" /></a>
  <a href="CHANGELOG.md"><img src="https://img.shields.io/badge/version-0.0.1-green.svg" alt="Version 0.0.1" /></a>
  <img src="https://img.shields.io/badge/Claude-Pro%20%7C%20Max-blueviolet.svg" alt="Claude Pro/Max Compatible" />
</p>

# claude-code-fitness-hermit

Turn Claude Code into a 24/7 personal fitness assistant.

Reads your Strava, spots load anomalies, drafts weekly plans, and flags recovery.

<p align="center">
  <img src="https://raw.githubusercontent.com/gtapps/claude-code-hermit/main/plugins/claude-code-hermit/assets/demo.gif" alt="claude-code-hermit demo — Obsidian dashboard, Discord control, autonomous briefings, remote access" width="720" />
</p>

This is a [`claude-code-hermit`](https://github.com/gtapps/claude-code-hermit) plugin. The core hermit brings session discipline, memory, and routines to Claude Code. This plugin adds the training layer — connected through the community Strava [MCP Server](https://github.com/r-huijts/strava-mcp-server) and the Strava [REST API](https://developers.strava.com/docs/reference/).

Three steps to a running 24/7 training hermit:
> ```
> # Install
> /plugin marketplace add gtapps/claude-code-hermit
> /plugin install claude-code-fitness-hermit@claude-code-hermit --scope project
>
> # Setup Wizard
> /claude-code-fitness-hermit:hatch
>
> # Go always-on
> /claude-code-hermit:docker-setup
> ```

---

## How It Works

**1. Give it your Strava.** Hatch wires the Strava MCP server, drops in routine prompt templates, and registers them with the core hermit. Your training history becomes the context it reasons from.

**2. Talk to it on Discord & Telegram or remotely.** Ask about last week's load, request an activity deep-dive, or get tomorrow's session suggestion. `activity-deep-dive` produces a coaching artifact — zone breakdown, pace/HR efficiency, cardiac drift, recovery estimate — you can skim in seconds.

**3. It watches your training for you.** Daily checks for new activities and Strava connectivity; weekly load review on Sundays; Monday planning suggestions. Anomalies — skipped recovery, ramp-rate spikes, missing data — get flagged in your channel.

**4. Routines.** Strava sync, health check, weekly load review, Monday planning. Need a different cadence or a new routine? Just ask and hermit sets it up.

**5. Safety is the default.** Write-class Strava tools (`star-segment`, `connect-strava`, `disconnect-strava`) are blocked outright. The hermit only reads — your Strava account is never modified.

**6. Everything is browsable.** Activity notes, weekly summaries, and load baselines flow into your hermit Cortex — the Obsidian vault hermit maintains — so your training history is greppable, linkable, and yours.

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

The wizard walks you through it: triggers `claude-code-hermit:hatch` if the core hermit isn't ready, prompts you to fill in `.env` with your four Strava credentials, writes `.mcp.json` with the Strava MCP server entry, drops the four routine prompt templates into `.claude-code-hermit/compiled/`, injects the Fitness Workflow block into your `CLAUDE.md`, and registers the routines in `.claude-code-hermit/config.json`.

> **Just want to try it?** After `hatch`, restart Claude Code (required to pick up the new `.mcp.json`), approve the `strava` MCP server, then run `.claude-code-hermit/bin/hermit-start --no-tmux` in your terminal. You get sessions, routines, heartbeat, and the learning loop — minus the 24/7 autonomy. Ctrl+C exits cleanly. Want Discord or Telegram before going always-on? Run `/claude-code-hermit:channel-setup`. When you're ready for the full 24/7 setup, continue to step 3.

### 3. Go Always-On

```
/claude-code-hermit:docker-setup
```

The wizard generates the Docker files, builds the image, starts the container, and walks you through auth and channel pairing. When it's done, your hermit is running with safe permission bypass, crash recovery, and restart on reboot.

See [Always-On Setup](https://github.com/gtapps/claude-code-hermit/blob/main/docs/always-on.md) for the full guide — including how to attach, detach, and manage the running container.

> **Want always-on without Docker?** See [Always-On Operations](https://github.com/gtapps/claude-code-hermit/blob/main/docs/always-on-ops.md) for bare tmux — lighter, no container isolation.

### Upgrading

> ```
> claude plugin update claude-code-hermit@claude-code-hermit --scope project
> claude plugin update claude-code-fitness-hermit@claude-code-hermit --scope project
> /claude-code-hermit:hermit-evolve
> ```

---

## The Daily Beat

Four routines run on their own — anomalies and summaries surface in your Discord/Telegram channel, never as silent edits to your training plan.

| Routine | Schedule | What it does |
|---|---|---|
| `strava-sync` | Daily 21:30 | Detect new activities, log them, flag anomalies |
| `strava-health-check` | Daily 08:05 | Check Strava connectivity; alert if lost |
| `weekly-load-review` | Sunday 18:00 | Week-over-week load summary with trend flag |
| `monday-planning` | Monday 09:30 | Weekly training structure suggestion |

You discuss findings in your channel; the hermit drafts compiled artifacts (weekly plans, activity notes, load baselines) into `.claude-code-hermit/compiled/` for you to review.

Activate per session with `/claude-code-hermit:hermit-routines load`. In always-on deployments they load automatically.

---

## Safety

- **Blocked outright:** `mcp__strava__star-segment`, `mcp__strava__connect-strava`, `mcp__strava__disconnect-strava` (denied via `settings.json`). The hermit reads your Strava account and never modifies it.
- **Credentials stay local:** `.env` and `.mcp.json` are gitignored — verify before any `git push`. The four Strava credentials in `.env` are written as literal values into `.mcp.json` (required for the MCP server's child process) and never committed.
- **No token leakage:** Never log, print, or write token values to session files, proposals, or memory.
- **TOKEN-pattern guard:** The base hermit's deny-patterns hook blocks any Bash command whose argument string contains the literal `TOKEN`. Hatch reads `.env` via the `Read` tool, not shell commands.

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

- Built on [`claude-code-hermit`](https://github.com/gtapps/claude-code-hermit) — session discipline, routines, channels, memory, cost tracking.
- Uses the community [Strava MCP Server](https://github.com/r-huijts/strava-mcp) (`@r-huijts/strava-mcp-server`) and the official Strava [REST API](https://developers.strava.com/docs/reference/).

## License

[MIT](LICENSE)
