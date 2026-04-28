---
name: hatch
description: Activate the dev hermit in the current project. Appends the dev safety rules to CLAUDE.md, captures test/lint/format/PR-template commands, installs the git-push-guard hook at strict profile by default, and offers companion plugins. Run once per project after /claude-code-hermit:hatch; re-run to update individual settings.
---

# Activate Dev Hermit

Set up the language-agnostic safety layer for this project. Requires `claude-code-hermit` core to be initialized first.

The plugin's identity in v0.3.0+: a thin wrapper around (a) `git-push-guard` strict-profile hook, (b) `state-templates/CLAUDE-APPEND.md` rules injected into the project's CLAUDE.md, (c) `/dev-pr` to push and open the PR. There is no built-in implementer agent — operators use the native `Agent` tool, `feature-dev`, or custom subagents, all governed by the injected rules.

## Plan

### 1. Check prerequisites

Check if `.claude-code-hermit/` exists in the current project.

- Missing: ask the operator (`AskUserQuestion`) "Core hermit isn't set up yet. Run `/claude-code-hermit:hatch` now?" with options `Yes — run now` / `No — I'll do it later`. If yes, invoke `/claude-code-hermit:hatch`, then continue. If no, stop.
- Present: read `.claude-code-hermit/config.json` and the plugin's `${CLAUDE_PLUGIN_ROOT}/.claude-plugin/hermit-meta.json`. Verify `_hermit_versions["claude-code-hermit"]` from config satisfies `required_core_version` from hermit-meta (e.g. `">=1.0.22"`). If absent or below the floor, ask whether to run `/claude-code-hermit:hermit-evolve` first; allow opt-out with a warning. (Reading the floor from hermit-meta — never hardcoding it in skill prose — keeps this skill in sync with the plugin's declared requirement.)

### 2. Update CLAUDE.md dev block

Read the cached `${CLAUDE_PLUGIN_ROOT}/state-templates/CLAUDE-APPEND.md` and `${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json`.

Look for the marker comment `<!-- claude-code-dev-hermit: Development Workflow -->` in the project's `CLAUDE.md`.

- Marker absent: append the cached template to `CLAUDE.md`.
- Marker present, stamped version differs from the plugin version: silently replace the existing block with the cached template.
- Marker present, versions match: skip — block is current.

The template is the source of truth. No operator prompt is needed for this step.

### 3. Detect, then ask

This skill is **idempotent**. Every config key shown below is ALWAYS prompted; for keys already set in `config.json`, the prompt offers `Keep current (<value>)` as the first (recommended) option so the operator can sweep through Enter-presses to fast-confirm. There is no `--reset` mode — re-running and pressing Enter for every key is the equivalent.

**Placeholder convention.** Strings in angle brackets in the question definitions below (e.g. `<value>`, `<detected default>`, `<detected path>`) are templating placeholders. Substitute them with concrete runtime values before passing to `AskUserQuestion`. Never pass the literal angle-bracket string.

Run all detection in a single parallel turn before asking anything:

**Bash:**
- Existing PR template: `ls .github/PULL_REQUEST_TEMPLATE.md docs/pull_request_template.md 2>/dev/null | head -1`.
- Installed plugins: `claude plugin list 2>/dev/null` or read `.claude/settings.json`.
- Remote host (for `commands.pr_create` default): `git remote get-url origin 2>/dev/null` — if the URL contains `gitlab`, default `pr_create` to `glab pr create`; else default to `gh pr create`.

**File reads:**
- `OPERATOR.md` if present (check for `## Development Conventions` section).
- The project's main config files for stack hints — `package.json`, `Cargo.toml`, `pyproject.toml`, `Gemfile`, `pom.xml`, `go.mod`. Use these only to seed reasonable defaults for the test command prompt; never assume them.

#### Round 1 — commands and safety

Single `AskUserQuestion` call with up to 4 questions. ALWAYS include all four; for keys already in `config.json`, prepend `Keep current (<value>)` as the first option (and recommend it).

```
questions: [
  {
    header: "Test cmd",
    question: "How do you run the test suite? (e.g. `npm test`, `pytest -q`, `cargo test`, `go test ./...`)",
    options: [
      { label: "Keep current (<value>)", description: "Already configured" },          // only on re-run
      { label: "<detected default>", description: "Auto-detected from <package.json|Cargo.toml|...>" },
      { label: "Other", description: "Type the command" }
    ]
  },
  {
    header: "Lint cmd",
    question: "Lint command? (optional — leave blank to skip)",
    options: [
      { label: "Keep current (<value>)", description: "Already configured" },
      { label: "<detected default>", description: "From package.json scripts.lint / project config" },
      { label: "Skip", description: "No lint step" },
      { label: "Other", description: "Type the command" }
    ]
  },
  {
    header: "Format cmd",
    question: "Format command? (optional — leave blank to skip)",
    options: [
      { label: "Keep current (<value>)", description: "Already configured" },
      { label: "<detected default>", description: "From project config" },
      { label: "Skip", description: "No format step" },
      { label: "Other", description: "Type the command" }
    ]
  },
  {
    header: "Protected",
    question: "Protected branches (comma-separated, glob patterns OK)?",
    options: [
      { label: "Keep current (<value>)", description: "Already configured" },
      { label: "main, master", description: "Defaults" },
      { label: "Other", description: "Type the list" }
    ]
  }
]
```

