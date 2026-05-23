# Always-On Setup

Docker is the recommended way to run your hermit autonomously. For lifecycle internals and bare-tmux setup, see [Always-On Operations](always-on-ops.md). For security hardening, see [Security](security.md).

---

## Why Docker

An always-on agent runs without operator hand-holding. The default `auto` mode lets a classifier review each action before it runs — safer than `bypassPermissions`, more reviewed than `acceptEdits`. With Docker, the container can only see what you mount and restarts automatically on crash.

You get four things at once: config isolation, crash recovery, a reproducible environment, and permission handling that matches your risk tolerance. If your workload is truly unattended and cannot tolerate any pause for confirmation, `bypassPermissions` is still available as an explicit opt-in.

---

## Prerequisites

| Requirement              | For          | Notes                                          |
| ------------------------ | ------------ | ---------------------------------------------- |
| **Docker**               | Container    | `docker compose` v2 (Docker Desktop or modern Docker Engine) |
| **Node.js 22+**          | Hooks        | Inside the container — handled by the Dockerfile |
| **Bun**                  | Plugins      | Inside the container — always included          |
| **Claude Code v2.1.110+** | Channels     | Required for the channels research preview     |

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
| `docker-compose.hermit.yml`   | Named volume, bind mounts, env vars, healthcheck, restart policy, kernel-enforced hardening (`no-new-privileges`, `cap_drop: ALL`, `pids_limit`) |
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

## Advanced Hardening (opt-in)

Once the container is up and stable, consider running the advanced hardening wizard:

```
/claude-code-hermit:docker-security
```

It applies a `docker-compose.security.yml` overlay that the `hermit-docker` wrapper auto-detects on the next `up`. Each toggle is opt-in with honest cost/benefit framing, fully reversible, and verified live against your container:

| Toggle | What it adds | Honest limitation |
| --- | --- | --- |
| LAN containment + DNS policy | nftables firewall + dnsmasq sidecar sharing hermit's netns; blocks RFC1918, cloud metadata; port-53 redirect for actual DNS-policy enforcement | Direct-IP egress to a hardcoded public IP is **not** blocked (no DNS lookup to intercept) |
| Resource bounds + sysctls | `mem_limit`, `cpus`, ICMP-redirect / source-route hardening | Network sysctls auto-skip when `network_mode: host` |
| Plugin install audit log | One JSONL line per boot-time `claude plugin install` to `state/plugin-installs.jsonl` | Post-boot installs run via tmux are not captured |

The wizard is fleet-aware: it scans installed `*-hermit` plugins for a `## Docker network requirements` section and offers their domains and LAN suggestions for per-entry confirmation. The LAN containment toggle is **hard-skipped** when `docker.network_mode: "host"` — host mode and bridge-based netns sharing are mutually exclusive.

