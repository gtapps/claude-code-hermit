<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License" /></a>
  <a href="https://code.claude.com/docs/en/plugins"><img src="https://img.shields.io/badge/Claude%20Code-plugin-orange.svg" alt="Claude Code Plugin" /></a>
  <a href="CHANGELOG.md"><img src="https://img.shields.io/badge/version-0.3.3-green.svg" alt="Version 0.3.3" /></a>
  <img src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg" alt="PRs Welcome" />
</p>

# claude-code-dev-hermit

**One safety layer for every code-writing agent your hermit spawns — regardless of which agent framework you use.**

<p align="center">
  <img src="https://raw.githubusercontent.com/gtapps/claude-code-hermit/main/plugins/claude-code-hermit/assets/demo.gif" alt="claude-code-hermit demo (the core hermit — dev-hermit extends it with the safety layer described below)" width="720" />
</p>

Ships a `git-push-guard` hook (strict-by-default), a test-result recorder, a `/hatch` setup wizard, a `/dev-pr` skill, and a CLAUDE-APPEND template that injects safety rules into your project's `CLAUDE.md`. No built-in implementer — operators use the native `Agent` tool, `feature-dev`'s research/architect agents, or their own subagents. The rules apply to whichever agent runs; the `git-push-guard` hook backs them at strict profile; the test-result recorder closes the loop so `/dev-pr` only opens PRs after tests actually pass on the current commit.

**Using a project that already has its own `/commit`, `/create-pr`, or `/release` skills?** Run `/hatch` — it detects those skills and defaults to `safety` mode, which installs the git safety layer and branch discipline without prescribing dev-hermit's own workflow on top of yours.

Three steps to a hermit that won't push to main:

```
# Install
/plugin marketplace add gtapps/claude-code-hermit
/plugin install claude-code-dev-hermit@claude-code-hermit --scope project

# Setup wizard (idempotent — re-run any time to update settings)
/claude-code-dev-hermit:hatch

# Boot the hermit (core)
.claude-code-hermit/bin/hermit-start
```

> **Always-on on Docker?** Follow the core hermit's [`/claude-code-hermit:docker-setup`](https://github.com/gtapps/claude-code-hermit/blob/main/plugins/claude-code-hermit/docs/always-on.md) for 24/7 background work.

---

## What you get

**1. Git safety, two layers.** Prose rules apply at every profile via CLAUDE-APPEND.md (no push, no `--no-verify`, no commits to protected branches, no force-push). At strict profile, `git-push-guard` backs them with hard `bash`-time blocking.

**2. A working agreement for any code-writing agent.** The CLAUDE-APPEND.md template, injected into your project's CLAUDE.md, gives every agent the same rules: clean tree before starting, branch from `protected_branches[0]`, name as `<prefix>/<slug>`, run the configured test command before declaring done, re-run after `/simplify`, revert on regression. Whether you spawn the native `Agent` tool, `feature-dev:code-architect`, or your own subagent — they all read the same rules.

**3. `/dev-pr` to close the loop.** Pushes the current feature branch and opens a PR with a body assembled inline from your commits, last test result, screenshots, and an optional project PR template. Refuses on protected branches, dirty trees, or zero commits ahead. Calls `gh pr create` (GitHub), `glab mr create` (GitLab), or a custom command configured at `/hatch`. Bitbucket and other forges require a custom wrapper — `/hatch` prompts for it.

That's it. Three things, ~500 lines of plugin. Whatever you don't need from the dev-server lifecycle, the watchdog, the worktree dance, the implementer agent — gone. Operators bring their own `tmux`, `npm run dev`, `tail -f`, and however they like to spawn agents.

---

## Quick Start

