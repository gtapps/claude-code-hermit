<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License" /></a>
  <a href="https://code.claude.com/docs/en/plugins"><img src="https://img.shields.io/badge/Claude%20Code-plugin-orange.svg" alt="Claude Code Plugin" /></a>
  <a href="CHANGELOG.md"><img src="https://img.shields.io/badge/version-0.2.2-green.svg" alt="Version 0.2.2" /></a>
  <img src="https://img.shields.io/badge/Claude-Pro%20%7C%20Max-blueviolet.svg" alt="Claude Pro/Max Compatible" />
  <img src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg" alt="PRs Welcome" />
</p>

# claude-code-dev-hermit

**The dev muscle for your hermit — git safety, quality gates, and a code-writing agent that works on branches so you don't have to worry about main.**

Your hermit already knows how to manage sessions, learn from its work, and keep things organized. This plugin adds the ability to actually *build* things — an `implementer` agent that writes code in isolated git worktrees, a quality pipeline that runs tests and `/simplify` (whose parallel review agents cover reuse/quality/efficiency), a session-scoped dev server it can boot and watch, and git-safety rules that keep main clean. Same philosophy as core: leverage what Claude Code offers, don't reinvent.

Three steps to a dev-hermit you can hand a feature to:

```
# Install
/plugin marketplace add gtapps/claude-code-hermit
/plugin install claude-code-dev-hermit@claude-code-hermit --scope project

# Setup wizard
/claude-code-dev-hermit:hatch

# Boot for active dev
.claude-code-hermit/bin/hermit-start
```

> **Want it always-on on docker?**  For 24/7 background work, follow the core hermit's [`/claude-code-hermit:docker-setup`](https://github.com/gtapps/claude-code-hermit/blob/main/docs/always-on.md) instead.

---

## How It Works

**1. Hand it a task.** It plans, then delegates to the `implementer` in an isolated git worktree. Your working tree stays clean. Main never sees it.

**2. It writes code on a feature branch.** Tests run before and after. You get back a structured summary — files changed, test results, concerns, branch name.

**3. The quality pipeline runs.** `/dev-quality` runs your tests, then `/simplify` (parallel reuse/quality/efficiency review agents), then your tests again. Reverts if simplification broke anything.

**4. It boots, watches, and verifies your dev server.** `/dev-up` starts your stack in a session-scoped Monitor; `/dev-log-watch` tails errors as conversation notifications; `/dev-down` cleans up. Pair with Claude Code's [Chrome extension](https://code.claude.com/docs/en/chrome) (`claude --chrome` or `/chrome`) and the hermit can drive your browser against the running server — submit forms with test creds, read console errors, verify visual changes — and even record the session as a GIF.

**5. Git safety is enforced at two layers.** Prompt rules apply at every profile: no push, no `--no-verify`, no commits to protected branches. At strict profile, the `git-push-guard` hook backs the rules with bash-level blocking.

**6. You stay in the merge driver's seat.** Review the implementer's summary, merge on your terms. The hermit reflects at every task boundary — recurring pain becomes a proposal you can accept.

---

## Quick Start

