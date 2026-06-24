<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License" /></a>
  <a href="https://code.claude.com/docs/en/plugins"><img src="https://img.shields.io/badge/Claude%20Code-plugin-orange.svg" alt="Claude Code Plugin" /></a>
  <a href="CHANGELOG.md"><img src="https://img.shields.io/badge/version-0.0.3-green.svg" alt="Version 0.0.3" /></a>
  <img src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg" alt="PRs Welcome" />
  <a href="https://discord.gg/54sJqAxhUh"><img src="https://img.shields.io/badge/Discord-Join-5865F2?logo=discord&logoColor=white" alt="Join" /></a>
</p>

# laravel-forge-hermit

Turn Claude Code into a 24/7 assistant for your [Laravel Forge](https://forge.laravel.com) estate. **Forge-aware**, **Surface-then-approve**, **Official PHP SDK**, **Built on `claude-code-hermit`**.

<p align="center">
  <img src="../claude-code-hermit/assets/cover.png" alt="Always-on Claude Code Laravel Forge Agent" width="720" />
</p>

Deploys, manages servers and sites, reads logs, and runs a daily estate health scan — never firing a write without showing you the canonical target first. Wires the official `laravel/forge-sdk` PHP v4 into the [`claude-code-hermit`](https://github.com/gtapps/claude-code-hermit) loop, with a write-confirmation gate in front of every deploy and reboot.

```
# Install
claude plugin marketplace add gtapps/claude-code-hermit
claude plugin install laravel-forge-hermit@claude-code-hermit --scope local

# Setup wizard
/laravel-forge-hermit:hatch

# Go always-on
/claude-code-hermit:docker-setup
```

---

## What you get

| Skill | Purpose |
|---|---|
| `/laravel-forge-hermit:forge-servers` | List servers, show detail, reboot (with preview → approve flow) |
| `/laravel-forge-hermit:forge-sites` | List and inspect sites |
| `/laravel-forge-hermit:forge-deploy` | Preview → approve → deploy; a hermit `/watch` monitors to completion; failure writes a scrubbed `deploy-incident` |
| `/laravel-forge-hermit:forge-logs` | Latest deployment log, specific deployment log, server log, triage mode |
| `/laravel-forge-hermit:forge-failed-deploys` | Daily estate scan — surfaces sites with failed latest deployments as `[reliability]` proposals |

Every write operation goes through **surface-then-approve**: the canonical target (server name, IP, site name, IDs) is shown before any `--confirm` flag is sent. A wrong reboot is an outage.

---

## Quick Start

> **Prerequisites:** [Claude Code](https://code.claude.com) v2.1.172+, a paid Claude plan (Pro, Max, Teams, or Enterprise), PHP 8.5+ with `ext-json` and `ext-curl`, Composer (for the SDK install at hatch time), and a [Laravel Forge API token](https://forge.laravel.com/profile/api).

### 1. Install

```bash
cd /path/to/your/project   # any folder — empty is fine
claude plugin marketplace add gtapps/claude-code-hermit
claude plugin install laravel-forge-hermit@claude-code-hermit --scope local
```

### 2. Initialize

```
/laravel-forge-hermit:hatch
```

The wizard triggers `claude-code-hermit:hatch` if the core hermit isn't ready, prompts for your `FORGE_API_TOKEN`, installs `laravel/forge-sdk` into an isolated runtime tree (`.claude-code-hermit/forge-runtime/`), injects the Forge Workflow block into your `CLAUDE.md`, and registers the daily estate scan.

> **Just trying it?** After `hatch`, run `.claude-code-hermit/bin/hermit-start --no-tmux` for sessions, routines, heartbeat, and the learning loop without 24/7 autonomy. Run `/claude-code-hermit:channel-setup` first if you want Discord or Telegram.

### 3. Go Always-On

```
/claude-code-hermit:docker-setup
```

Generates the Docker scaffolding, builds the image, starts the container, and walks through auth and channel pairing. The container ships with the hardening baseline (`cap_drop: ALL`, `no-new-privileges`, `pids_limit`); see [DOCKER.md](DOCKER.md) for the Forge-specific apt deps and DNS allowlist. For LAN containment + resource bounds, follow up with [`/claude-code-hermit:docker-security`](https://github.com/gtapps/claude-code-hermit/blob/main/plugins/claude-code-hermit/docs/docker-security.md).

See [Always-On Setup](https://github.com/gtapps/claude-code-hermit/blob/main/plugins/claude-code-hermit/docs/always-on.md) for the full guide. Want always-on without Docker? See [Always-On Operations](https://github.com/gtapps/claude-code-hermit/blob/main/plugins/claude-code-hermit/docs/always-on-ops.md) for bare tmux.

### Upgrading

```
claude plugin update claude-code-hermit@claude-code-hermit --scope local
claude plugin update laravel-forge-hermit@claude-code-hermit --scope local
/claude-code-hermit:hermit-evolve
```

---

## Safety

Writes are gated by two independent layers — neither is optional:

- **`write-confirm-gate` hook** — a `PreToolUse` Bash hook that blocks any `deploy` or `server-reboot` call lacking `--confirm`.
- **In-PHP `--confirm` gate** — `forge.php` re-checks the flag before the SDK fires. Generic dispatch (`forge.php call <method>`) is read-only by design (closed allowlist); writes only flow through the curated `deploy` / `server-reboot` commands.

- **Surface-then-approve** — the canonical target is relayed and approved before any write re-runs with `--confirm`.
- **Logs are scrubbed** — deployment and server logs may carry secrets; they're scrubbed before relay and before persistence.
- **TOKEN-pattern guard** — the base hermit's deny-patterns hook blocks any Bash arg containing the literal `TOKEN`. Credential state is checked with `forge.php check`, never by reading `.env`.

---

## Configure it

| Key | Description |
|-----|-------------|
| `FORGE_API_TOKEN` | Laravel Forge API token, in the gitignored `.env` |

Everything else — model, heartbeat, idle behavior, per-routine model — is core, tuned with `/hermit-settings`: see core's [Configure it](https://github.com/gtapps/claude-code-hermit/blob/main/plugins/claude-code-hermit/README.md#configure-it) and [Tips & tuning](https://github.com/gtapps/claude-code-hermit/blob/main/plugins/claude-code-hermit/README.md#tips--tuning).

---

## Architecture

`forge.php` is a pure PHP dispatch script the agent calls directly via Bash. The `laravel/forge-sdk` v4 handles all HTTP — no hand-rolled API client, no bun CLI, no bridge process. The vendor tree is **not committed** — hatch runs `composer install --no-dev` into `.claude-code-hermit/forge-runtime/` (persistent, bind-mounted in Docker, isolated from your app's own `composer.json`/`vendor/`).

---

## Requirements

- `claude-code-hermit` ≥1.2.11 (core)
- PHP 8.5+ with `ext-json` and `ext-curl`
- Composer (for the SDK install at hatch time)

**Docker**: targets Ubuntu 26.04 LTS base (ships PHP 8.5 natively). Requires the core base bump to 26.04.

---

## Credits

- Built on [`claude-code-hermit`](https://github.com/gtapps/claude-code-hermit) — session lifecycle, proposals, routines, memory, cost tracking
- Uses the official [`laravel/forge-sdk`](https://github.com/laravel/forge-sdk) PHP v4 and the [Laravel Forge API](https://forge.laravel.com/api-documentation)

## License

[MIT](LICENSE)
