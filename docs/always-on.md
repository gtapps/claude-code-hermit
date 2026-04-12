# Always-On Setup

Docker is the recommended way to run your hermit autonomously. For lifecycle internals and bare-tmux setup, see [Always-On Operations](always-on-ops.md). For security hardening, see [Security](security.md).

---

## Why Docker

An always-on agent needs `bypassPermissions` — no prompts, no babysitting. Without isolation that's reckless. With Docker, the container can only see what you mount and restarts automatically on crash.

You get four things at once: safe permission bypass, config isolation, crash recovery, and a reproducible environment.

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

Run after `/claude-code-hermit:hatch`:

```
/claude-code-hermit:docker-setup
```

The wizard scans your project for dependencies, asks about auth, and generates four hermit-namespaced files (so they don't clash with your own Docker setup):

| File                          | Purpose                                               |
| ----------------------------- | ----------------------------------------------------- |
| `Dockerfile.hermit`           | Ubuntu 24.04, Node 24, Bun, Claude Code, project packages, host UID matching |
| `docker-entrypoint.hermit.sh` | Onboarding bypass, MCP approval, permission patch, channel symlinks, graceful SIGTERM handling, PID 1 keepalive |
| `docker-compose.hermit.yml`   | Named volume, bind mounts, env vars, healthcheck, restart policy |
| `.env`                        | Auth token (appended if file already exists)           |

The wizard also checks `.claude/settings.json` permissions to detect tools your project needs in the container.

---

## First Run

```bash
.claude-code-hermit/bin/hermit-docker up
```

This builds the image, starts the container, and prints the tmux attach command.

Accept the one-time **workspace trust prompt** — use the attach command from the output, press Enter, detach:

```bash
# Detach: Ctrl+B, D
```

Persisted in the `claude-config` named volume — won't appear on restarts. After this, your hermit runs fully unattended!

> **First run is slower** — the named volume starts empty, so the entrypoint runs onboarding bypass and installs channel plugins. Subsequent restarts are fast.

---

## Managing Your Hermit

| Action    | Command                                                       |
| --------- | ------------------------------------------------------------- |
| Start     | `.claude-code-hermit/bin/hermit-docker up`                    |
| Stop      | `.claude-code-hermit/bin/hermit-docker down`                  |
| Force stop| `.claude-code-hermit/bin/hermit-docker down --force`          |
| Attach    | `.claude-code-hermit/bin/hermit-docker attach`                |
| Logs      | `.claude-code-hermit/bin/hermit-docker logs -f`               |
| Restart   | `.claude-code-hermit/bin/hermit-docker restart`               |
| Status    | `.claude-code-hermit/bin/hermit-status`                       |

`hermit-docker up` starts the container and prints the attach command.
`hermit-docker attach` connects to the hermit's tmux session. Detach with Ctrl+B, D.
`hermit-docker down` sends a graceful session close before stopping. Use `--force` to skip.
All bin scripts are pure bash — no Claude Code process, no tokens burned.

---

## Auth

**OAuth login (recommended for Pro/Max):** After the container starts for the first time, run `claude login` inside it:

```bash
.claude-code-hermit/bin/hermit-docker login
```

This opens a browser URL for OAuth. Complete the login and credentials are saved to the container's named volume — they persist across restarts. The entrypoint waits for credentials on first boot, then starts automatically.

**API key:** For pay-per-token billing, set `ANTHROPIC_API_KEY` in `.env` instead. No container login needed.

The docker-setup wizard walks you through the right auth method and ensures `.env` is gitignored.

---

## Channels in Docker

Channel tokens live in `.claude.local/channels/<plugin>/.env` (project-local scope). The docker-setup wizard walks you through token setup and pairing.

The docker-compose file bind-mounts `.claude.local/channels/<plugin>/` into `~/.claude/channels/<plugin>/` inside the container. This means channel skill commands (`/discord:access pair`, `/discord:configure`, etc.) write to the right place — no manual patching needed, no permission prompts, and state persists even on ungraceful shutdown.

`DISCORD_STATE_DIR` / `TELEGRAM_STATE_DIR` are derived by `hermit-start` from `channels.<name>.state_dir` in config.json (relative paths are resolved against project root) and written into both the Docker compose `environment:` block and `settings.local.json`. MCP servers (channel plugins) inherit shell env but don't read `settings.local.json`, so both paths are needed.

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
.claude-code-hermit/bin/hermit-docker down   # graceful close + stop
# ... do your thing ...
.claude-code-hermit/bin/hermit-docker up     # hermit recovers and resumes
```

---

## Quick Status

```bash
.claude-code-hermit/bin/hermit-status
```

One-liner, no tokens burned:

```
atlas (myproject) | in_progress | "Add input validation" | 2/4 steps | $1.80/$5.00 | no blockers | docker:up
  attach: .claude-code-hermit/bin/hermit-docker attach
```

When Docker is running, the attach command is printed automatically.

---

## Graceful Shutdown

The entrypoint traps SIGTERM (sent by `docker compose down`, `docker stop`, or system shutdown). On signal:

1. Checks if the session is already closed (skips if `hermit-docker down` already handled it)
2. Sends `/session-close --shutdown` via tmux
3. Waits up to 30s for the session to archive
4. Exits cleanly

This means even a raw `docker compose down` (without `hermit-docker down`) will attempt to archive the session. Use `hermit-docker down` for the full 60s timeout and explicit feedback.

## Crash Recovery

Container restarts trigger recovery automatically:

1. Entrypoint re-seeds onboarding bypass and channel symlinks
2. `hermit-start` launches tmux with Claude Code
3. SessionStart hook detects the orphaned SHELL.md
4. Hermit offers to resume where it left off

`restart: unless-stopped` handles crashes and host reboots. Session state is on disk via the project bind mount, config state persists in the `claude-config` named volume — nothing is lost.

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
| OAuth credentials expired | Re-run `.claude-code-hermit/bin/hermit-docker login` and restart with `hermit-docker restart` |
| Entrypoint exits after tmux spawns | Entrypoint polls `tmux has-session` to keep PID 1 alive. SIGTERM trap handles graceful close. |
| `.local` mDNS hostnames don't resolve | Use IP addresses in service URLs, even with `network_mode: host` |
| Workspace trust prompt on first run | Attach once, press Enter, detach |
| `permission_mode` stays `bypassPermissions` after Docker | Reset via `/hermit-settings permissions` if you run locally later |
| Windows paths break config | Must run from WSL2 — clone inside WSL2 (`/home/you/project`) |
| Docker not available | Channels still work — see [Always-On Operations](always-on-ops.md) for bare tmux |

---

## Moving to a new host

Run `/claude-code-hermit:hermit-migrate` on the source machine first — it produces a full migration review and `migration-manifest.txt`. Follow the Migration Steps in its output, then handle these Docker-specific additions:

1. **Stop the container before leaving the source:** `.claude-code-hermit/bin/hermit-docker down`
2. **Auth credentials are in the named volume** (`claude-config`) — they do not migrate with the project. Re-authenticate on the destination with `hermit-docker login` after the container is up
3. **Rebuild the image on the destination:** run `/claude-code-hermit:docker-setup` (or bring up the existing compose file if the host environment is identical)

The named volume is the main Docker-specific gotcha — it holds OAuth credentials and Claude Code's internal config. There's no way to transfer it cleanly across hosts. Plan to re-authenticate on the destination.
