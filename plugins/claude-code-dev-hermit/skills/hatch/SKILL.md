---
name: hatch
description: Activate the dev hermit in the current project. Appends the dev safety rules to CLAUDE.md, installs the git-push-guard hook at strict profile by default, and offers companion plugins. Run once per project after /claude-code-hermit:hatch; re-run to update individual settings.
---

# Activate Dev Hermit

Set up the language-agnostic safety layer for this project. Requires `claude-code-hermit` core to be initialized first.

The plugin's identity in v0.3.0+: a thin wrapper around (a) `git-push-guard` strict-profile hook, (b) a CLAUDE-APPEND template (safety or standard) injected into the project's CLAUDE.md, (c) dev workflow skills (`/dev-pr`, `/dev-quality`, `/dev-test`) available but only prescribed in standard mode. There is no built-in implementer agent — operators use the native `Agent` tool, `feature-dev`, or custom subagents, all governed by the injected rules.

## Plan

### 1. Check prerequisites

Check if `.claude-code-hermit/` exists in the current project.

- Missing: ask the operator (`AskUserQuestion`) "Core hermit isn't set up yet. Run `/claude-code-hermit:hatch` now?" with options `Yes — run now` / `No — I'll do it later`. If yes, invoke `/claude-code-hermit:hatch`, then continue. If no, stop.
- Present: read `.claude-code-hermit/config.json` and the plugin's `${CLAUDE_PLUGIN_ROOT}/.claude-plugin/hermit-meta.json`. Verify `_hermit_versions["claude-code-hermit"]` from config satisfies `required_core_version` from hermit-meta (e.g. `">=1.0.22"`). If absent or below the floor, ask whether to run `/claude-code-hermit:hermit-evolve` first; allow opt-out with a warning. (Reading the floor from hermit-meta — never hardcoding it in skill prose — keeps this skill in sync with the plugin's declared requirement.)

### 2. Capability scan + choose mode

Run all detection in a single parallel turn:

**Bash:**
- Existing PR template: `ls .github/PULL_REQUEST_TEMPLATE.md .gitlab/merge_request_templates/Default.md .bitbucket/pull_request_template.md docs/pull_request_template.md 2>/dev/null | head -1`.
- Installed plugins: `claude plugin list 2>/dev/null` or read `.claude/settings.json`.
- Remote forge (for `commands.pr_create`): `git remote get-url origin 2>/dev/null` — classify by substring:
  - `github.com` or `github.` → `FORGE=github`, `DEFAULT_PR_CREATE="gh pr create"`
  - `gitlab.com` or `gitlab.` → `FORGE=gitlab`, `DEFAULT_PR_CREATE="glab mr create"`
  - `bitbucket.org` → `FORGE=bitbucket`, `DEFAULT_PR_CREATE=""` (no universal CLI — operator must supply)
  - anything else or no remote → `FORGE=custom`, `DEFAULT_PR_CREATE=""`
- Capability scan: `ls .claude/skills/ 2>/dev/null` — list skill directory names. Match if any of the following dir names are present: `commit`, `create-pr`, `pr`, `pull-request`, `release`, `git-commit`. Record the matched names.
- Base-branch detection: `git branch -r --format='%(refname:short)' 2>/dev/null | sed 's|^origin/||'` — collect remote branch names. Record which of the following are present: `main`, `master`, `develop`, `development`, `dev`, `trunk`. Call this set `CANDIDATE_BASES`.

**File reads:**
- `OPERATOR.md` if present (check for `## Development Conventions` section).
- The project's main config files for stack hints — `package.json`, `Cargo.toml`, `pyproject.toml`, `Gemfile`, `pom.xml`, `go.mod`. Use these only to seed reasonable defaults for the test command prompt in standard mode; never assume them.

**Mode question:**

Ask the operator a single `AskUserQuestion`:

```
questions: [
  {
    header: "Mode",
    question: "Which hatch mode? 'safety' injects only the git-safety and branch-discipline sections (recommended when this project already has its own /commit, /create-pr, or /release skills). 'standard' injects the full dev workflow.",
    options: [
      { label: "Keep current (<value>)", description: "Already configured" },        // only on re-run when hatch_mode already in config
      { label: "safety (recommended)", description: "Detected existing skills: <matched names> — skip /dev-quality, /dev-pr, /dev-test workflow sections." },   // when capability scan matched
      { label: "safety", description: "Inject only §Git Safety, §Branch Discipline, §Technical Constraints, and supporting sections." },   // when no match but operator chooses
      { label: "standard", description: "Inject the full workflow including §Implementation Flow, §Tests Before PR, §Dev Quick Reference." }
    ]
  }
]
```

