# Always-On Setup

Docker is the recommended way to run your hermit autonomously. For lifecycle internals, security hardening, and idle agency details, see [Always-On Operations](ALWAYS-ON-OPS.md).

---

## Why Docker

An always-on agent needs to act without prompts — that means `bypassPermissions`. Without isolation, bypass is reckless: the agent has full access to your host, your credentials, your network. With Docker, isolation is the whole point. The container can only see what you mount, only reach what you allow, and restarts automatically on crash.

Docker gives you three things at once: safe permission bypass (no prompts, no babysitting), crash recovery (container restarts pick up where the hermit left off), and a reproducible environment (same Node.js, same Bun, same Claude Code version across rebuilds).

---

## Prerequisites

| Requirement              | For          | Notes                                          |
| ------------------------ | ------------ | ---------------------------------------------- |
| **Docker**               | Container    | `docker compose` v2 (included with Docker Desktop and modern Docker Engine) |
| **Node.js 24+**          | Hooks        | Inside the container — handled by the Dockerfile |
| **Bun**                  | Plugins      | Inside the container — always included (needed by many Claude Code plugins) |
| **Claude Code v2.1.80+** | Channels     | Required for the channels research preview     |

---

## Setup

Run after `/claude-code-hermit:init`:

```
/claude-code-hermit:docker-setup
```

