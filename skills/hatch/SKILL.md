---
name: hatch
description: Activates the dev hermit in the current project. Appends dev workflow to CLAUDE.md, configures git safety, suggests dev heartbeat items, and installs companion plugins. Run once per project after /claude-code-hermit:hatch.
---
# Activate Dev Hermit

Set up development workflow for this project. Requires claude-code-hermit core to be initialized first.

## Plan

### 1. Check prerequisites

Check if `.claude-code-hermit/` exists in the current project.
- If it does NOT exist: ask the operator "Core hermit isn't set up yet. Run `/claude-code-hermit:hatch` now?" using AskUserQuestion with options "Yes — run hatch now" / "No — I'll do it later". If yes: invoke `/claude-code-hermit:hatch`, then continue to step 2 when it completes. If no: stop.
- If it exists: read `.claude-code-hermit/config.json` and check that `_hermit_versions["claude-code-hermit"]` is present. If missing: ask "Core version not tracked — run `/claude-code-hermit:hatch` now to initialize?" using AskUserQuestion with options "Yes — run hatch now" / "Skip — proceed anyway". If yes: invoke `/claude-code-hermit:hatch`, then continue. If skip: proceed with a warning.
- If version is present but less than `1.0.15`: ask "Core v1.0.15+ required (found vX.Y.Z). Run `/claude-code-hermit:hermit-evolve` now?" using AskUserQuestion with options "Yes — upgrade now" / "Skip — proceed anyway". If yes: invoke `/claude-code-hermit:hermit-evolve`, then continue. If skip: proceed with a warning.
- If version is `1.0.15` or later: check that `.claude-code-hermit/state/runtime.json` exists. If missing, warn: "runtime.json not found — state may be incomplete. Re-run `/claude-code-hermit:hatch` or `/claude-code-hermit:hermit-evolve` to repair." Allow proceeding. Otherwise proceed.
- Check `.claude/settings.local.json` for `CLAUDE_CODE_TASK_LIST_ID`. If missing, warn: "Task tracking requires core init. Run `/claude-code-hermit:hatch` to set it up."

### 2. Update CLAUDE.md dev block

Check if `CLAUDE.md` contains `<!-- claude-code-dev-hermit: Development Workflow -->`.

- If marker found:
  - Use the plugin version cached in Phase 1.
  - Read `_hermit_versions["claude-code-dev-hermit"]` from config.json.
  - If versions differ (or stamped version missing): silently replace the existing block with the cached CLAUDE-APPEND.md template. Log "CLAUDE.md dev block updated to vX.Y.Z" for the report.
  - If versions match: skip. Log "CLAUDE.md dev block already current" for the report.
- If marker NOT found: append the cached CLAUDE-APPEND.md template to CLAUDE.md.

No operator prompt needed — reinitializing is always safe (the template is the source of truth).

### 3. Setup wizard

Collect dev preferences through a focused wizard using `AskUserQuestion`. Two prompt rounds maximum.

#### Phase 1 — Auto-detect (silent, parallel)

Run these in a single parallel turn before asking anything:

**Bash commands:**
- Branch naming: `git log --oneline --all -20 | grep -oE '(feature|fix|hotfix|chore|release)/[^ ]+' | head -5`
- Protected branches: `git branch -r 2>/dev/null | grep -E 'main|master|staging|production' | head -5`
- CI config: `ls .github/workflows/ 2>/dev/null; ls .gitlab-ci.yml 2>/dev/null; ls Jenkinsfile 2>/dev/null`
- Test commands: `grep -E '"test"' package.json 2>/dev/null; ls pytest.ini setup.cfg pyproject.toml 2>/dev/null | head -3`