**Placeholder convention.** Strings in angle brackets (e.g. `<value>`, `<matched names>`) are templating placeholders — substitute concrete runtime values before passing to `AskUserQuestion`. Never pass the literal angle-bracket string.

When building the options array at runtime:
- If `hatch_mode` is already set in `config.json`, prepend `Keep current (<value>)` as the first (recommended) option.
- If the capability scan matched one or more skill dirs, surface `safety (recommended)` with the detected names; present `standard` as the alternative.
- If no scan match, present `standard` first (no existing project skills detected) and `safety` as the alternative.

### 3. Update CLAUDE.md dev block

Read the plugin version from `${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json`.

Based on the mode chosen in step 2:
- `safety` → read `${CLAUDE_PLUGIN_ROOT}/state-templates/CLAUDE-APPEND-SAFETY.md`
- `standard` → read `${CLAUDE_PLUGIN_ROOT}/state-templates/CLAUDE-APPEND.md`

Look for the marker comment `<!-- claude-code-dev-hermit: Development Workflow -->` in the project's `CLAUDE.md`.

- Marker absent: append the selected template to `CLAUDE.md`.
- Marker present, stamped version differs from the plugin version: silently replace the existing block with the selected template.
- Marker present, versions match AND mode is unchanged from config: skip — block is current.
- Marker present, versions match but mode changed: replace — operator switched modes.

The template is the source of truth. No operator prompt is needed for this step.

### 4. Ask about remaining settings

#### Round 1 — commands and safety (standard mode only)

In `safety` mode, skip this round entirely — do not prompt for `commands.test`, `commands.lint`, `commands.format`, or `commands.pr_create`. These keys feed workflow sections that are not injected. The dev-hermit skills (`/dev-test`, `/dev-quality`, `/dev-pr`) remain available; if invoked, they will prompt for `commands.test` on first use.

In `standard` mode, ask a single `AskUserQuestion` with up to 4 questions. ALWAYS include all four; for keys already in `config.json`, prepend `Keep current (<value>)` as the first option (and recommend it).

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

In `safety` mode, ask only the `Protected` question (single `AskUserQuestion` call with one question).

#### Round 2 — hook profile and companions

`git-push-guard` defaults to **strict**. The wizard does not ask which profile to use; it installs strict and offers an opt-out.

If `env.AGENT_HOOK_PROFILE` is already `"strict"` in config, replace the Hook question's options below with a single `Keep current (strict already active)` confirmation — never present an opt-out path that would silently downgrade an existing strict install.

Before asking Round 2, compute `FALLBACK_BASE` using the same priority order as `/dev-pr` Gate 0 step 4, but from the **just-confirmed** `protected_branches` from Round 1 (first non-glob entry → `origin/HEAD` → `main`/`master`). Then determine whether to include a `Base branch` question:

- **If `CANDIDATE_BASES` has 2+ entries:** include the question with those branches as options (plus `Other`).
- **If `CANDIDATE_BASES` has exactly 1 entry and it differs from `FALLBACK_BASE`:** silently set `AUTO_BASE` to that entry — no question needed, handled at step 5. Do not include the question in Round 2.
- **All other cases (0 entries, 1 entry matching fallback, no remote):** skip entirely — no question, no write at step 5.

