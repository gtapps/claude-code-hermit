# How to Use

## Prerequisites

- [Claude Code](https://code.claude.com) v2.1.80+
- [claude-code-hermit](https://github.com/gtapps/claude-code-hermit) v1.0.16+ (installed and hatched)
- Node.js 24+ (for the git-push-guard hook at strict profile)

---

## Setup

```bash
claude plugin marketplace add gtapps/claude-code-dev-hermit
claude plugin install claude-code-dev-hermit@claude-code-dev-hermit --scope project
/claude-code-dev-hermit:hatch
```

The wizard handles everything — dev workflow rules in CLAUDE.md, git safety profile, companion plugins, heartbeat items. Run it once per project.

**Already set up and updated the plugin?** Run `/claude-code-dev-hermit:hatch` again — it detects the existing block and offers to reinitialize with the latest content.

---

## The Dev Workflow

Once activated, your hermit follows this cycle for development tasks:

### 1. Plan

Break the task into steps. Each step becomes a native Task (via TaskCreate). For trivial single-step tasks, skip this — just go straight to implementation.

**Optional planning gate (non-trivial code only)** — if `/feature-dev:feature-dev` is installed and the task touches a code path you haven't read end-to-end, or uses a framework feature you can't explain from memory (framework lifecycle hooks, ORM internals, build-tool plugins, auth middleware, request-time vs boot-time resolution), run it before step 2. The trigger is **unfamiliarity, not urgency** — a hotfix touching unfamiliar wiring is exactly when slowing down pays off. Record the chosen architecture in the Task description or Progress Log so the constraint survives context churn. Skip for doc/config edits, single-line fixes, and changes you already know how to make.

### 2. Implement

The hermit delegates code changes to the `implementer` agent. This agent:

- Works in an **isolated git worktree** (your working directory stays clean)
- Creates a feature branch (`feature/short-description` or `fix/short-description`)
- Writes code, runs tests, commits atomically
- Returns a structured summary: changes, files modified, test results, concerns, branch name

The implementer works on feature branches only — see [Git Safety](GIT-SAFETY.md) for the full safety model.

**Before overriding any implementer choice**: if it produced tests, run them first. If they pass, treat the choice as potentially load-bearing and trace the framework/library behavior before replacing it with a more idiomatic-looking alternative. If no tests exist, trace before overriding.

### 3. Quality Pass

After implementation, run the quality pass:

```
/claude-code-dev-hermit:dev-quality
```

This runs three steps in sequence:
1. **Tests** — confirm everything passes
2. **`/simplify`** — auto-cleanup on changed files (also runs parallel reuse/quality/efficiency review agents)
3. **Tests again** — make sure `/simplify` didn't break anything (reverts if it did)

Use `/simplify` directly only for mid-task cleanup or after `/batch` — not as the end-of-task gate (that's what `/dev-quality` is for).

For PR review, security-sensitive changes, or large refactors, invoke `code-review:code-review` explicitly after the quality pass — it's an optional companion, not part of the default flow.

### Waiting State

If the hermit is blocked on external input — PR review, CI pipeline, operator decision — it sets session status to `waiting` with a reason. Branches tied to waiting sessions are protected from cleanup. The hermit resumes automatically when the blocker clears.

### 4. Reflect

At every task boundary, the hermit invokes `reflect` to surface patterns — recurring blockers, cost trends, improvement ideas. These become proposals you can accept, defer, or dismiss.

---

## Branch Cleanup

Feature branches accumulate over time. Clean them up:

```
/claude-code-dev-hermit:dev-cleanup
```

This lists merged and stale branches, cross-references active sessions and pending tasks, and asks what to delete. It never force-deletes without asking, never touches remote branches, and never deletes branches tied to active or queued work.

---

## Parallel Work

- **Same change across many files** — use `/batch`
- **Independent tasks** — use multiple Agent tool calls in a single message, or implement sequentially
- **After parallel work** — run `/simplify` in the main session, since subagents can't invoke skills

---

## Companion Plugins

The setup wizard offers companion plugins from `claude-plugins-official`. See [Recommended Plugins](RECOMMENDED-PLUGINS.md) for details on each one and Docker auto-install.

---

## Tips

- **First session in a new project?** The hermit explores the codebase before starting work. Let it orient itself.
- **Talk to your hermit.** Ask "what slowed you down?" or "suggest improvements" — the dev workflow feeds into the core learning loop.
- **After plugin updates**, run `/claude-code-hermit:hermit-evolve` — it detects companion hermits and syncs their CLAUDE-APPEND blocks automatically.
- **Proposals have categories.** Dev-specific prefixes (`[missing-tests]`, `[tech-debt]`, `[dependency]`, `[tooling]`, `[architecture]`) keep things organized.
- **Channel activation**: run `/claude-code-hermit:channel-setup` to set up local/tmux channel messaging between operator and hermit.
