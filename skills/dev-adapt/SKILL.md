---
name: dev-adapt
description: Discover this project's test commands, protected branches, and stack details. Persists findings to dev.* in config.json and writes a compiled/dev-profile artifact. Run after /hatch or whenever the project's testing or CI setup changes.
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
- `dev.*` fields from `.claude-code-hermit/config.json` — show currently persisted values

Also run:

```bash
git branch -r 2>/dev/null | head -20
git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null
```

### 2. Propose findings

Using everything read in step 1, propose:

**Commands** — for each type (`test`, `typecheck`, `lint`), propose the best command with:
- `command`: exact string to run
- `confidence`: `high` (direct evidence in package.json scripts / pyproject test section / Cargo.toml) | `medium` (inferred from CI or README) | `low` (guessed from tool presence)
- `evidence`: one-line citation ("from `package.json scripts.test`", "from CI workflow `ci.yml` step `Run tests`", "inferred from `pytest.ini` presence")
- `null` if no reliable signal — do not guess

**Protected branches** — propose the list by combining:
- Branches matching names seen in CI `on.push.branches`, `environment:` deployments, `branches:` filters
- Branches from `git branch -r` matching common patterns (main, master, staging, production, release/*)
- Any branch marked "protected" or "mainline" in OPERATOR.md/README
- Normalize: strip `origin/` prefix from remote refs

### 3. Confirm with operator

Use `AskUserQuestion` with up to 3 confirmations. Skip any question whose answer was already confirmed in a prior run (compare with existing `dev.*` config).

```
questions: [
  {
    header: "Test command",
    question: "Detected test command [confidence]: `<command>` — from <evidence>. Use this?",
    options: [
      { label: "Yes", description: "Persist as dev.commands.test" },
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
  }
]
```

If confidence is `high` for a command, inline-confirm without asking ("Detected: `npm test` from `package.json scripts.test` — confirmed") and skip the AskUserQuestion for that slot.

### 4. Persist to config

Write confirmed values to `.claude-code-hermit/config.json` under `dev`:

```json
{
  "dev": {
    "commands": {
      "test": "<confirmed command or null>",
      "typecheck": "<confirmed command or null>",
      "lint": "<confirmed command or null>"
    },
    "protected_branches": ["<branch1>", "release/*"]
  }
}
```

Merge into existing config — do not overwrite unrelated keys.

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

  test:      npm test              (high — package.json scripts.test)
  typecheck: npm run typecheck     (medium — tsconfig.json present)
  lint:      null                  (no signal found)
  protected: main, staging

  Written: .claude-code-hermit/compiled/dev-profile-2026-04-24.md
  Config:  .claude-code-hermit/config.json → dev.* updated
```
