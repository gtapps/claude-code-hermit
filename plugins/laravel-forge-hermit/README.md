# laravel-forge-hermit

A [claude-code-hermit](https://github.com/gtapps/claude-code-hermit) domain plugin for [Laravel Forge](https://forge.laravel.com): deployments, server/site management, log reading, and a daily estate health scan — via the official `laravel/forge-sdk` PHP v4.

## Install

```
claude plugin marketplace add gtapps/claude-code-hermit
claude plugin install laravel-forge-hermit@claude-code-hermit --scope local
```

Then run `/laravel-forge-hermit:hatch` in your project (requires `claude-code-hermit` ≥1.1.1 and PHP 8.5+).

## What you get

| Skill | Purpose |
|---|---|
| `/laravel-forge-hermit:forge-servers` | List servers, show detail, reboot (with preview → approve flow) |
| `/laravel-forge-hermit:forge-sites` | List and inspect sites |
| `/laravel-forge-hermit:forge-deploy` | Preview → approve → deploy; a hermit `/watch` monitors to completion; failure writes a scrubbed `deploy-incident` |
| `/laravel-forge-hermit:forge-logs` | Latest deployment log, specific deployment log, server log, triage mode |
| `/laravel-forge-hermit:forge-failed-deploys` | Daily estate scan — surfaces sites with failed latest deployments as `[reliability]` proposals |

Every write operation goes through **surface-then-approve**: the canonical target (server name, IP, site name, IDs) is shown before any `--confirm` flag is sent. A wrong reboot is an outage.

## Requirements

- `claude-code-hermit` ≥1.1.1
- PHP 8.5+ with `ext-json` and `ext-curl`
- Composer (for SDK install at hatch time)

**Docker**: targets Ubuntu 26.04 LTS base (ships PHP 8.5 natively). Requires the core base bump to 26.04.

## Architecture

`forge.php` is a pure PHP dispatch script the agent calls directly via Bash. The `laravel/forge-sdk` v4 handles all HTTP. The vendor tree is not committed — hatch runs `composer install --no-dev` into `.claude-code-hermit/forge-runtime/` (persistent, isolated from your app's own deps).

## License

MIT