> **Prerequisites:** [Claude Code](https://code.claude.com) v2.1.110+, a Claude plan (Pro, Max, Teams, or Enterprise), [`claude-code-hermit`](https://github.com/gtapps/claude-code-hermit) v1.0.21+ (installed and hatched), Node.js 24+ (for the `git-push-guard` hook at strict profile). For browser verification: the [Claude in Chrome extension](https://chromewebstore.google.com/detail/claude/fcoeoabgfenejglbffodgkkbkcdhcgfn).

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

The wizard asks about your branch naming, deploy process, and hook profile. It also offers companion plugins (code-review, feature-dev, context7) and suggests dev-specific heartbeat checks. Run it once per project.

### 3. Boot for active dev

```
.claude-code-hermit/bin/hermit-start
```

Boots the hermit in a tmux session (default name `hermit-{project_name}`) — sessions, routines, heartbeat, and the learning loop, with detach/reattach so it survives SSH drops. Append `--no-tmux` for a foreground run with no multiplexer (Ctrl+C exits cleanly).

> **Pair with the Chrome extension** for web work: run `claude --chrome` (or `/chrome` mid-session) so the hermit can drive your dev server while you sit back. See [Chrome integration](https://code.claude.com/docs/en/chrome).

### Upgrading

```
claude plugin update claude-code-dev-hermit@claude-code-hermit --scope project
/claude-code-hermit:hermit-evolve
```

---

## Git Safety

By default Claude Code will happily push to main, run `git commit --no-verify`, and force-push your branch. Dev-hermit makes that progressively harder — prompt rules at every profile, plus a hook at strict that blocks the dangerous commands at bash time.

The `git-push-guard` hook blocks:

- Direct push to any protected branch (configured via `claude-code-dev-hermit.protected_branches`; defaults to `main`/`master`)
- `--no-verify` on any command
- Force push on any branch
- `--force-with-lease` to a protected branch
- `--delete` / `--mirror` / `--all` targeting protected branches
- `--force-with-lease` with no explicit refspec (ambiguous target)

Protected branches are configurable in `.claude-code-hermit/config.json`:

```json
{ "claude-code-dev-hermit": { "protected_branches": ["main", "staging", "release/*"] } }
```

| Profile | Hook enforcement |
|---------|-----------------|
| `minimal` | None |
| `standard` (default) | None |
| `strict` | `git-push-guard` active |

The `implementer` agent has its own prompt-level rules that always apply regardless of profile — no push, no `--no-verify`, no commits to protected branches.

---

## What's Included

| Skill | What it does |
|-------|-------------|
| `hatch` | One-time project setup — appends dev workflow to CLAUDE.md, configures git safety, installs companion plugins |
| `dev-adapt` | Profile the project's test commands, protected branches, dev-server setup, and stack; persists findings to config |
| `dev-branch` | Create a feature branch with gates — clean tree, base from protected_branches, no collisions |
| `dev-up` | Boot a session-scoped dev server via the Monitor tool — port checks, optional auth probe, optional HTTP health-poll |
| `dev-down` | Stop the dev server — runs `commands.dev_stop` if configured (compose/supervisord), else Monitor SIGTERM/SIGKILL |
| `dev-log-watch` | Generate a Monitor entry that tails rotating or fixed dev-server logs for error patterns |
| `dev-status` | Three-line read of branch state, dev-server monitor health, and worktree refs — read-only, no setup required |
| `dev-quality` | Post-implementation quality pass — tests, simplify, tests |
| `dev-cleanup` | Lists stale/merged branches and offers to clean them up safely |
| `dev-doctor` | Diagnose dev-hermit setup issues; safe for weekly scheduled checks |

---

## Built-in Skills Used

These are Claude Code built-ins — no installation needed:

- `/simplify` — code cleanup after implementation
- `/batch` — same change across many files in parallel
- `/debug` — diagnostics when something's stuck

---

## Documentation

| Document | Read this when... |
|----------|-------------------|
| [How to Use](docs/HOW-TO-USE.md) | You want a walkthrough of day-to-day workflow and tips |
| [Task Workflow](docs/WORKFLOW.md) | You need the end-to-end mechanics — what fires, in what order, what state it writes |
| [Skills Reference](docs/SKILLS.md) | You need exact syntax, gates, or config keys for a specific skill |
| [Git Safety](docs/GIT-SAFETY.md) | You're tuning protected branches, hook profile, or want the full safety model |
| [Dev Log Watch](docs/DEV-LOG-WATCH.md) | You're tailing rotating dev logs (Winston, Pino, Rails, structlog) into a Monitor |
| [Recommended Plugins](docs/RECOMMENDED-PLUGINS.md) | You want context on companion plugins offered during setup |

---

## Contributing

We'd love your help. Bug fixes, new skills, better docs — all welcome.

See [CONTRIBUTING.md](CONTRIBUTING.md) for design constraints, local dev setup, and PR workflow.

- [Open an issue](https://github.com/gtapps/claude-code-hermit/issues) — bugs, feature ideas, questions
- [Start a discussion](https://github.com/gtapps/claude-code-hermit/discussions) — broader topics, show & tell, hermit customization ideas

## Credits

- **[claude-code-hermit](https://github.com/gtapps/claude-code-hermit)** — The core plugin this extends
- **[Claude Code plugins](https://github.com/anthropics/claude-code)** — The plugin platform that makes this possible

## License

[MIT](LICENSE)
