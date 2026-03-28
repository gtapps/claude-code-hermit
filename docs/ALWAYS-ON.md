# Always-On Setup

Docker is the recommended way to run your hermit autonomously. For lifecycle internals, security hardening, and idle agency details, see [Always-On Operations](ALWAYS-ON-OPS.md).

---

## Why Docker

An always-on agent needs `bypassPermissions` — no prompts, no babysitting. Without isolation that's reckless. With Docker, the container can only see what you mount and restarts automatically on crash.

You get three things at once: safe permission bypass, crash recovery, and a reproducible environment.

---

## Prerequisites

| Requirement              | For          | Notes                                          |
| ------------------------ | ------------ | ---------------------------------------------- |
| **Docker**               | Container    | `docker compose` v2 (Docker Desktop or modern Docker Engine) |
| **Node.js 24+**          | Hooks        | Inside the container — handled by the Dockerfile |
| **Bun**                  | Plugins      | Inside the container — always included          |
| **Claude Code v2.1.80+** | Channels     | Required for the channels research preview     |

---

## Setup

Run after `/claude-code-hermit:init`:

```
/claude-code-hermit:docker-setup
```

The wizard scans your project for dependencies, asks about auth, and generates four hermit-namespaced files (so they don't clash with your own Docker setup):

| File                          | Purpose                                               |
| ----------------------------- | ----------------------------------------------------- |
| `Dockerfile.hermit`           | Ubuntu 24.04, Node 24, Bun, Claude Code, project packages, host UID matching |
| `docker-entrypoint.hermit.sh` | Onboarding bypass, MCP approval, permission patch, channel symlinks, PID 1 keepalive |
| `docker-compose.hermit.yml`   | Volume mounts, env vars, healthcheck, restart policy  |
| `.env`                        | Auth token (appended if file already exists)           |

The wizard also checks `.claude/settings.json` permissions to detect tools your project needs in the container.

---

## First Run

```bash
docker compose -f docker-compose.hermit.yml build
docker compose -f docker-compose.hermit.yml up -d
```

Accept the one-time **workspace trust prompt** — attach, press Enter, detach:

```bash
docker exec -it <container> tmux attach -t <session-name>
# Press Enter to accept
# Detach: Ctrl+B, D
```

Persisted in the mounted `~/.claude/` volume — won't appear on restarts. After this, your hermit runs fully unattended!

---

## Managing Your Hermit

| Action    | Command                                                       |
| --------- | ------------------------------------------------------------- |
| Start     | `docker compose -f docker-compose.hermit.yml up -d`           |
| Stop      | `docker compose -f docker-compose.hermit.yml stop`            |
| Logs      | `docker compose -f docker-compose.hermit.yml logs -f`         |
| Restart   | `docker compose -f docker-compose.hermit.yml restart`         |
| Tear down | `docker compose -f docker-compose.hermit.yml down`            |
| Status    | `.claude-code-hermit/bin/hermit-status`                       |

`hermit-status` is pure bash — no Claude Code process, no tokens burned.

---

## Auth

**OAuth token (recommended for Pro/Max):** Run `claude setup-token` on a machine with a browser. Generates a long-lived token (1 year). Add to `.env`:

```
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...
```

**API key:** For pay-per-token billing, set `ANTHROPIC_API_KEY` in `.env` instead.

The docker-setup wizard configures the right env var based on your choice and ensures `.env` is gitignored.

---

## Channels in Docker

Channel tokens live in `.claude.local/channels/<plugin>/.env` (project-local scope). The docker-setup wizard walks you through token setup and pairing.

The entrypoint automatically symlinks `~/.claude/channels/<plugin>/` to the local state dir inside the container. This means channel skill commands (`/discord:access pair`, `/discord:configure`, etc.) write to the right place — no manual patching needed.

`DISCORD_STATE_DIR` / `TELEGRAM_STATE_DIR` are set as OS env vars in the compose file so MCP servers (which don't read `settings.local.json`) can find the token and access config.

---

## Taking the Wheel

### Takeover

```
/claude-code-hermit:hermit-takeover
```

Stops the container, loads the hermit's full context, and presents a summary. You're driving interactively with full continuity.

### Hand-back

```
/claude-code-hermit:hermit-hand-back
```

Summarizes what you did, asks for instructions, and restarts the container. The hermit picks up where you left off.

### Manual alternative

```bash
docker compose -f docker-compose.hermit.yml stop       # hermit archives its work
# ... do your thing ...
docker compose -f docker-compose.hermit.yml up -d      # hermit recovers and resumes
```

---

## Quick Status

```bash
.claude-code-hermit/bin/hermit-status
```

One-liner, no tokens burned:

```
atlas (myproject) | in_progress | "Add input validation" | 2/4 steps | $1.80/$5.00 | no blockers | docker:up
```

---

## Crash Recovery

Container restarts trigger recovery automatically:

1. Entrypoint re-seeds onboarding bypass and channel symlinks
2. `hermit-start` launches tmux with Claude Code
3. SessionStart hook detects the orphaned SHELL.md
4. Hermit offers to resume where it left off

`restart: unless-stopped` handles crashes and host reboots. State is on disk via bind mounts — nothing is lost.

---

## Cost Management

**Per-session budget:** `/claude-code-hermit:hermit-settings budget`. Warns at 80%, recommends closing at 100%.

**Token optimization** (managed in `config.json` `env`):

| Setting                            | Value   | Effect                           |
| ---------------------------------- | ------- | -------------------------------- |
| `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`  | `50`    | Compacts at 50% context          |
| `MAX_THINKING_TOKENS`              | `10000` | Prevents runaway reasoning costs |

Adjust with `/hermit-settings env`.

---

## Gotchas

| Issue | Fix |
| --- | --- |
| Ubuntu 24.04 default user conflicts at UID 1000 | `userdel -r ubuntu` before `useradd` — handled by Dockerfile |
| Volume paths must match host | `${PWD}:${PWD}`, not `/app` or `/project` |
| OAuth tokens from `/login` expire in 8-12 hours | Use `claude setup-token` (1-year token) |
| Entrypoint exits after tmux spawns | Entrypoint polls `tmux has-session` to keep PID 1 alive |
| `.local` mDNS hostnames don't resolve | Use IP addresses in service URLs, even with `network_mode: host` |
| Workspace trust prompt on first run | Attach once, press Enter, detach |
| `permission_mode` stays `bypassPermissions` after Docker | Reset via `/hermit-settings permissions` if you run locally later |
| Windows paths break config | Must run from WSL2 — clone inside WSL2 (`/home/you/project`) |
| Docker not available | Channels still work — see [Always-On Operations](ALWAYS-ON-OPS.md) for bare tmux |
