# Changelog — laravel-forge-hermit

## [0.0.1] — 2026-06-22

### Added

- **forge.php: dispatch script** — pure PHP v8.5+ over `laravel/forge-sdk` v4; read-only generic dispatch (`call <method>`, closed allowlist), curated read commands, preview commands, `--confirm`-gated deploy/reboot, `failed-deploys` org-wide scan.
- **write-confirm-gate hook** — fail-closed PreToolUse Bash hook; blocks `deploy`/`server-reboot` lacking `--confirm`; allows all preview and read commands.
- **6 skills**: `hatch`, `forge-servers`, `forge-sites`, `forge-deploy`, `forge-logs`, `forge-failed-deploys`.
- **`forge-failed-deploys` scheduled check** — daily estate scan via `organizationSites()->lazy()`; analysis-only, routes `[reliability]` proposals.
- **`deploy-incident` artifact** — `forge-deploy --watch` failure writes scrubbed log tail to `compiled/deploy-incident-<site>-<date>.md`.
- **Vendor-free shipping** — `composer.json` + `composer.lock` ship; `hatch` installs SDK `--no-dev` into `<project>/.claude-code-hermit/forge-runtime/` (isolated from app deps).
- **Docker support** — `DOCKER.md` wires `php-cli`, `php-curl`, `composer` apt packages + `forge.laravel.com` + packagist/github DNS allowlist; targets Ubuntu 26.04 LTS base (core prerequisite).