Reverse anytime: re-run `/docker-security` and answer No to every prompt, or `rm docker-compose.security.yml` and `hermit-docker up`. See [Security](security.md#advanced-hardening--docker-security) for the deeper treatment of what each toggle protects against and the documented limitations.

---

## Managing Your Hermit

| Action    | Command                                                       |
| --------- | ------------------------------------------------------------- |
| Start     | `.claude-code-hermit/bin/hermit-docker up`                    |
| Stop      | `.claude-code-hermit/bin/hermit-docker down`                  |
| Force stop| `.claude-code-hermit/bin/hermit-docker down --force`          |
| Attach    | `.claude-code-hermit/bin/hermit-docker attach`                |
| Shell     | `.claude-code-hermit/bin/hermit-docker bash`                  |
| Logs      | `.claude-code-hermit/bin/hermit-docker logs -f`               |
| Restart   | `.claude-code-hermit/bin/hermit-docker restart`               |
| Status    | `.claude-code-hermit/bin/hermit-status`                       |

`hermit-docker up` starts the container and prints the attach command.
`hermit-docker attach` connects to the hermit's tmux session. Detach with Ctrl+B, D.
`hermit-docker down` sends a graceful session close before stopping. Use `--force` to skip.
`hermit-docker bash` opens a shell inside the container. Use `hermit-docker bash -c "cmd"` for one-off commands.
All bin scripts are pure bash — no Claude Code process, no tokens burned.

---

## Auth

**OAuth login (recommended for Pro/Max):** After the container starts for the first time, run `claude /login` inside it:

```bash
.claude-code-hermit/bin/hermit-docker login
```

This opens a browser URL for OAuth. Complete the login and credentials are saved to the container's named volume — they persist across restarts. The entrypoint waits for credentials on first boot, then starts automatically.

**API key:** For pay-per-token billing, set `ANTHROPIC_API_KEY` in `.env` instead. No container login needed.

The docker-setup wizard walks you through the right auth method and ensures `.env` is gitignored.

---

## Channels

Channel tokens live in `.claude.local/channels/<plugin>/.env` (project-local scope). `hermit-start` derives `DISCORD_STATE_DIR` / `TELEGRAM_STATE_DIR` from `channels.<name>.state_dir` in config.json (relative paths resolved against project root) and writes them into `settings.local.json` and the shell env so MCP servers can find them.

### Docker

The docker-setup wizard walks you through token setup, state dir configuration, and pairing. The docker-compose file bind-mounts `.claude.local/channels/<plugin>/` into `~/.claude/channels/<plugin>/` inside the container — channel skill commands write to the right place automatically, and state persists across container restarts.

### Local / tmux

After `hatch` configures your channel preference, run the guided activation wizard:

```
/claude-code-hermit:channel-setup
```

It installs the plugin (requires [Bun](https://bun.sh)), writes the bot token to `.claude.local/channels/<plugin>/.env`, and walks through pairing. `hermit-start` passes `--channels` automatically — no manual flag needed. If bun is missing or the token file isn't present, `hermit-start` prints a clear warning and skips the channel.

---

## Pausing the Hermit

```bash
.claude-code-hermit/bin/hermit-docker down   # graceful close + stop
# ... do your thing ...
.claude-code-hermit/bin/hermit-docker up     # hermit recovers and resumes
```

`down` triggers a graceful session close before stopping (see [Graceful Shutdown](#graceful-shutdown) below for the exact sequence). On `up`, the hermit reads SHELL.md and the latest archived report to resume with full continuity.

To queue work for the hermit to pick up next, use `/claude-code-hermit:proposal-create` followed by `/claude-code-hermit:proposal-act accept <id>`. Accept writes `NEXT-TASK.md`, which `session-start` consumes on the next boot.

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

## Auto-Close

Heartbeat archives the session when SHELL.md has been idle for more than 12 hours:

1. `heartbeat-precheck.js` checks SHELL.md mtime on each tick
2. If idle >12h, returns the `AUTO_CLOSE` verdict
3. Heartbeat appends `[HH:MM] Heartbeat: auto-closed after 12h quiet.` to SHELL.md Monitoring (so the trace lands in the archived report, not the next session)
4. Invokes `/session-close --auto` — bypasses the operator-summary prompt and skips reflect; the heartbeat tick continues
5. The report is archived with frontmatter `closed_via: auto`

`weekly-review` includes auto-archived sessions in cost/session totals but excludes them from the autonomy-rate denominator (with an inline "(N auto-archived excluded)" note). Reflect skips them when scanning archive evidence, preventing mtime-triggered false compute-phase runs. No configuration is needed — the trigger is fixed at 12h.

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
| `permission_mode` shows `bypassPermissions` or `auto` causing unexpected pauses in fully unattended ops | Change via `/hermit-settings permissions` — use `bypassPermissions` for zero-prompt unattended Docker, `auto` for classifier-reviewed autonomy |
| Windows paths break config | Must run from WSL2 — clone inside WSL2 (`/home/you/project`) |
| Docker not available | Channels still work — see [Always-On Operations](always-on-ops.md) for bare tmux |

---

## Moving to a new host

Run `/claude-code-hermit:migrate` on the source machine first — it produces a full migration review and `migration-manifest.txt`. Follow the Migration Steps in its output, then handle these Docker-specific additions:

1. **Stop the container before leaving the source:** `.claude-code-hermit/bin/hermit-docker down`
2. **Auth credentials are in the named volume** (`claude-config`) — they do not migrate with the project. Re-authenticate on the destination with `hermit-docker login` after the container is up
3. **Rebuild the image on the destination:** run `/claude-code-hermit:docker-setup` (or bring up the existing compose file if the host environment is identical)

The named volume is the main Docker-specific gotcha — it holds OAuth credentials and Claude Code's internal config. There's no way to transfer it cleanly across hosts. Plan to re-authenticate on the destination.
