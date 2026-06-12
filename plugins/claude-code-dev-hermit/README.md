<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License" /></a>
  <a href="https://code.claude.com/docs/en/plugins"><img src="https://img.shields.io/badge/Claude%20Code-plugin-orange.svg" alt="Claude Code Plugin" /></a>
  <a href="CHANGELOG.md"><img src="https://img.shields.io/badge/version-0.4.0-green.svg" alt="Version 0.4.0" /></a>
  <img src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg" alt="PRs Welcome" />
</p>

# claude-code-dev-hermit

Strict git-safety hook for any Claude Code agent — blocks force-push, `--no-verify`, and direct push to protected branches. Optional dev workflow skills for greenfield projects.

<p align="center">
  <img src="../claude-code-hermit/assets/cover.png" alt="Always-on Claude Code DevAgent" width="720" />
</p>

Installs a `git-push-guard` hook (strict-by-default) and injects git-safety rules into your project's `CLAUDE.md` via a CLAUDE-APPEND template — so every code-writing agent, regardless of framework, can't push to main or bypass hooks. No built-in implementer — bring your own agents. Optional workflow skills (`/dev-pr`, `/dev-quality`, `/dev-test`) are available for greenfield projects that don't already have their own commit/PR/release conventions.

```
# Install
claude plugin marketplace add gtapps/claude-code-hermit
claude plugin install claude-code-dev-hermit@claude-code-hermit --scope local

# Boot Claude Code and run the setup wizard
/claude-code-dev-hermit:hatch

# Boot the hermit (core)
.claude-code-hermit/bin/hermit-start
```

> **Already have your own `/commit`, `/create-pr`, or `/release` skills?** `/hatch` detects them and defaults to `safety` mode — the git safety layer + branch discipline without dev-hermit's workflow on top of yours.

---

## What you get

**Git safety, two layers.** Prose rules apply at every profile via CLAUDE-APPEND.md (no push, no `--no-verify`, no commits to protected branches, no force-push). At strict profile, `git-push-guard` backs them with hard `bash`-time blocking.

**Works with any agent.** The CLAUDE-APPEND.md template, injected into your project's `CLAUDE.md`, gives every code-writing agent the same rules: clean tree before starting, branch from `protected_branches[0]`, name as `<prefix>/<slug>`, run the configured test command before declaring done, re-run after the `/claude-code-hermit:simplify` cleanup pass, revert on regression. Native `Agent` tool, `feature-dev:code-architect`, your own subagent — they all read the same rules.

**Optional workflow scaffolding.** For greenfield projects without their own commit/PR/release conventions: `/dev-pr` pushes the branch and opens a PR assembled from commits + last test result + screenshots (`gh pr create` for GitHub, `glab mr create` for GitLab, or a custom command). `/dev-quality` runs `/claude-code-hermit:simplify` for a cleanup pass on the working tree and re-runs `commands.test` before you commit. `/dev-test` runs the configured suite and records the result so `/dev-pr` only opens PRs after tests pass at the current commit. If your project already has its own `/commit`, `/create-pr`, or `/release` skills, skip these — `/hatch` detects them and defaults to safety mode.

That's it. One hook + one template, with optional workflow skills on top. Whatever you don't need — gone.

---

## Quick Start