#### Round 2 — hook profile and companions

`git-push-guard` defaults to **strict**. The wizard does not ask which profile to use; it installs strict and offers an opt-out.

If `env.AGENT_HOOK_PROFILE` is already `"strict"` in config, replace the Hook question's options below with a single `Keep current (strict already active)` confirmation — never present an opt-out path that would silently downgrade an existing strict install.

```
questions: [
  {
    header: "Hook",
    question: "Install git-push-guard at strict profile? (Blocks direct push to protected branches, --no-verify, force-push, --mirror/--all.)",
    options: [
      { label: "Yes — strict (recommended)", description: "Hook hard-blocks the listed operations" },
      { label: "No — leave at standard", description: "Prose rules in CLAUDE-APPEND still apply, but no hook enforcement" }
    ]
  },
  {
    header: "PR template",
    question: "PR template path? (auto-detected: `<detected or 'none'>`)",
    options: [
      { label: "Keep current (<value>)", description: "Already configured" },                  // re-run
      { label: "<detected path>", description: "Append this template after the assembled body" },  // when detected
      { label: "Skip", description: "No project PR template" },
      { label: "Other", description: "Type a path" }
    ]
  },
  {
    header: "Plugins",
    question: "Install companion plugins?",
    multiSelect: true,
    options: [
      { label: "code-review", description: "Second-pass review for PRs and high-stakes code" },
      { label: "feature-dev", description: "Architect/explorer/reviewer agents for guided feature dev" },
      { label: "context7", description: "Live docs lookup for framework APIs" }
    ]
  }
]
```

Filter the Plugins `options` array to only those NOT already installed (per the `claude plugin list` detection above). If the filtered list is empty, skip the Plugins question entirely.

If `OPERATOR.md` exists and does NOT contain a `## Development Conventions` section, append the answers under that heading.

### 4. Write config and stamp version

Single atomic config.json write:

- `claude-code-dev-hermit.commands.test` — required, from Round 1.
- `claude-code-dev-hermit.commands.lint` — optional.
- `claude-code-dev-hermit.commands.format` — optional.
- `claude-code-dev-hermit.commands.pr_create` — from the remote-host detection above (`gh pr create` / `glab pr create`); preserve any existing operator override.
- `claude-code-dev-hermit.protected_branches` — array. The Round 1 prompt accepts a comma-separated string; split on `,`, trim each entry, drop empties before writing.
- `claude-code-dev-hermit.pr_template_path` — optional, from Round 2.
- `env.AGENT_HOOK_PROFILE`:
  - If the operator accepted strict in Round 2 → write `"strict"`.
  - Else if the existing value is already `"strict"` → preserve it (never silently downgrade).
  - Else → write `"standard"` explicitly. Do not leave the key unset; an explicit value makes the operator's choice durable across `hermit-evolve` runs and prevents silent re-prompting.
- `_hermit_versions["claude-code-dev-hermit"]` — set to the plugin version cached in step 2.

For each selected companion plugin: `claude plugin install <plugin>@claude-plugins-official --scope project`.

### 5. Report results

Print a summary that reflects what actually happened:

```
Dev hermit activated (claude-code-dev-hermit vX.Y.Z).

Git safety:
  Hook profile: strict (git-push-guard active)  [or: standard — no hook enforcement]
  Protected branches: main, master  [or whatever was set]

Commands:
  Test:   <cmd>
  Lint:   <cmd or 'skipped'>
  Format: <cmd or 'skipped'>

Updated:
  CLAUDE.md — dev block [appended / updated to vX.Y.Z / already current]
  OPERATOR.md — dev conventions [added / already present / skipped]
  PR template: <path or 'none'>

Companion plugins:
  [installed: code-review, feature-dev, context7  /  partial  /  none]

Available skills:
  /claude-code-dev-hermit:hatch    — re-run to update settings (idempotent)
  /claude-code-dev-hermit:dev-pr   — push the current branch and open a PR

Conventions are in CLAUDE.md (§Git Safety, §Branch Discipline,
§Implementation Flow, §Tests Before PR). Any agent doing dev
work in this project — native Agent, feature-dev, custom — must
follow them.
```

## Rules

- **Strict-by-default.** The wizard defaults to installing `git-push-guard` at strict. Do not ask "which profile?" — ask "yes or opt out?".
- **Idempotent.** Re-running detects existing `config.json` values and offers `Keep current (<value>)` as the first option per key, so operators can fast-confirm with Enter presses.
- **Single source of truth.** `state-templates/CLAUDE-APPEND.md` is the source for the project's dev conventions. Step 2 always overwrites the marked block when versions differ; do not preserve operator edits to that block (operators who want overrides put them elsewhere in their CLAUDE.md).
- **Never downgrade hook profile.** If the operator chooses "No — leave at standard" but `env.AGENT_HOOK_PROFILE` is already `strict`, preserve `strict`. The opt-out only applies on first install.
- **No stack detection magic.** Detection seeds defaults for prompts; operators always confirm. Never write `commands.test` from detection alone — it must be operator-confirmed.