> **Prerequisites:** [Claude Code](https://code.claude.com) v2.1.110+, a Claude plan (Pro, Max, Teams, or Enterprise), Node.js 24+ (for the `git-push-guard` hook at strict profile), `gh` (GitHub) or `glab` (GitLab) for `/dev-pr`; see `/hatch` for Bitbucket and other forge setup.

### 1. Install

```bash
cd /path/to/your/project
claude plugin marketplace add gtapps/claude-code-hermit
claude plugin install claude-code-dev-hermit@claude-code-hermit --scope project
```

### 2. Initialize

```
/claude-code-dev-hermit:hatch
```

The wizard asks for your test/lint/format commands, protected branches, and PR template path. Defaults to installing `git-push-guard` at strict profile (with an explicit opt-out). Re-run any time to update individual settings — the wizard offers `Keep current (<value>)` for keys already set, so you can sweep through with Enter-presses.

### 3. Boot the hermit (core)

```
.claude-code-hermit/bin/hermit-start
```

Boots the hermit in a tmux session — sessions, routines, heartbeat, and the learning loop, with detach/reattach so it survives SSH drops. Append `--no-tmux` for a foreground run.

> **Pair with the Chrome extension** for web work: run `claude --chrome` (or `/chrome` mid-session) so the hermit can drive your dev server. See [Chrome integration](https://code.claude.com/docs/en/chrome).

### Upgrading

```bash
claude plugin update claude-code-dev-hermit@claude-code-hermit --scope project
/claude-code-hermit:hermit-evolve
```

---

## Git Safety

By default Claude Code will happily push to main, run `git commit --no-verify`, and force-push your branch. dev-hermit makes that progressively harder:

| Profile | Hook enforcement |
|---------|-----------------|
| `minimal` | None — only prose rules in CLAUDE-APPEND.md |
| `standard` | None — only prose rules |
| `strict` (default after `/hatch`) | `git-push-guard` active |

The `git-push-guard` hook blocks (at strict only):

- Direct push to any branch in `claude-code-dev-hermit.protected_branches` (defaults to `main`/`master`)
- `--no-verify` on any git command
- Force push: `--force`, `-f`, or `--force-with-lease` (all blocked, on any target)
- `--mirror`, `--all`, `-a` (would push everything, including protected)

Protected branches are configurable in `.claude-code-hermit/config.json`:

```json
{ "claude-code-dev-hermit": { "protected_branches": ["main", "staging", "release/*"] } }
```

See [docs/GIT-SAFETY.md](docs/GIT-SAFETY.md) for the full safety model and the trade-offs of the regex-based guard.

---

## What's Included

- **`hatch` skill** — One-time setup wizard. Idempotent and re-runnable. Captures test/lint/format/protected/PR-template/hook-profile. Installs `git-push-guard` at strict by default.
- **`dev-pr` skill** — Push the current feature branch and open a PR with body assembled from commits + last test result + screenshots + optional project template. Runs tests automatically on cache miss — fresh HEAD pass hits instantly; anything else triggers the test runner.
- **`dev-quality` skill** — Pre-wrap quality gate. Runs `/simplify` on the diff, re-runs `commands.test`, and reports pass/fail. Suggests `/code-review` if available — never invokes it.
- **`dev-test` skill** — Run the configured test suite and record the result to `last-test.json`. Useful for mid-task verification and warming the `/dev-pr` cache.
- **`git-push-guard` hook** — Strict-profile-only `PreToolUse` Bash hook. Blocks the dangerous git operations listed above.
- **`state-templates/CLAUDE-APPEND.md`** — Injected into your project's `CLAUDE.md` by `/hatch`. The rules-of-the-road every agent reads when working on this project.

---

## Built-in Skills Used

These are Claude Code built-ins — no installation needed:

- `/simplify` — code cleanup after implementation
- `/batch` — same change across many files in parallel
- `/debug` — diagnostics when something's stuck

The CLAUDE-APPEND.md `§Implementation Flow` points to `/dev-quality` as the pre-commit quality gate — it runs `/simplify`, re-runs `commands.test`, and records the result so `/dev-pr` can hit the cache at the current HEAD.

---

## Documentation

- [Git Safety](docs/GIT-SAFETY.md)
- [How to Use](docs/HOW-TO-USE.md)
- [Recommended Plugins](docs/RECOMMENDED-PLUGINS.md)
- [Task Workflow](docs/WORKFLOW.md)

---

## Contributing

We'd love your help. Bug fixes, doc improvements, sharper rules in CLAUDE-APPEND.md — all welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for design constraints and PR workflow.

- [Open an issue](https://github.com/gtapps/claude-code-hermit/issues) — bugs, ideas, questions
- [Start a discussion](https://github.com/gtapps/claude-code-hermit/discussions) — broader topics, customization

## Credits

- **[claude-code-hermit](https://github.com/gtapps/claude-code-hermit)** — The core plugin this extends
- **[Claude Code plugins](https://github.com/anthropics/claude-code)** — The plugin platform that makes this possible
- The `git-push-guard` hook is adapted from [Everything Claude Code](https://github.com/affaan-m/everything-claude-code) (MIT)

## License

[MIT](LICENSE)