> **Prerequisites:** [Claude Code](https://code.claude.com) v2.1.150+, a Claude plan (Pro, Max, Teams, or Enterprise), Node.js 24+ (for the `git-push-guard` hook at strict profile), and `gh` (GitHub) or `glab` (GitLab) for `/dev-pr`. Bitbucket and other forges accept a custom command at `/hatch`.

### 1. Install

```bash
cd /path/to/your/project
claude plugin marketplace add gtapps/claude-code-hermit
claude plugin install claude-code-dev-hermit@claude-code-hermit --scope local
```

### 2. Initialize

```
/claude-code-dev-hermit:hatch
```

The wizard asks for your test/lint/format commands, protected branches, and PR template path. Defaults to installing `git-push-guard` at strict profile (with an explicit opt-out). Re-run any time to update individual settings — keys already set offer `Keep current (<value>)` for Enter-press sweeps.

### 3. Boot the hermit (core)

```
.claude-code-hermit/bin/hermit-start
```

Boots the hermit in a tmux session — sessions, routines, heartbeat, and the learning loop, with detach/reattach so it survives SSH drops. Append `--no-tmux` for a foreground run.

> **Always-on on Docker?** Run [`/claude-code-hermit:docker-setup`](https://github.com/gtapps/claude-code-hermit/blob/main/plugins/claude-code-hermit/docs/always-on.md) for 24/7 background work in a hardened container.

> **Pair with the Chrome extension** for web work: run `claude --chrome` (or `/chrome` mid-session) so the hermit can drive your dev server. See [Chrome integration](https://code.claude.com/docs/en/chrome).

### Upgrading

```bash
claude plugin update claude-code-dev-hermit@claude-code-hermit --scope local
/claude-code-hermit:hermit-evolve
```

---

## Git Safety

By default Claude Code will happily push to main, run `git commit --no-verify`, and force-push your branch. dev-hermit makes that progressively harder, gated by hook profile:

- **`minimal`** — no enforcement; only prose rules in CLAUDE-APPEND.md
- **`standard`** — no enforcement; only prose rules
- **`strict`** (default after `/hatch`) — `git-push-guard` active

The `git-push-guard` hook (strict only) blocks:

- Direct push to any branch in `claude-code-dev-hermit.protected_branches` (defaults to `main`/`master`)
- `--no-verify` on any git command
- Force push: `--force` and `-f` blocked unconditionally; `--force-with-lease` blocked on protected branches or without an explicit refspec (allowed on non-protected branches with an explicit refspec — see [docs/GIT-SAFETY.md](docs/GIT-SAFETY.md))
- `--mirror`, `--all`, `-a` (would push everything, including protected)

Protected branches are configurable in `.claude-code-hermit/config.json`:

```json
{ "claude-code-dev-hermit": { "protected_branches": ["main", "staging", "release/*"] } }
```

See [docs/GIT-SAFETY.md](docs/GIT-SAFETY.md) for the full safety model and the trade-offs of the regex-based guard.

---

## What's Included

- **`git-push-guard` hook** — Strict-profile-only `PreToolUse` Bash hook. Blocks the dangerous git operations listed above.
- **`state-templates/CLAUDE-APPEND.md`** — Injected into your project's `CLAUDE.md` by `/hatch`. The rules-of-the-road every agent reads when working on this project.
- **`hatch` skill** — One-time setup wizard. Idempotent and re-runnable. Captures test/lint/format/protected/PR-template/hook-profile. Installs `git-push-guard` at strict by default.

**Optional workflow skills** (for greenfield projects — skip if you already have your own `/commit`, `/create-pr`, or `/release` skills):

- **`dev-pr` skill** — Push the current feature branch and open a PR with body assembled from commits + last test result + screenshots + optional project template. Runs tests automatically on cache miss — fresh HEAD pass hits instantly; anything else triggers the test runner.
- **`dev-quality` skill** — Pre-wrap quality gate. Runs `/claude-code-hermit:simplify` (cleanup pass) on the working tree, re-runs `commands.test`, and reports pass/fail. Suggests the native `/code-review` for a deeper correctness review — never invokes it.
- **`dev-test` skill** — Run the configured test suite and record the result to `last-test.json`. Useful for mid-task verification and warming the `/dev-pr` cache.

---

## Built-in Skills Used

These are Claude Code built-ins — no installation needed:

- `/code-review` — read-only correctness review (built-in; available for explicit use, not invoked by `/dev-quality`).
- `/batch` — same change across many files in parallel
- `/debug` — diagnostics when something's stuck

The CLAUDE-APPEND.md `§Implementation Flow` points to `/dev-quality` as the pre-commit quality gate — it runs `/claude-code-hermit:simplify` (cleanup pass), re-runs `commands.test`, and records the result so `/dev-pr` can hit the cache at the current HEAD.

---

## Documentation

- [Git Safety](docs/GIT-SAFETY.md)
- [How to Use](docs/HOW-TO-USE.md)
- [Recommended Plugins](docs/RECOMMENDED-PLUGINS.md)
- [Task Workflow](docs/WORKFLOW.md)

---

## Contributing

Bug fixes, doc improvements, sharper rules in CLAUDE-APPEND.md — all welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for design constraints and PR workflow.

- [Open an issue](https://github.com/gtapps/claude-code-hermit/issues) — bugs, ideas, questions
- [Start a discussion](https://github.com/gtapps/claude-code-hermit/discussions) — broader topics, customization

## Credits

- **[claude-code-hermit](https://github.com/gtapps/claude-code-hermit)** — the core plugin this extends
- **[Claude Code plugins](https://github.com/anthropics/claude-code)** — the platform that makes this possible
- The `git-push-guard` hook is adapted from [Everything Claude Code](https://github.com/affaan-m/everything-claude-code) (MIT)

## License

[MIT](LICENSE)
