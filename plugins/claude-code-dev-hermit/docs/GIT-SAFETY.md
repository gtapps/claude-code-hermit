# Git Safety

Two layers of protection: prose rules in `state-templates/CLAUDE-APPEND.md` (always active) and the `git-push-guard` hook (strict profile only).

---

## Prose Rules (Always Active)

Injected into the project's `CLAUDE.md` by `/hatch`. The §Git Safety section reads:

- Never `git push` from agent context. Stop and ask the operator. The sanctioned answer is `/claude-code-dev-hermit:dev-pr`, which runs Gate 0 checks then pushes + opens a PR.
- Never use `--no-verify` on any git command (commit, push, merge, rebase).
- Never commit to a branch in `claude-code-dev-hermit.protected_branches`. Always work on a feature branch.
- Never force-push from agent context. No bare `--force` or `-f`. `--force-with-lease` is allowed only to a non-protected branch with an explicit refspec (the safe rebase-recovery case); ambiguous-target leases and leases to protected branches are blocked. When in doubt, surface the divergence and let the operator resolve.

These apply to whatever agent the operator uses — native `Agent` tool, `feature-dev`'s research/architect agents, custom subagents, the main session. They depend on the agent reading and following the rules; LLMs sometimes ignore prose. That's what the hook is for.

---

## git-push-guard Hook (Strict Profile)

A `PreToolUse` hook that intercepts Bash commands before they execute. Strict profile only (`AGENT_HOOK_PROFILE=strict`). At lower profiles the hook exits 0 immediately and does not inspect commands.

**Protected branches** — configured via `claude-code-dev-hermit.protected_branches` in `.claude-code-hermit/config.json`. Defaults to `["main", "master"]` if absent or unreadable. Glob patterns are supported (`release/*` matches `release/1.2`, `release/2.0-beta`, etc.).

```json
{
  "claude-code-dev-hermit": {
    "protected_branches": ["main", "staging", "release/*"]
  }
}
```

**Blocks (at strict):**

| Pattern | Why |
|---------|-----|
| `git push` to a protected branch (in any refspec form: `main`, `:main`, `+main`, `HEAD:main`, `refs/heads/main`) | Mainline protection |
| `git push --delete` / `:branch` to a protected branch | Prevents remote branch deletion |
| `git push --mirror`, `--all`, `-a` | Would push everything, including protected |
| `--no-verify` anywhere on the command line | Prevents bypassing pre-commit hooks |
| `--force`, `-f` (bare force) | History rewrite without lease protection |
| `--force-with-lease` to a protected branch | Mainline protection takes precedence over the lease |
| `--force-with-lease` without an explicit refspec (e.g. `git push --force-with-lease origin`) | Ambiguous target — blocked to avoid pushing to the wrong branch |

**Allowed:** `--force-with-lease` to a non-protected branch with an explicit refspec (e.g. `git push --force-with-lease origin feature/x`). This is the safe operation `--force-with-lease` was designed for: lease-protected overwrite of your own feature branch after a rebase. The blanket block in earlier v0.3.0 betas was harsher than the safety story warranted — see CHANGELOG `[0.3.0]` for the reasoning.

**Allows:**

- Push to non-protected feature branches
- All non-git commands
- Everything at non-strict profiles

**Trade-offs of the regex-based guard** (v0.3.0 simplified the prior 286-line tokenizer to ~80 lines of regex):

- **False positive on commit messages**: `git commit -m "fix --no-verify behavior"` is blocked. Use a different word in the message.
- **False positive on nested branch names with glob protection**: with `release/*` configured, `git push origin feature/release/x` is blocked. Rename the branch.
- **False negative on plain `git push`** (no remote, no refspec): not inspected — the guard cannot resolve tracking-branch configuration without git access. At strict, if you rely on tracking-branch pushes, also use explicit refspecs.

The trade-off rationale: false positives are 5-second annoyances; false negatives let bad pushes through.

