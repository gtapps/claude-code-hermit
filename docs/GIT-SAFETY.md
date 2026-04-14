# Git Safety

Two layers of protection: prompt-level rules (always active) and the git-push-guard hook (strict profile only).

---

## Prompt-Level Rules (Always Active)

The `implementer` agent has hard rules baked into its system prompt:

- Never use `git push`
- Never use `--no-verify`
- Never commit to main/master directly
- Never modify files outside the task scope

These apply regardless of profile. The dev workflow rules in CLAUDE.md reinforce the same constraints for the main session.

---

## git-push-guard Hook (Strict Profile)

A PreToolUse hook that intercepts Bash commands before they execute.

**Blocks:**

| Command | Why |
|---------|-----|
| `git push` to main/master | Protects the mainline |
| `--no-verify` on any command | Prevents bypassing pre-commit hooks |
| `--force` or `-f` push | Prevents history rewriting |
| `--force-with-lease` to main/master | Protects mainline even with lease |

**Allows:**

- Push to feature branches
- `--force-with-lease` to feature branches (safe rebase workflow)
- All non-git commands
- Everything at non-strict profiles

**Implementation:** `scripts/git-push-guard.js` — reads JSON from stdin, pattern-matches the command, exits 0 (allow) or 2 (block). Fails open on parse errors (exit 0). No dependencies.

---

## Hook Profiles

| Profile | What runs | Best for |
|---------|-----------|----------|
| `minimal` | Hook runs but takes no action | Experimenting |
| `standard` (default) | Hook runs but takes no action | Day-to-day interactive work |
| `strict` | git-push-guard active | Always-on deployments, production-adjacent work |

**Set the profile:**

```
/claude-code-hermit:hermit-settings env
→ set AGENT_HOOK_PROFILE to strict
```

Or edit `.claude-code-hermit/config.json` directly: `"env": { "AGENT_HOOK_PROFILE": "strict" }`

The `dev-hatch` wizard offers to enable strict profile during setup.

---

## Core Deny Patterns

Core ships its own `enforce-deny-patterns.js` PreToolUse hook that provides a broader set of protections:

- **`default` tier** (always active): catastrophic commands (rm -rf, credential access, OPERATOR.md bash redirects)
- **`always_on` tier** (when `always_on: true` in config): ssh, docker, kubectl, npm publish, force push, `--no-verify`, OPERATOR.md Edit/Write, settings file modification

git-push-guard is **complementary**, not redundant. The two hooks activate under different conditions:

| Trigger | Covers |
|---------|--------|
| Core deny patterns (`always_on` tier) | Autonomous Docker/tmux mode with `always_on: true` |
| git-push-guard (`strict` profile) | Interactive or autonomous mode with `AGENT_HOOK_PROFILE=strict` |

When both are active, they stack safely — core's PreToolUse fires first. In a typical always-on Docker deployment with strict profile, both run and complement each other.

---

## Why Two Layers?

Prompt rules are the primary defense — they work at every profile level and don't depend on hook infrastructure. The hook is a safety net for strict deployments where you want a hard block, not just a behavioral constraint.

For interactive use, prompt rules are usually enough. For always-on Docker deployments where the hermit runs autonomously, strict profile adds the extra guard.
