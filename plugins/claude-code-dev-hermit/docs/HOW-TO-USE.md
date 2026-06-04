# How to Use

## Prerequisites

- [Claude Code](https://code.claude.com) v2.1.110+
- [claude-code-hermit](https://github.com/gtapps/claude-code-hermit) v1.0.26+ (installed and hatched)
- Node.js 24+ (for the `git-push-guard` hook at strict profile)
- `gh` (GitHub) or `glab` (GitLab) for `/dev-pr`; Bitbucket and other forges need `commands.pr_create` set via `/hatch`

---

## Setup

```bash
claude plugin marketplace add gtapps/claude-code-hermit
claude plugin install claude-code-dev-hermit@claude-code-hermit --scope local
/claude-code-dev-hermit:hatch
```

The wizard installs `git-push-guard` at strict profile (with an explicit opt-out) and offers companion plugins. It scans the project for existing `/commit`, `/create-pr`, or `/release` skills and chooses a mode:

- **`safety` mode** (default when existing skills are detected) — injects only §Git Safety, §Branch Discipline, and supporting sections. Does not inject §Implementation Flow, §Tests Before PR, or `/dev-pr`/`/dev-quality`/`/dev-test` references. Use this when the project already has its own dev workflow.
- **`standard` mode** (default for greenfield) — injects the full workflow and prompts for `commands.test`, lint, format, and PR template. Behavior unchanged from v0.3.1.

**Already set up?** Re-run `/claude-code-dev-hermit:hatch` any time. Every key offers `Keep current (<value>)` as the recommended option, so you can sweep through with Enter-presses to fast-confirm — or change individual values.

---

## The Dev Cycle

After `/hatch`, every code-writing agent in the project reads the rules in your CLAUDE.md (`§Git Safety`, `§Branch Discipline`, `§Implementation Flow`, `§Tests Before PR`). The cycle below is what those rules describe — there's no "dev-hermit workflow"; it's the working agreement every agent follows.

### 1. Plan

Break the task into steps via `TaskCreate`. Skip for trivial single-step work.

If `/feature-dev:feature-dev` is installed and the code path is unfamiliar (framework lifecycle hooks, ORM internals, build-tool plugins, auth middleware) — run it first. The trigger is **unfamiliarity, not urgency**.

### 2. Branch and implement

Per `§Branch Discipline` in the injected CLAUDE.md:

1. Verify clean working tree (`git status --porcelain` empty).
2. Branch from the first entry of `protected_branches` (defaults to `main`): `git checkout -b <prefix>/<slug> origin/<base>`.
3. Name the branch `<prefix>/<slug>` where `prefix ∈ {feature, fix, chore, hotfix}`.
4. Log the creation to `.claude-code-hermit/sessions/SHELL.md`.

Then write the code. The CLAUDE.md `§Git Safety` rules apply throughout: no push, no `--no-verify`, no commits to protected, no force-push. At strict hook profile, `git-push-guard` blocks the dangerous commands at `bash` time.

### 3. Test before declaring done

Per `§Implementation Flow`: run the configured test command (`claude-code-dev-hermit.commands.test`) before claiming the task is done. If tests fail, fix or report — never declare done with broken tests.

### 4. Cleanup pass, then test again

Per `§Tests Before PR`:

1. Run `/claude-code-dev-hermit:dev-quality` on the working tree. It wraps `/claude-code-hermit:simplify` (parallel reviewers, applies its own edits) and re-runs the test command.
2. If tests pass, proceed.
3. If tests fail, `git checkout -- <changed-files>` to revert the applied edits and stop. Surface the regression.

For PR review, security-sensitive changes, or large refactors, invoke `/code-review` (built-in) after the dev-quality pass — that's the deeper bug-finding option.

### 5. Open the PR

```
/claude-code-dev-hermit:dev-pr
```

Pushes the branch and opens a PR with body assembled inline from your commits, last test result, screenshots, and an optional project PR template. Refuses on protected branches, dirty trees, or zero commits ahead. There's no `--force` flag — fix the failing condition.

### 6. Reflect

At every task boundary, the hermit invokes `reflect` to surface patterns. These become proposals you can accept, defer, or dismiss.

---

## Branch Cleanup

dev-hermit no longer ships a `/dev-cleanup` skill. Use plain git:

```bash
# Delete merged feature branches (skip protected branches):
git branch --merged main | grep -vE '^\*|main|master' | xargs -r git branch -d
```

Or set up a recurring routine via `/claude-code-hermit:hermit-routines` if you want it automated.

---

## Parallel Work

- **Same change across many files** — use `/batch` (built-in)
- **Independent tasks** — use multiple `Agent` tool calls in a single message, or implement sequentially
- **After parallel work** — run `/claude-code-hermit:simplify` in the main session (subagents can't invoke skills)

---

## Companion Plugins

The setup wizard offers companion plugins from `claude-plugins-official`. See [Recommended Plugins](RECOMMENDED-PLUGINS.md) for details on each.

---

## Tips

- **First session in a new project?** Let the agent orient itself before starting work — read existing code, review tests, scan the README.
- **Talk to your hermit.** "What slowed you down?" / "Suggest improvements" — feedback feeds into the learning loop.
- **After plugin updates**, run `/claude-code-hermit:hermit-evolve` — it detects companion hermits and syncs their CLAUDE-APPEND blocks automatically.
- **Proposals have categories.** Dev-specific prefixes (`[missing-tests]`, `[tech-debt]`, `[dependency]`, `[tooling]`, `[architecture]`) keep things organized.
- **"What should I be fixing?"** Run `/claude-code-dev-hermit:domain-brainstorm`. It reads git churn, your last test result, manifest drift, and README coverage to surface at most 2 grounded improvement ideas as PROPs — no manual triage needed.
- **Channel activation**: run `/claude-code-hermit:channel-setup` for messaging between operator and hermit.