On re-run: if `pr_base_branch` is already set in config, always include the question when `CANDIDATE_BASES` has 2+ entries, and prepend `Keep current (<value>)` as the first (recommended) option.

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
    header: "PR cmd",   // standard mode only (see below)
    question: "How should /dev-pr open the PR? (Invoked with --title, a body flag, and a base flag per the detected forge.)",
    options: [
      { label: "Keep current (<value>)", description: "Already configured" },          // re-run only
      { label: "gh pr create (recommended)", description: "Detected GitHub remote" },  // FORGE=github only
      { label: "glab mr create (recommended)", description: "Detected GitLab remote — uses --description and --target-branch" }, // FORGE=gitlab only
      // For FORGE=bitbucket:
      { label: "Skip — I'll configure later", description: "Bitbucket detected. No universally-available CLI exists — see docs/WORKFLOW.md for custom wrapper guidance. /dev-pr will fail until commands.pr_create is set in .claude-code-hermit/config.json." },
      // For FORGE=custom:
      { label: "Skip — I'll configure later", description: "/dev-pr will fail until commands.pr_create is set in .claude-code-hermit/config.json." },
      { label: "Other", description: "Type a custom command or wrapper script. Must print the PR URL on a line starting with https://. Gate 3 passes --title, --body-file, --base — wrap your CLI if it uses different flags." }
    ]
  },
  {
    header: "PR template",   // standard mode only (see below)
    question: "PR template path? (auto-detected: `<detected or 'none'>`)",
    options: [
      { label: "Keep current (<value>)", description: "Already configured" },                  // re-run
      { label: "<detected path>", description: "Append this template after the assembled body" },  // when detected
      { label: "Skip", description: "No project PR template" },
      { label: "Other", description: "Type a path" }
    ]
  },
  {
    header: "Base branch",   // only when CANDIDATE_BASES has 2+ entries (standard mode only)
    question: "Which branch do PRs target? (detected candidates: <CANDIDATE_BASES>)",
    options: [
      { label: "Keep current (<value>)", description: "Already configured" },   // re-run only
      { label: "<branch>", description: "..." },   // one option per CANDIDATE_BASES entry
      { label: "Other", description: "Type a branch name" }
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

In `safety` mode, skip the `PR cmd`, `PR template`, and `Base branch` questions; do not write `commands.pr_create`, `pr_template_path`, or `pr_base_branch` to config (these feed `/dev-pr` which is not prescribed in safety mode). Keep `Hook` and `Plugins`.

Filter the Plugins `options` array to only those NOT already installed (per the `claude plugin list` detection above). If the filtered list is empty, skip the Plugins question entirely.

If `OPERATOR.md` exists and does NOT contain a `## Development Conventions` section, append the answers under that heading.

### 5. Write config and stamp version

Single atomic config.json write:

- `claude-code-dev-hermit.hatch_mode` — `"safety"` or `"standard"`, from step 2.
- `claude-code-dev-hermit.protected_branches` — array. The prompt accepts a comma-separated string; split on `,`, trim each entry, drop empties before writing.
- `env.AGENT_HOOK_PROFILE`:
  - If the operator accepted strict in Round 2 → write `"strict"`.
  - Else if the existing value is already `"strict"` → preserve it (never silently downgrade).
  - Else → write `"standard"` explicitly. Do not leave the key unset; an explicit value makes the operator's choice durable across `hermit-evolve` runs and prevents silent re-prompting.
- `_hermit_versions["claude-code-dev-hermit"]` — set to the plugin version cached in step 3.

In `standard` mode only, also write:
- `claude-code-dev-hermit.commands.test` — required, from Round 1.
- `claude-code-dev-hermit.commands.lint` — optional.
- `claude-code-dev-hermit.commands.format` — optional.
- `claude-code-dev-hermit.commands.pr_create` — from the Round 2 `PR cmd` answer. If the operator chose `Skip`, leave the key absent (do not write null or empty string). Preserve any existing operator override on re-run.
- `claude-code-dev-hermit.pr_template_path` — optional, from Round 2.
- `claude-code-dev-hermit.pr_base_branch` — write only if the chosen branch (from the Round 2 `Base branch` question, or `AUTO_BASE` from the single-match case) differs from `FALLBACK_BASE`. If equal or not set, leave the key absent so `/dev-pr`'s fallback chain operates undisturbed.

For each selected companion plugin: `claude plugin install <plugin>@claude-plugins-official --scope project`.

### 6. Report results

Print a summary that reflects what actually happened:

```
Dev hermit activated (claude-code-dev-hermit vX.Y.Z).

Mode: safety  [or: standard]
  Injected: §Git Safety, §Branch Discipline, §Technical Constraints  [safety]
  Injected: §Git Safety, §Branch Discipline, §Implementation Flow, §Tests Before PR, §Technical Constraints  [standard]

Git safety:
  Hook profile: strict (git-push-guard active)  [or: standard — no hook enforcement]
  Protected branches: main, master  [or whatever was set]

Commands:  [standard mode only]
  Test:   <cmd>
  Lint:   <cmd or 'skipped'>
  Format: <cmd or 'skipped'>
  PR cmd: <commands.pr_create or 'unset — /dev-pr will fail until configured via /hatch'>

Updated:
  CLAUDE.md — dev block [appended / updated to vX.Y.Z / already current]
  OPERATOR.md — dev conventions [added / already present / skipped]
  PR template: <path or 'none'>  [standard mode only]

Companion plugins:
  [installed: code-review, feature-dev, context7  /  partial  /  none]

Available skills:
  /claude-code-dev-hermit:hatch    — re-run to update settings (idempotent)
  /claude-code-dev-hermit:dev-pr   — push the current branch and open a PR
  /claude-code-dev-hermit:dev-test — run the configured test suite and warm test cache
  /claude-code-dev-hermit:dev-quality — pre-wrap quality gate (simplify + test re-run)

Conventions are in CLAUDE.md (§Git Safety, §Branch Discipline). [safety]
Conventions are in CLAUDE.md (§Git Safety, §Branch Discipline,
§Implementation Flow, §Tests Before PR). [standard]
Any agent doing dev work in this project — native Agent, feature-dev, custom — must follow them.
```

## Docker network requirements

Read by `/claude-code-hermit:docker-security` when the operator enables LAN containment + DNS policy. **Intentionally empty** for this plugin.

### Domains (DNS allowlist)

(none — see note below)

### LAN allowlist suggestions

(none — see note below)

> **Why empty.** `claude-code-dev-hermit` is a language-agnostic safety layer. Dev workflows are inherently arbitrary — a project might pull packages from any registry (npm, PyPI, RubyGems, crates.io, Maven Central, Docker Hub, custom internal mirrors), reach any cloud provider's API, fetch from any git host, or talk to any local service. We can't pre-declare what your specific project needs without being wrong for the next operator.
>
> **What to do instead:** in `/docker-security`, choose **"Yes — recommended (LAN block + DNS log-only)"** for Prompt 1 the first time you run it. Run your usual dev workflows for a few days, then read `.claude-code-hermit/state/dns.log` for the domains your project actually contacted. Add the ones you trust to `.claude-code-hermit/docker/dnsmasq.allowlist` (one `server=/<domain>/1.1.1.1` line each), restart the netguard sidecar, and re-run `/docker-security` to flip to enforce mode. Strict DNS is hostile to arbitrary dev workflows out of the box — log-only is the right starting posture.

---

## Rules

- **Strict-by-default.** The wizard defaults to installing `git-push-guard` at strict. Do not ask "which profile?" — ask "yes or opt out?".
- **Idempotent.** Re-running detects existing `config.json` values and offers `Keep current (<value>)` as the first option per key, so operators can fast-confirm with Enter presses.
- **Single source of truth.** The selected template (`CLAUDE-APPEND.md` or `CLAUDE-APPEND-SAFETY.md`) is the source for the project's dev conventions. Step 3 always overwrites the marked block when versions differ or mode changes; do not preserve operator edits to that block (operators who want overrides put them elsewhere in their CLAUDE.md).
- **Never downgrade hook profile.** If the operator chooses "No — leave at standard" but `env.AGENT_HOOK_PROFILE` is already `strict`, preserve `strict`. The opt-out only applies on first install.
- **No stack detection magic.** Detection seeds defaults for prompts; operators always confirm. Never write `commands.test` from detection alone — it must be operator-confirmed.
- **Safety mode skips workflow prompts.** In `safety` mode, do not prompt for `commands.test`, `commands.lint`, `commands.format`, `commands.pr_create`, `pr_template_path`, or `pr_base_branch`. These keys feed workflow sections that safety mode does not inject.
- **PR cmd question options are built dynamically.** The `PR cmd` question options array is constructed at runtime: include `Keep current` only on re-run; include the forge-recommended option only when `FORGE` is `github` or `gitlab`; include the forge-specific `Skip` message for `FORGE=bitbucket` or a generic `Skip` for `FORGE=custom`; always include `Other`. Never show more than 4 options at once — omit `Keep current` on first run.