**File reads (parallel with Bash):**
- `${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json` — cache the plugin version for use in Steps 2 and 4
- `${CLAUDE_PLUGIN_ROOT}/state-templates/CLAUDE-APPEND.md` — cache for possible use in Step 2
- `env.AGENT_HOOK_PROFILE` from config.json (already loaded in step 1)
- Installed plugins: `claude plugin list` or check `.claude/settings.json`
- `.claude-code-hermit/HEARTBEAT.md` — read contents if it exists; check for "dev.test-suite" or "dev.uncommitted" markers
- `OPERATOR.md` — read contents if it exists; check for `## Development Conventions` section

Collect all findings silently. Use them to determine which questions to ask and which to skip.

#### Phase 2 — Git safety and conventions (Round 1)

Build a single AskUserQuestion call with up to 4 questions. **Only include questions whose answers could NOT be auto-detected.** For auto-detected values, confirm inline: "Detected: feature/* branch naming from git history."

Skip the hook profile question entirely if already set to `strict` — just confirm: "git-push-guard is already active (strict profile)."

Available question slots (include only those needed, max 4):

```
questions: [
  {
    header: "Hook profile",
    question: "Enable git-push-guard? Blocks direct pushes to main, --no-verify, and force push.",
    options: [
      { label: "Strict (recommended)", description: "git-push-guard active — blocks dangerous git operations" },
      { label: "Standard", description: "No hook enforcement — prompt-level rules still apply" }
    ]
  },
  {
    header: "Branch naming",
    question: "Branch naming convention? [auto-detected: {pattern or 'none detected'}]",
    options: [
      { label: "feature/*, fix/*", description: "Standard prefixed branches" },
      { label: "Custom", description: "Describe your convention" }
    ]
  },
  {
    header: "Deploy",
    question: "Deploy process? [skip if unknown]",
    options: [
      { label: "CI auto-deploy", description: "Push triggers deployment pipeline" },
      { label: "Manual", description: "Manual deploy after merge" },
      { label: "Staging first", description: "Deploy to staging, then promote to production" }
    ]
  },
  {
    header: "Code review",
    question: "Code review expectations?",
    options: [
      { label: "PRs required", description: "All changes go through pull request review" },
      { label: "Self-review ok", description: "Solo project or trusted team — self-review is fine" }
    ]
  }
]
```

Record profile choice. If `strict`: queue `env.AGENT_HOOK_PROFILE` update for the config.json write in Step 4.

If OPERATOR.md exists (already read in Phase 1) and does NOT contain `## Development Conventions`, append answers under that heading. If the section already exists, skip writing.

#### Phase 3 — Plugins and heartbeat (Round 2)

Build a single AskUserQuestion call with up to 2 questions. Skip questions that don't apply.

**Companion plugins** — skip entirely if all three are already installed. Use multiSelect so operators can pick exactly what they want in one step:

```
{
  header: "Plugins",
  question: "Install companion dev plugins?",
  multiSelect: true,
  options: [
    { label: "code-review", description: "Official Anthropic code review for PRs and changed files" },
    { label: "feature-dev", description: "Guided feature development with codebase understanding" },
    { label: "context7", description: "Live documentation lookup for framework APIs" }
  ]
}
```

Only show plugins NOT already installed. If only one plugin is missing, still use this format (the operator can leave all unselected to skip).

**Heartbeat items** — skip if HEARTBEAT.md doesn't exist or dev items are already present:

```
{
  header: "Heartbeat",
  question: "Add dev heartbeat checks? (test suite, uncommitted changes, stale branches, dependency audits)",
  options: [
    { label: "Yes (recommended)", description: "Add 4 dev-specific checks to HEARTBEAT.md" },
    { label: "Skip", description: "Don't add dev heartbeat items" }
  ]
}
```

If HEARTBEAT.md doesn't exist: skip the question, note in the report: "Heartbeat not configured — run `/claude-code-hermit:heartbeat edit` to set it up."

**Dev cleanup routine:**

```
{
  header: "Cleanup routine",
  question: "Add a weekly branch cleanup routine?",
  options: [
    { label: "Yes (Mondays 10am)", description: "Runs /dev-cleanup weekly as a scheduled routine — suggests branch deletions interactively" },
    { label: "Skip", description: "Run /dev-cleanup manually when needed" }
  ]
}
```

