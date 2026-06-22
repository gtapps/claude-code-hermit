# Changelog — laravel-forge-hermit

## [0.0.1] — 2026-06-22

### Added

- **forge.php: dispatch script** — pure PHP v8.5+ over `laravel/forge-sdk` v4; read-only generic dispatch (`call <method>`, closed allowlist), curated read commands, preview commands, `--confirm`-gated `deploy` (fire-and-return) + `server-reboot`, `deploy-status` poll, `failed-deploys` org-wide scan.
- **write-confirm-gate hook** — PreToolUse Bash hook; blocks `deploy`/`server-reboot` lacking `--confirm`, passes all preview/read commands, fails open on unparseable input.
- **6 skills**: `hatch`, `forge-servers`, `forge-sites`, `forge-deploy`, `forge-logs`, `forge-failed-deploys`.
- **forge-deploy watch via the hermit watch registry** — `deploy` returns immediately with canonical IDs; the skill arms a non-blocking watch through `/claude-code-hermit:watch` that polls `deploy-status` to a terminal state, then relays the outcome via the core Operator Notification protocol.
- **`forge-failed-deploys` scheduled check** — daily estate scan via `organizationSites()->lazy()`; analysis-only, routes `[reliability]` proposals.
- **`deploy-incident` artifact** — on a failed terminal deploy status, `forge-deploy` writes a scrubbed log tail to `compiled/deploy-incident-<site>-<date>.md`.
- **Vendor-free shipping** — `composer.json` + `composer.lock` ship; `hatch` installs SDK `--no-dev` into `<project>/.claude-code-hermit/forge-runtime/` (isolated from app deps).
- **Docker support** — `DOCKER.md` wires `php-cli`, `php-curl`, `composer` apt packages + `forge.laravel.com` + packagist/github DNS allowlist; targets Ubuntu 26.04 LTS base (core prerequisite).