**Implementation:** `scripts/git-push-guard.js` reads JSON from stdin, exits 0 (allow) or 2 (block). Fails open on parse errors (exit 0). No runtime dependencies. Adapted from [Everything Claude Code](https://github.com/affaan-m/everything-claude-code) (MIT).

---

## worktree-boundary-guard Hook

A `PreToolUse` hook on `Edit`/`Write` for the `claude --worktree` workflow. When the session runs inside a linked git worktree (Claude Code's default layout nests these under `<repo>/.claude/worktrees/<name>/`, sharing a path prefix with the main checkout), the agent can drift into editing the main checkout instead of the worktree. This hook hard-blocks any edit whose resolved `file_path` escapes the worktree into the main checkout.

- **Detection is the gate, not a profile.** It runs `git rev-parse` to compare the session's git dir against the common git dir; outside a linked worktree it exits 0 immediately. It ships **always-on** (no `AGENT_HOOK_PROFILE` gate) — a `claude --worktree` launch that omits the strict profile won't silently skip it.
- **Carve-out:** writes under the main checkout's `.claude-code-hermit/` are allowed — a worktree session's hermit state (SHELL.md, sessions/, state/) intentionally resolves up to that gitignored directory.
- **Escape hatch:** set `WORKTREE_GUARD=off` to disable without editing code.
- **Scope:** `Bash` command-string parsing (`cd`/`git -C` into main) is deliberately not handled — `Edit`/`Write` are the actual file-mutation path and always carry an absolute `file_path`. `NotebookEdit` is not covered (its path field differs).

**Implementation:** `scripts/worktree-boundary-guard.js`, exits 0 (allow) or 2 (block), fails open on any error. No runtime dependencies.

---

## Hook Profiles

| Profile | Hook behavior | When to use |
|---------|---------------|-------------|
| `minimal` / `standard` | Hook exits 0 immediately — only prose rules apply | Experimenting, or you trust the agent and just want the prose nudge |
| `strict` (default after `/hatch`) | `git-push-guard` blocks the patterns above | Day-to-day work; always-on / Docker deployments; anything production-adjacent |

`/hatch` defaults to installing strict and offers an explicit opt-out. Once strict, re-running `/hatch` never silently downgrades.

To change the profile manually:

```
/claude-code-hermit:hermit-settings env
→ set AGENT_HOOK_PROFILE to strict (or standard / minimal)
```

Or edit `.claude-code-hermit/config.json` directly: `"env": { "AGENT_HOOK_PROFILE": "strict" }`.

---

## Core Deny Patterns

Core hermit ships its own `enforce-deny-patterns.js` `PreToolUse` hook that provides broader protections:

- **`default` tier** (always active): catastrophic commands (`rm -rf`, credential access, OPERATOR.md bash redirects)
- **`always_on` tier** (when `always_on: true` in config): `ssh`, `docker`, `kubectl`, `npm publish`, force push, `--no-verify`, OPERATOR.md Edit/Write, settings file modification

`git-push-guard` is **complementary**, not redundant. The two hooks activate under different conditions:

| Trigger | Covers |
|---------|--------|
| Core deny patterns (`always_on` tier) | Autonomous Docker/tmux mode with `always_on: true` |
| `git-push-guard` (`strict` profile) | Interactive or autonomous mode with `AGENT_HOOK_PROFILE=strict` |

In a typical always-on Docker deployment with strict profile, both run and complement each other; core's `PreToolUse` fires first.

---

## Why Two Layers?

Prose rules are the universal floor — they work at every profile level and don't depend on hook infrastructure. The hook is a safety net for strict deployments where you want a hard `bash`-time block, not just a behavioral constraint.

The plugin's identity in v0.3.0+: a thin safety layer around (a) the strict hook, (b) the injected CLAUDE-APPEND prose. Operators who want softer enforcement run at `standard` and trust the prose; operators who want belt-and-suspenders run at `strict`.
