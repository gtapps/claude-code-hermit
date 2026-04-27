---
name: dev-adapt
description: Discover this project's test commands, protected branches, dev-server setup (start command, ports, health URL, log path), and stack details. Persists findings under claude-code-dev-hermit.* in config.json and writes a compiled/dev-profile artifact. Run after /hatch or whenever the project's testing or CI setup changes.
---

# /dev-adapt

Profile the current project and persist the findings to config. Hatch calls this on first setup; operators call it directly when the project's testing story changes.

## Steps

### 1. Read the project

In parallel, read:

- `package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, `Gemfile`, `composer.json`, `build.gradle*`, `pom.xml` — stack and package-manager signals
- `Makefile`, `justfile`, `Taskfile.yml`, `scripts/` (list top-level scripts) — custom runners
- `.github/workflows/*.yml` or `.github/workflows/*.yaml` — CI workflows and environment/branch triggers
- `.gitlab-ci.yml`, `Jenkinsfile`, `.circleci/config.yml` if present
- Root `README.md` and `CONTRIBUTING.md` — sections mentioning "test", "lint", "typecheck", "build"
- `CLAUDE.md`, `OPERATOR.md` — any existing documented test/lint commands
- `claude-code-dev-hermit.*` fields from `.claude-code-hermit/config.json` — show currently persisted values
- `package.json` `scripts.dev` / `scripts.start:dev` / `scripts.start`, `composer.json` `scripts.serve` / `scripts.start` / `scripts.dev`, `Procfile.dev` / `bin/dev` / `artisan` (Laravel) / `bin/console` (Symfony) — dev-server start command signals
- `.infisical.json`, `.envrc`, `.op-secrets.json`, `.envrc.example` — auth/secrets tooling presence
- `logs/`, `log/`, `var/log/`, `storage/logs/` directory listings — dev log file locations (date-suffixed Winston/Pino/structlog/Laravel-daily vs fixed Rails/Laravel-single/Symfony-Monolog)

Also run:

```bash
git branch -r 2>/dev/null | head -20
git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null
git log --no-merges --pretty=format:'%s' -50
```

### 2. Propose findings

Using everything read in step 1, propose:

**Commands** — for each type (`test`, `typecheck`, `lint`), propose the best command with:
- `command`: exact string to run
- `confidence`: `high` (direct evidence in package.json scripts / pyproject test section / Cargo.toml) | `medium` (inferred from CI or README) | `low` (guessed from tool presence)
- `evidence`: one-line citation ("from `package.json scripts.test`", "from CI workflow `ci.yml` step `Run tests`", "inferred from `pytest.ini` presence")
- `null` if no reliable signal — do not guess

**Commit format** — classify the commit subjects from `git log`:
- **Conventional Commits:** `^(feat|fix|docs|style|refactor|perf|test|chore|build|ci|revert)(\([^)]+\))?!?: .+`
- **Gitmoji** (both `:emoji_name:` and raw unicode emoji): `^(:[a-z_]+:|<unicode emoji>) .+` — apply this by reading the first character of each subject line, not via shell regex
- **Threshold:** if ≥70% of commits match one pattern AND the log has ≥10 commits, classify as `"conventional"` or `"gitmoji"`. Otherwise: `null` (freeform or too few commits to judge).
- Persist the matched regex alongside the classification — the implementer uses it to validate its own commit messages.

**Protected branches** — propose the list by combining:
- Branches matching names seen in CI `on.push.branches`, `environment:` deployments, `branches:` filters
- Branches from `git branch -r` matching common patterns (main, master, staging, production, release/*)
- Any branch marked "protected" or "mainline" in OPERATOR.md/README
- Normalize: strip `origin/` prefix from remote refs

**Dev environment** — propose the dev-server setup. **Skip this entire block** for stacks where it doesn't apply (mobile dev, desktop apps, libraries, embedded). Indicators of "service-on-port" archetype: `package.json` has `scripts.dev`/`scripts.start:dev`, framework files (`next.config.*`, `nuxt.config.*`, `vite.config.*`, `manage.py`, `config/application.rb`, Spring `pom.xml`/`build.gradle`, `main.go` with HTTP serving, Laravel `artisan` + `routes/web.php`, Symfony `bin/console` + `composer.json` `symfony/framework-bundle`, generic PHP with `composer.json` + `index.php`, etc.).

- **`commands.dev_start`** — scan `package.json#scripts` (priority order: `dev`, `start:dev`, `start`); also check `composer.json#scripts` for `serve`/`start`/`dev`. Fall back to language defaults: `cargo run`, `bundle exec rails s`, `mvn spring-boot:run`, `python manage.py runserver`, `flask run`, `uvicorn main:app --reload`, `php artisan serve` (Laravel), `symfony serve --no-tls` (Symfony with the `symfony` CLI), `php -S localhost:8000 -t public` (vanilla PHP), `go run ./cmd/...`.
- **`commands.dev_stop`** — leave null by default. Set to `docker compose down` if `docker-compose.yml` is the dev entry, `bin/dev stop` if `bin/dev` exists, or operator-supplied for supervisord/foreman.
- **`dev_required_ports`** — parse the start command for `--port`/`-p N`/`PORT=N`; otherwise use language conventions: Next/Vite 3000, Nuxt 3000, Rails 3000, Django 8000, Flask 5000, FastAPI 8000, Spring 8080, Go conventional 8080, Laravel `artisan serve` 8000, Symfony 8000, vanilla PHP `-S` whatever the command pins (commonly 8000). Multi-port stacks (e.g., separate websocket): list all detected.
- **`dev_health_url`** — leave null. We cannot probe candidate endpoints without booting the server, and a "low confidence proposal" forces an unproductive AskUserQuestion ("is /api/health the right URL?" — operator doesn't know without running it). `/dev-up` Gate 6 PASS-with-skips when this is null. The operator can fill it in later by editing `config.json` directly or re-running `/dev-adapt` after they've verified the endpoint manually. Do NOT include `dev_health_url` in the AskUserQuestion proposal — surface the recommendation in the report instead: "tip: once your dev server is running, set `dev_health_url` to the readiness endpoint (e.g. `/api/health`, `/healthz`, `/actuator/health`) so `/dev-up` can verify boot before returning."
- **`dev_health_timeout_secs`** — default 30. Bump to 120 if Spring/Quarkus detected (JVM cold start), 90 if Rust (compilation), 60 if monorepo with many packages. Surface the recommendation in the report and let the operator override.
- **`dev_auth_check`** — if `.infisical.json` present, propose `infisical secrets >/dev/null 2>&1`. If `.envrc` present, propose `direnv status | grep -q "Loaded RC"`. If `.op-secrets.json` present, propose `op signin --account <account> 2>/dev/null`. Otherwise null. **Surface the proposal as a starter, not a guaranteed-correct command:** the operator must verify the suggestion exits non-zero when unauthenticated AND zero when authenticated. S-006 hit this exact bug — `infisical user` exits 0 unconditionally because it's a help page; a poorly-chosen check is worse than no check at all (false-green on Gate 2). Recommend the operator run the proposed command twice — once with creds loaded, once without — and confirm both exit codes before persisting. Also note: a passing auth probe is a positive signal, not a guarantee that the spawned dev-server inherits the same env (separate processes can pick up different cached tokens).
- **`dev_log_path_pattern`** — probe in priority order: `logs/app-*.log` (Winston daily) → propose `logs/app-$(date +%Y-%m-%d).log`; `logs/*.ndjson` (Pino with date transport) → propose `logs/$(date +%Y-%m-%d).ndjson`; `log/development.log` (Rails) → propose verbatim (fixed path); `var/log/<app>/*.log` (Spring/Logback) → propose with date if pattern matches; `storage/logs/laravel.log` (Laravel default Monolog single file) → propose verbatim; `storage/logs/laravel-*.log` (Laravel daily channel) → propose `storage/logs/laravel-$(date +%Y-%m-%d).log`; `var/log/dev.log` (Symfony default Monolog) → propose verbatim. Leave null if nothing on disk yet.
- **`dev_error_pattern`** — stack-aware default: Winston/structlog JSON → `"level":"error"|^ERROR`; Pino → `"level":50|^ERROR`; Rails → `^[FE],` (Lograge severity prefix); Spring/Logback → `\\sERROR\\s`; Monolog (Laravel/Symfony default formatter) → `\\.(ERROR|CRITICAL|ALERT|EMERGENCY):\\s`; Monolog JSON formatter → `"level_name":"(ERROR|CRITICAL|ALERT|EMERGENCY)"`. Operator-tunable.
- **`dev_noise_pattern`** — leave null. Operators add lines to suppress over time as they observe their own logs.
- **`dev_expected_listeners`** — leave empty by default. dev-doctor surfaces "port X held by process Y; if expected, add to dev_expected_listeners" when a port-collision is encountered.

### 3. Confirm with operator

Use `AskUserQuestion` with up to 4 confirmations. Skip any question whose answer was already confirmed in a prior run (compare with existing `claude-code-dev-hermit.*` config).

```
questions: [
  {
    header: "Test command",
    question: "Detected test command [confidence]: `<command>` — from <evidence>. Use this?",
    options: [
      { label: "Yes", description: "Persist as claude-code-dev-hermit.commands.test" },
      { label: "Edit", description: "I'll provide the correct command" },
      { label: "Skip", description: "Don't configure a test command" }
    ]
  },
  {
    header: "Typecheck / lint",
    question: "Detected: typecheck=`<cmd>` lint=`<cmd>` (or none). Confirm?",
    options: [
      { label: "Confirm", description: "Persist both" },
      { label: "Edit", description: "I'll correct them" },
      { label: "Skip", description: "Don't configure" }
    ]
  },
  {
    header: "Protected branches",
    question: "Proposed protected branches: [<list>]. Correct?",
    options: [
      { label: "Yes", description: "Persist this list" },
      { label: "Edit", description: "I'll provide the correct list" }
    ]
  },
  {
    header: "Dev environment",
    question: "Detected dev setup — start: `<command>`, ports: [<ports>], health: <url|none>, log: <path|none>, auth-check: <cmd|none>. Use these?",
    options: [
      { label: "Yes", description: "Persist all dev_* values to config (used by /dev-up, /dev-down, /dev-log-watch)" },
      { label: "Edit", description: "I'll correct one or more fields" },
      { label: "Skip", description: "This project does not have a service-on-port dev workflow" }
    ]
  }
]
```

Skip the "Dev environment" question entirely if Step 2 detected no dev signals (no package.json scripts.dev, no framework markers, no log dirs). The dev_* fields stay unset and the dev-up/dev-down/dev-log-watch skills will refuse with an actionable message.

If confidence is `high` for a command, inline-confirm without asking ("Detected: `npm test` from `package.json scripts.test` — confirmed") and skip the AskUserQuestion for that slot.

### 4. Persist to config

Write confirmed values to `.claude-code-hermit/config.json` under `claude-code-dev-hermit`:

```json
{
  "claude-code-dev-hermit": {
    "commands": {
      "test": "<confirmed command or null>",
      "typecheck": "<confirmed command or null>",
      "lint": "<confirmed command or null>",
      "dev_start": "<confirmed dev start command or null>",
      "dev_stop": "<confirmed dev stop command or null>"
    },
    "protected_branches": ["<branch1>", "release/*"],
    "commit_format": "conventional" | "gitmoji" | null,
    "commit_format_pattern": "<the matched regex string, or null>",
    "dev_required_ports": [3000, 4000],
    "dev_expected_listeners": [],
    "dev_health_url": "<url or null>",
    "dev_health_timeout_secs": 30,
    "dev_auth_check": "<bash one-liner or null>",
    "dev_log_path_pattern": "<path with optional $(date ...) or null>",
    "dev_error_pattern": "<grep -E regex or null>",
    "dev_noise_pattern": null
  }
}
```

`commit_format` is auto-detected — no operator confirmation needed (it's derived from existing history, not a choice). If the repo has fewer than 10 commits or mixed style, write `null` and omit `commit_format_pattern`.

Omit any `dev_*` field whose value is `null` and whose key is not already present in the existing config — keep the file lean. If the operator chose "Skip" on the dev environment question (or no dev signals were detected), do NOT write any `dev_*` keys.

Merge into existing config — do not overwrite unrelated keys. The plugin-name key matches the `_hermit_versions["claude-code-dev-hermit"]` pattern already established by core, keeping plugin-owned state plugin-scoped.

### 5. Write compiled artifact

Write `.claude-code-hermit/compiled/dev-profile-<YYYY-MM-DD>.md` with the following frontmatter and body. Cap at 150 lines.

```yaml
---
title: Dev profile
created: <ISO 8601 timestamp with timezone>
type: dev-profile
session: <current session ID from state/runtime.json if available, else omit>
tags: [dev-profile, project-context]
---
```

**Body sections** (omit sections with no data):

```markdown
## Stack
<language(s), framework(s), primary package manager>

## Test commands
- test: `<command>` (confidence: <level>) — <evidence>
- typecheck: `<command>` (confidence: <level>) — <evidence>
- lint: `<command>` (confidence: <level>) — <evidence>

## CI
<provider name> — <workflow file(s)>
Key triggers: <on.push.branches, environment names, etc.>

## Branches
Default: <default branch>
Protected: <list>

## Deploy process
<description from OPERATOR.md / README / CI, or "not documented">

## Risk areas observed
<qualitative notes the dev-quality skill can use as context — e.g.
"auth code lives under packages/auth/, migrations under db/migrations/,
deploy config in infra/ — flag these categories for extra review">

## Dev environment
<omit this section if dev_* fields were skipped>
- start: `<command>` (confidence: <level>) — <evidence>
- stop: `<command or "none — Monitor signal">`
- ports: <list or "none configured">
- health: `<url or "not configured">` (timeout <Ns>)
- auth-check: `<one-liner or "none">`
- log: `<path pattern or "stdout — no file watch">` (<rotating|fixed>)
- errors: `<regex>` / noise: `<regex or "none">`

## Commit format
<conventional|gitmoji|freeform> — <N of 50 non-merge commits matched>

## Dependency tooling
<lockfile type, audit tool if any>

## Confidence
<overall: high/medium/low — justify briefly>

## Last refreshed
<today's date>
```

If the Cortex is set up (obsidian/ directory exists), `compiled/dev-profile-*.md` is automatically picked up by `/claude-code-hermit:cortex-refresh` via `cortex-manifest.json`. No extra registration needed.

### 6. Report

```
dev-adapt complete

  test:          npm test              (high — package.json scripts.test)
  typecheck:     npm run typecheck     (medium — tsconfig.json present)
  lint:          null                  (no signal found)
  protected:     main, staging
  commit_format: conventional          (42 of 50 recent commits match)

  dev_start:     npm run dev           (high — package.json scripts.dev)
  dev_ports:     [3000]                (Next.js conventional)
  dev_health:    /api/health           (low — operator confirm if endpoint exists)
  dev_log:       logs/app-$(date +%Y-%m-%d).log  (Winston daily transport)
  dev_auth:      direnv status | grep -q "Loaded RC"

  Written: .claude-code-hermit/compiled/dev-profile-2026-04-24.md
  Config:  .claude-code-hermit/config.json → claude-code-dev-hermit.* updated
```

Omit the dev block if the operator skipped or no dev signals were detected.
