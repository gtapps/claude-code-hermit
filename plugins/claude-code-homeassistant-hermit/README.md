<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License" /></a>
  <a href="https://code.claude.com/docs/en/plugins"><img src="https://img.shields.io/badge/Claude%20Code-plugin-orange.svg" alt="Claude Code Plugin" /></a>
  <a href="CHANGELOG.md"><img src="https://img.shields.io/badge/version-0.0.5-green.svg" alt="Version 0.0.5" /></a>
  <img src="https://img.shields.io/badge/Claude-Pro%20%7C%20Max-blueviolet.svg" alt="Claude Pro/Max Compatible" />
</p>

# claude-code-homeassistant-hermit

Turn Claude Code into a 24/7 personal AI assistant for your Home Assistant.

Understands your house, spots the patterns, drafts automations, and catches things breaking while you sleep — and never flips a switch without your say-so.

This is a [`claude-code-hermit`](https://github.com/gtapps/claude-code-hermit) plugin. The core hermit brings session discipline, memory, and routines to Claude Code. This plugin adds the Home Assistant layer — connected through the official Home Assistant [MCP](https://www.home-assistant.io/integrations/mcp_server/) Server & [API](https://www.home-assistant.io/integrations/api/).

Three steps to a running 24/7 Home Assistant hermit:
> ```
> # Install
> claude plugin marketplace add gtapps/claude-code-hermit
> claude plugin install claude-code-hermit@claude-code-hermit --scope project
> claude plugin install claude-code-homeassistant-hermit@claude-code-hermit --scope project
>
> # Setup Wizard
> /claude-code-homeassistant-hermit:hatch
>
> # Go always-on
> /claude-code-hermit:docker-setup
> ```

---

## How It Works

**1. Give it your house.** Point it at Home Assistant and the hermit learns your entities, areas, patterns, and automations — your house becomes the context it reasons from.

**2. Talk to it on Discord & Telegram or  remotely.** Ask what's on, draft an automation, ask why the porch light fired at 3am. Each flow is a skill — the agent reads your inventory, drafts YAML in an isolated worktree, simulates it, and only applies after you approve.

**3. It watches the house for you.** Daily and weekly checks run on their own: pattern analysis, automation suggestions, integration health, automation errors, safety re-audit. Anything worth your attention surfaces as a proposal you can act on.

**4. Routines.** Morning brief, daily context refresh, weekly safety audit, daily integration-health and automation-error checks. Need a new routine? Just ask and hermit sets it up.

**5. Safety is the default.** Locks, alarm panels, and security-tagged devices are blocked outright. Vague targets (an area or device with no resolvable entity) fail closed. Blocked operations become proposals, never surprises.

**6. Everything is browsable.** HA sessions, proposals, pattern findings, and cost tracking flow into your hermit Cortex — the Obsidian vault hermit maintains — so your house's history is greppable, linkable, and yours.

---

## Quick Start

> **Prerequisites:** [Claude Code](https://code.claude.com) v2.1.98+, a paid Claude plan (Pro, Max, Teams, or Enterprise), Python 3.12+, and a running [Home Assistant](https://www.home-assistant.io/) instance with the Official [MCP Server](https://www.home-assistant.io/integrations/mcp_server/)  & [API](https://www.home-assistant.io/integrations/api/) integration enabled and a Long-Lived Access Token (create one under `/profile/security` on your HA instance).

### 1. Install

```bash
cd /path/to/your/project   # any folder — empty is fine

claude plugin marketplace add gtapps/claude-code-hermit

claude plugin install claude-code-hermit@claude-code-hermit --scope project
claude plugin install claude-code-homeassistant-hermit@claude-code-hermit --scope project
```

### 2. Initialize

```
/claude-code-homeassistant-hermit:hatch
```

The wizard walks you through it: triggers `claude-code-hermit:hatch` if the core hermit isn't ready, prompts for your `.env` (HA URL + Long-Lived Access Token), installs Python deps into a local `.venv`, wires up the Official Home Assistant MCP Server, and registers the routines.

> **Just want to try it?** After `hatch`, run `.claude-code-hermit/bin/hermit-start --no-tmux` in your terminal. You get sessions, routines, heartbeat, and the learning loop — minus the 24/7 autonomy. Ctrl+C exits cleanly. Want Discord or Telegram before going always-on? Run `/claude-code-hermit:channel-setup`. When you're ready for the full 24/7 setup, continue to step 3.

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
> claude plugin update claude-code-homeassistant-hermit@claude-code-hermit --scope project
> /claude-code-hermit:hermit-evolve
> ```

---

## The Learning Loop

The hermit watches your house every day — integration drops, automation errors, safety drift, usage patterns you haven't automated yet. When it finds something worth your attention, it writes a proposal: a structured recommendation with evidence.

```
/claude-code-hermit:proposal-list                   # see what it found
/claude-code-hermit:proposal-act accept PROP-003    # make it the next thing to work on
```

Accept one and the hermit picks it up during idle time. Reject, defer, dismiss — you're always in control.

---

## Safety

Every actuation call is pre-screened by a safety hook before it reaches Home Assistant.

- **Blocked outright:** `lock`, `alarm_control_panel`, and security-tagged `cover` / `button` / `switch` domains.
- **Fail closed:** area-only or device-only targets where no concrete entity ID can be resolved.
- **Blocked ≠ silent:** every block becomes a proposal for human review.

Policy overrides (allow-lists, extra sensitive domains/keywords) are configured through `.env`. See [SAFETY.md](SAFETY.md) for the full policy and override reference.

---

## Architecture

```
claude-code-homeassistant-hermit (this plugin)
  ├── skills/             HA workflow skills
  ├── agents/             HA subagents (safety-reviewer, automation-builder, pattern-analyst)
  ├── hooks/              mcp-safety-gate.py + hooks.json
  ├── bin/ha-agent-lab    Python CLI launcher
  ├── src/ha_agent_lab/   Python package (REST client, policy, simulation, apply)
  └── state-templates/    CLAUDE-APPEND.md (injected by hatch)

claude-code-hermit (core, required ≥ 1.0.15)
  └── Session lifecycle, proposals, reflect, memory, cost tracking
```

**MCP vs Python.** MCP handles live ops — light/cover/fan control, live context queries. The Python CLI (`bin/ha-agent-lab`) handles bulk work — context refresh, YAML simulation, policy checks, audits, apply.

---

## Credits

- Built on [`claude-code-hermit`](https://github.com/gtapps/claude-code-hermit) — session discipline, proposals, memory, reflect pipeline.
- Uses the official Home Assistant [API](https://www.home-assistant.io/integrations/api/) & [MCP Server](https://www.home-assistant.io/integrations/mcp_server/).

## License

[MIT](LICENSE)