#### After the wizard

**Install plugins** — for each selected plugin:
1. Run `claude plugin install <plugin>@claude-plugins-official --scope project`
2. Queue additions to `docker.recommended_plugins` and `scheduled_checks` for the config.json write in Step 4:
   - code-review: `{ "id": "dev-code-review", "skill": "code-review", "trigger": "interval", "interval_days": 7, "enabled": true }`
   - feature-dev: `{ "id": "dev-feature-dev", "skill": "feature-dev", "trigger": "interval", "interval_days": 7, "enabled": true }`
   - context7: skip scheduled_checks (MCP server — no meaningful periodic check), still add to `docker.recommended_plugins`
   - Skip entries that already exist in `scheduled_checks`.

**Add heartbeat items** — if accepted, append to HEARTBEAT.md:
```
# Dev Checks (added by claude-code-dev-hermit)
- Check if the test suite is passing on the current branch  <!-- key: dev.test-suite -->
- Check for uncommitted changes on active feature branches  <!-- key: dev.uncommitted -->
- Check for stale feature branches (>7 days without commits)  <!-- key: dev.stale-branches -->
- Quick scan: any dependency security advisories? (npm audit / pip audit)  <!-- key: dev.dep-audit, cadence: daily -->
```

### 4. Write config and stamp version

Flush all pending config.json changes in a single write:
- `env.AGENT_HOOK_PROFILE` (if changed in Round 1)
- `docker.recommended_plugins` (if plugins were selected)
- `scheduled_checks` entries (if plugins were selected; create the array if absent)
- `_hermit_versions["claude-code-dev-hermit"]` set to the plugin version cached in Phase 1
- `routines` array (if dev-cleanup routine was accepted): append `{"id": "dev-cleanup", "schedule": "0 10 * * 1", "skill": "claude-code-dev-hermit:dev-cleanup", "enabled": true}` — create the array if absent; skip if an entry with `"id": "dev-cleanup"` already exists

After the config write: invoke `/claude-code-hermit:hermit-routines load` to register all enabled routines.

### 5. Report results

Print a summary (adapt lines to reflect what actually happened):

```
Dev hermit activated!

Git safety:
  Hook profile: [strict (git-push-guard active) / standard (no enforcement)]
  Branch naming: [feature/* / detected from history / not configured]

Updated:
  CLAUDE.md — dev workflow block [appended / updated to vX.Y.Z / already current]
  OPERATOR.md — dev conventions [added / already present / skipped]
  Dev heartbeat items: [added / skipped / heartbeat not configured]
  config.json — dev hermit version stamped
  scheduled_checks — [code-review / feature-dev entries added / skipped]

Companion plugins:
  [code-review + feature-dev + context7 / partial / skipped]

Available skills:
  /claude-code-dev-hermit:dev-quality   — post-implementation quality pass
  /claude-code-dev-hermit:dev-cleanup   — branch cleanup

Available agent:
  claude-code-dev-hermit:implementer   — code writing in worktree (Sonnet)

Other core skills (optional):
  /claude-code-hermit:hermit-routines   — manage scheduled routines
  /claude-code-hermit:hermit-settings boot-skill   — view/change/clear the configured boot skill
  /claude-code-hermit:channel-setup     — local/tmux channel messaging between operator and hermit
  /claude-code-hermit:obsidian-setup    — Hermit Cortex (Obsidian surface over hermit state)
  /claude-code-hermit:weekly-review     — weekly review reports (enable via /hermit-settings)
  /claude-code-hermit:watch             — background monitoring via CC Monitor (zero token cost when quiet)
  /claude-code-hermit:migrate           — migration audit for moving the hermit to another machine
  Knowledge Convention                  — raw/ and compiled/ for durable domain knowledge (run /hermit-evolve to set up)
```