The skill checks prerequisites, asks about auth, reads your project config, and generates four hermit-namespaced files at the project root (so they don't conflict with your own Docker setup):

| File                          | Purpose                                               |
| ----------------------------- | ----------------------------------------------------- |
| `Dockerfile.hermit`           | Ubuntu 24.04, Node 24, Bun, Claude Code, host UID matching |
| `docker-entrypoint.hermit.sh` | Onboarding bypass, permission mode patch, hermit-start, PID 1 keepalive |
| `docker-compose.hermit.yml`   | Volume mounts, env vars, healthcheck, restart policy  |
| `.env`                        | Auth token (appended if file already exists)           |

---

## First Run

```bash
docker compose -f docker-compose.hermit.yml build
docker compose -f docker-compose.hermit.yml up -d
```

Claude Code shows a one-time **workspace trust prompt** that can't be automated. Attach once to accept it:

```bash
docker exec -it <container> tmux attach -t <session-name>
# Press Enter to accept workspace trust
# Detach: Ctrl+B, D
```

This is persisted in the mounted `~/.claude/` volume and won't appear on container restarts. After this, the hermit runs fully unattended.

---

## Managing Your Hermit

| Action    | Command                                                       |
| --------- | ------------------------------------------------------------- |
| Start     | `docker compose -f docker-compose.hermit.yml up -d`           |
| Stop      | `docker compose -f docker-compose.hermit.yml stop`            |
| Logs      | `docker compose -f docker-compose.hermit.yml logs -f`         |
| Restart   | `docker compose -f docker-compose.hermit.yml restart`         |
| Status    | `.claude-code-hermit/bin/hermit-status`               |

`hermit-status` is a pure bash script — no Claude Code, no tokens. See [Quick Status](#quick-status) below.

---

## Auth

**OAuth token (recommended for Pro/Max):** Run `claude setup-token` on a machine with a browser. This generates a long-lived token (valid 1 year). Add to `.env`:

```
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...
```

When it expires, re-run `claude setup-token` on the host and update `.env`.

**API key:** For pay-per-token billing, set `ANTHROPIC_API_KEY` in `.env` instead.

The `/docker-setup` skill configures the correct env var based on your choice. Ensure `.env` is in your `.gitignore` (the skill handles this).

---

## Taking the Wheel

When you need to work interactively — debug something, make manual changes, or just check in — use the takeover/hand-back workflow:

### Takeover

```
/claude-code-hermit:hermit-takeover
```

This stops the Docker container (triggering a graceful shutdown inside), marks the session as `operator_takeover`, loads the hermit's full context (OPERATOR.md, SHELL.md, latest report), and presents a summary of what the hermit was working on. You're now driving interactively with full continuity.

### Hand-back

```
/claude-code-hermit:hermit-hand-back
```

This summarizes what you did during takeover (via `git log` since the takeover timestamp), asks if you have instructions for the hermit, updates SHELL.md, and restarts the container. The hermit picks up where you left off — with your instructions queued if you provided them.

### Manual alternative

You can also just stop and restart manually:

```bash
docker compose -f docker-compose.hermit.yml stop       # hermit archives its work
# ... do your thing ...
docker compose -f docker-compose.hermit.yml up -d      # hermit recovers and asks what's next
```

The hermit will see the `operator_takeover` status (if set) or just recover normally. The takeover/hand-back skills add structure — git summaries, queued instructions — but manual restart always works.

---

## Quick Status

```bash
.claude-code-hermit/bin/hermit-status
```

One-liner output, no Claude Code process needed, no tokens burned:

```
atlas (myproject) | in_progress | "Add input validation" | 2/4 steps | $1.80/$5.00 | no blockers | docker:up
```

Fields: agent name, project, session status, current task, plan progress, cost/budget, blockers, Docker state. Missing data shows as `—`.

The script reads `.status.json` (written by the cost-tracker hook on every assistant turn) and checks Docker container state.

---

## Crash Recovery

Container restarts trigger hermit recovery automatically:

1. Entrypoint re-seeds onboarding bypass
2. `hermit-start` launches tmux with Claude Code
3. SessionStart hook detects the orphaned SHELL.md
4. Hermit offers to resume where it left off

`restart: unless-stopped` in the compose file handles crashes and host reboots (if Docker starts on boot). State is on disk via bind mounts — nothing is lost.

---

## Cost Management

**Per-session budget:** `/claude-code-hermit:hermit-settings budget`. Warns at 80%, recommends closing at 100%.

**Token optimization env vars** (set in `docker-compose.hermit.yml` by default):

| Setting                            | Value | Effect                           |
| ---------------------------------- | ----- | -------------------------------- |
| `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`  | `50`  | Compacts at 50% context — keeps working set smaller |
| `MAX_THINKING_TOKENS`              | `10000` | Prevents runaway reasoning costs |
| `CLAUDE_CODE_SUBAGENT_MODEL`       | — | Set to `haiku` for cheapest exploration (not set by default) |

**Project-level budget:** Set in OPERATOR.md (`Monthly Claude budget: $200. Alert at $150.`).

---

## Gotchas

| Issue | Fix |
| --- | --- |
| `node:22-slim` has Python 3.11 | Use `ubuntu:24.04` — the Dockerfile already does this |
| Bun not in PATH at runtime | `npm install -g bun` instead of `curl \| bash` |
| Ubuntu 24.04 default user conflicts at UID 1000 | `userdel -r ubuntu` before `useradd` — handled by Dockerfile |
| Volume paths must match host | `${PWD}:${PWD}`, not `/app` or `/project` |
| `DEVCONTAINER=true` doesn't skip onboarding | Entrypoint pre-seeds `hasCompletedOnboarding` + `lastOnboardingVersion` |
| OAuth tokens from `/login` expire in 8-12 hours | Use `claude setup-token` (1-year token) |
| Entrypoint exits immediately after tmux spawns | Entrypoint polls `tmux has-session` to keep PID 1 alive |
| `.local` mDNS hostnames don't resolve in containers | Use IP addresses in service URLs, even with `network_mode: host` |
| Workspace trust prompt on first run | Attach once via `tmux attach`, press Enter, detach |
| `permission_mode` stays `bypassPermissions` after Docker | Reset via `/hermit-settings permissions` or edit `config.json` if you run locally later |
| Windows paths break Claude Code config | Must run from WSL2 — clone inside WSL2 (`/home/you/project`), not `/mnt/c/` |
| Docker not available on the host | Channels and phone setup still work — see [Getting Started](HOW-TO-USE.md) for running with bare tmux |
