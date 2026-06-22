# laravel-forge-hermit Docker requirements

Read by `/claude-code-hermit:docker-setup` when building the hermit container image.

**Base image prerequisite**: this plugin requires PHP 8.5+, which ships natively in Ubuntu 26.04 LTS (Resolute). If the core base image is still Ubuntu 24.04, the Docker path for this plugin is blocked pending the core base bump. Bare-metal and dev-mode paths (operator-supplied PHP 8.5 + Composer) are unaffected.

## Docker apt dependencies

- php-cli
- php-curl
- composer

## Docker network requirements

Read by `/claude-code-hermit:docker-security` when the operator enables LAN containment + DNS policy.

### Domains (DNS allowlist)

- forge.laravel.com
- packagist.org
- repo.packagist.org
- api.github.com
- codeload.github.com
