# Task Workflow

How `claude-code-dev-hermit` handles a software task end-to-end — what fires, in what order, what state it writes, and which safety layer enforces what.

This doc complements [HOW-TO-USE.md](HOW-TO-USE.md) (day-to-day usage) and [GIT-SAFETY.md](GIT-SAFETY.md) (hook details). Here the focus is *mechanics*: the exact wiring for anyone modifying the plugin or debugging why something fired.

---

## 0. Where dev-hermit sits

`claude-code-dev-hermit` does not own the session loop. It layers dev muscle inside core `claude-code-hermit`'s lifecycle — every dev task rides the core `session → work → reflect → idle-transition` state machine whose authoritative state lives in `.claude-code-hermit/state/runtime.json`.

> Lifecycle truth is `runtime.json`. `SHELL.md Status:` is cosmetic only — never read it programmatically.
> — [CLAUDE.md:37-39](../CLAUDE.md)

A dev task is therefore: *core session opens → dev plugin's 4-step workflow runs inside it → core session closes or idles*.

---

## 1. The pipeline

```
┌─ core SESSION START ─────────────────────────────────────────────────┐
│  session-mgr → runtime.json (session_state=in_progress, S-NNN)       │
│  startup-context.js injects OPERATOR.md + SHELL.md + last report     │
└──────────────────────────────────────────────────────────────────────┘
                │
                ▼
    ╔═════════════════════════ DEV WORKFLOW ═══════════════════════════╗
    ║ STEP 1  PLAN                  main session                       ║
    ║   • TaskCreate one per step                                      ║
    ║   • optional /feature-dev:feature-dev for unfamiliar wiring      ║
    ║   • record architecture in Task / Progress Log                   ║
    ║                                                                  ║
    ║ STEP 2  IMPLEMENT             Agent → implementer (Sonnet)       ║
    ║   • main session invokes `claude-code-dev-hermit:implementer`    ║
    ║   • passes protected_branches, commit_format, commands.test      ║
    ║   • runtime auto-creates git worktree + feature/fix branch       ║
    ║   • implementer: tests→edit→tests→commit (format-validated)      ║
    ║   • returns `### Changes / Files / Tests / Concerns`             ║
    ║     plus `Worktree: <abs-path>` and `Branch: <name>` as tokens   ║
    ║   • main session: git worktree prune → remove → checkout branch  ║
    ║                                                                  ║
    ║ STEP 3  QUALITY PASS          skill → /dev-quality               ║
    ║   • baseline tests (stop if pre-existing failure)                ║
    ║   • git stash create → snapshot                                  ║
    ║   • /simplify on changed files (its parallel reviewers cover     ║
    ║     reuse / quality / efficiency)                                ║
    ║   • re-run tests; if regressed → git checkout $PRESIMPLIFY -- …  ║
    ║   • risk classify (low/medium/high); high → recommend            ║
    ║     /code-review:code-review (not auto)                          ║
    ║                                                                  ║
    ║ STEP 4  REFLECT               core skill → /reflect              ║
    ║   • phase-aware three-condition gate                             ║
    ║   • reflection-judge validates evidence citations                ║
    ║   • proposal-triage dedupes, then PROP-NNN or micro-approval     ║
    ║   • dev proposal categories: [missing-tests] [tech-debt]         ║
    ║     [dependency] [tooling] [architecture]                        ║
    ╚══════════════════════════════════════════════════════════════════╝
                │
                ▼
┌─ core IDLE TRANSITION or /session-close ─────────────────────────────┐
│  session-mgr archives to sessions/S-NNN-REPORT.md                    │
│  Tasks serialized + deleted                                          │
└──────────────────────────────────────────────────────────────────────┘
```

---

## 2. Step-by-step — what actually fires

### STEP 1 — Plan

From the CLAUDE.md block installed by hatch:

> Break the task into steps (native Tasks); for non-trivial code touching unfamiliar framework wiring, optionally run `/feature-dev:feature-dev` first.
> — [state-templates/CLAUDE-APPEND.md:27](../state-templates/CLAUDE-APPEND.md)

The main session creates native Tasks. No dev-hermit skill runs yet — this is pure main-agent scaffolding. Trivial single-step tasks skip TaskCreate ([CLAUDE-APPEND.md:62](../state-templates/CLAUDE-APPEND.md)).

### STEP 2 — Implement

**Invocation:** main session calls `Agent(subagent_type="claude-code-dev-hermit:implementer")` and passes config values in the prompt. The state dir may be gitignored and unreadable from inside the worktree, so the caller materializes the needed config ([agents/implementer.md:20-27](../agents/implementer.md)).

**Frontmatter** ([agents/implementer.md:1-19](../agents/implementer.md)):

```
model: sonnet · effort: high · maxTurns: 50
isolation: worktree            ← runtime creates isolated worktree
tools: Read Write Edit Bash Glob Grep
disallowedTools: WebSearch WebFetch
```

**Contract:**
- Branch naming: `feature/<slug>` or `fix/<slug>`, hyphenated, lowercase.
- Test command precedence: prompt → `claude-code-dev-hermit.commands.test` in `config.json` → inferred (flagged in summary). [agents/implementer.md:31](../agents/implementer.md)
- Commit format: prompt → `commit_format` + `commit_format_pattern` in config → none. [agents/implementer.md:33](../agents/implementer.md)
- Returns a structured summary whose last two fields are literal one-token lines: `Worktree: <abs-path>`, `Branch: <name>`. [agents/implementer.md:74-79](../agents/implementer.md)

**Forbidden actions** ([agents/implementer.md:52-57](../agents/implementer.md), verbatim):

1. "Never use `git push` — leave that to the main session or human review"
2. "Never use `--no-verify` on git commands"
3. "Never commit directly to any branch in the protected list" (with default-protected-list disclosure rule)
4. "Never modify files outside the scope of the task"

**Worktree handoff** ([CLAUDE-APPEND.md:34](../state-templates/CLAUDE-APPEND.md)) — after implementer returns, main session runs:

```bash
git worktree prune
git worktree list --porcelain           # look up <path>
git worktree remove <path>              # never --force
git checkout <branch>
```

If removal fails on a dirty worktree, it surfaces to the operator rather than forcing.

**`.worktreeinclude`** — hatch writes this at repo root so `config.json`, `OPERATOR.md`, and `.env*` land inside the worktree ([skills/hatch/SKILL.md:183-200](../skills/hatch/SKILL.md)). Without it, an implementer running in a gitignored state dir can't read its own config.

### STEP 3 — Quality pass

Triggered as `/claude-code-dev-hermit:dev-quality` — not `/simplify` directly. CLAUDE-APPEND explicitly says ([:35](../state-templates/CLAUDE-APPEND.md)) to use dev-quality as the end-of-task gate because it wraps `/simplify` with a safety net.

Flow ([skills/dev-quality/SKILL.md:1-102](../skills/dev-quality/SKILL.md)):

1. Read `commands.test/typecheck/lint` from config; advisory-stop if no test command.
2. Determine diff: implementer's `### Files Modified` first → `git merge-base HEAD origin/HEAD` → `HEAD~1`.
3. **Baseline tests** — stop if already failing (don't mask pre-existing breakage).
4. **Snapshot:** `PRESIMPLIFY=$(git stash create) || PRESIMPLIFY=$(git rev-parse HEAD)` — no working-tree touch.
5. Invoke `/simplify` (its built-in parallel agents cover reuse/quality/efficiency — this is why the plugin doesn't ship separate review agents, per [CLAUDE.md:32](../CLAUDE.md)).
6. Re-run tests. If regressed → `git checkout $PRESIMPLIFY -- <changed files>`, log to SHELL.md; if checkout conflicts → stop and ask operator.
7. Risk-classify using the published category list (auth, migrations, deploy config, concurrency, dep major-bumps, no-test-coverage, etc.). `high` → recommend `/code-review:code-review`, not auto-run.

Output is a fixed-shape report (test / typecheck / lint / simplify / risk / review / concerns lines).

### STEP 4 — Reflect (core skill, dev inherits it)

[CLAUDE-APPEND.md:37-39](../state-templates/CLAUDE-APPEND.md) mandates a `reflect` call at every task boundary. Flow (from core `skills/reflect/SKILL.md`):

- Phase-aware (newborn / juvenile / adult) gating of the recurrence condition.
- Three-condition rule ([CLAUDE-APPEND.md:78](../state-templates/CLAUDE-APPEND.md), verbatim): *"repeated pattern across sessions, meaningful consequence if unaddressed, operator-actionable change."*
- Candidates flow through `reflection-judge` (evidence-exists check) → `proposal-triage` (dedup + tier) → either `proposal-create` (Tier 3, PROP-NNN) or `state/micro-proposals.json` (Tier 1/2).
- Dev-specific proposal prefixes ([CLAUDE-APPEND.md:69-82](../state-templates/CLAUDE-APPEND.md)): `[missing-tests] [tech-debt] [dependency] [tooling] [architecture]`.
  - Tier 2 → `[tech-debt] [tooling] [dependency]` updates
  - Tier 3 → `[missing-tests] [architecture] [dependency]` removals

---

## 3. Ambient rules (always on, no skill invocation needed)

Injected once by `/claude-code-dev-hermit:hatch` into the target project's `CLAUDE.md` under marker `<!-- claude-code-dev-hermit: Development Workflow -->` ([skills/hatch/SKILL.md:22-31](../skills/hatch/SKILL.md)). Once there, they shape every main-session turn:

| Rule | Source | Why |
|---|---|---|
| Never push to `claude-code-dev-hermit.protected_branches` (defaults `main`/`master`) | [CLAUDE-APPEND.md:11-15](../state-templates/CLAUDE-APPEND.md) | Prompt-level, always active |
| Never use `--no-verify` | same | — |
| Always feature-branch work | same | — |
| Subagents cannot invoke skills (main session only) | [CLAUDE-APPEND.md:19](../state-templates/CLAUDE-APPEND.md) | Explains why `/simplify` runs in main, not inside implementer |
| Read lifecycle truth from `state/runtime.json`, not `SHELL.md Status:` | [CLAUDE-APPEND.md:21](../state-templates/CLAUDE-APPEND.md) | Cosmetic-vs-authoritative split |
| `/dev-quality` must pass before task boundary | [CLAUDE-APPEND.md:56](../state-templates/CLAUDE-APPEND.md) | The gate |
| `/batch` for wide pattern changes; main session must do the post-`/simplify` + constraint check because parallel workers lack skill access | [CLAUDE-APPEND.md:47-52](../state-templates/CLAUDE-APPEND.md) | — |

---

## 4. Enforcement layers

Three layers, stacked:

| Layer | Scope | Activates at | Source |
|---|---|---|---|
| **Prompt-level** | `implementer` agent refuses push / `--no-verify` / protected-branch commits | always | [agents/implementer.md:52-57](../agents/implementer.md) |
| **Session-level** | CLAUDE-APPEND rules govern main agent | always (after hatch) | [state-templates/CLAUDE-APPEND.md](../state-templates/CLAUDE-APPEND.md) |
| **Hook-level** | `git-push-guard` PreToolUse on Bash, hard-blocks with exit 2 | `AGENT_HOOK_PROFILE=strict` only | [hooks/hooks.json:3-13](../hooks/hooks.json), [scripts/git-push-guard.js:220-224](../scripts/git-push-guard.js) |

### What `git-push-guard` blocks

Verbatim error lines from [scripts/git-push-guard.js](../scripts/git-push-guard.js):

| Line | Blocks |
|---|---|
| `:244` | `--no-verify` anywhere |
| `:265` | `--mirror` / `--all` |
| `:274` | `--force` (without lease) |
| `:283` | `--force-with-lease` with no explicit refspec |
| `:305` | `--force-with-lease` to protected branch |
| `:309` | `--delete` of protected branch |
| `:313` | direct push to protected branch |

Glob support (`release/*`) at `:45-52`. Fails open on parse error (`:324-328`) — never blocks on its own bug.

At `minimal` / `standard` profile the hook returns early — only the prompt-level and session-level layers apply. README and hatch recommend strict during setup but default to standard.

---

## 5. State each step writes

| Step | Writes |
|---|---|
| `/hatch` (one-time) | `CLAUDE.md` (append block), `config.json` (`claude-code-dev-hermit.*`, `env.AGENT_HOOK_PROFILE`, `_hermit_versions`, optionally `routines` / `scheduled_checks`), `.worktreeinclude`, `OPERATOR.md` §Development Conventions, `HEARTBEAT.md` dev items |
| `/dev-adapt` | `config.json` → `dev.commands.{test,typecheck,lint}`, `dev.protected_branches`, `dev.commit_format{,_pattern}`; `compiled/dev-profile-<YYYY-MM-DD>.md` |
| implementer | git worktree + feature branch + commits (no state-dir writes) |
| `/dev-quality` | console; `SHELL.md` note if simplify regression was reverted |
| `/dev-cleanup` | local branch deletions; `SHELL.md` log |
| `/dev-doctor` | console report; findings flow into reflect pipeline when run as scheduled_check |
| core reflect | `state/reflection-state.json`, `state/proposal-metrics.jsonl`, `proposals/PROP-NNN.md`, `state/micro-proposals.json`, `SHELL.md` Progress Log |
| core session-mgr | `sessions/S-NNN-REPORT.md`, `sessions/SHELL.md`, `state/runtime.json` |

---

## 6. Scheduled health (fires without a task)

Two dev-specific jobs registered in `config.json` during `/hatch` ([skills/hatch/SKILL.md:211-223](../skills/hatch/SKILL.md)):

- `routines[]` → `dev-cleanup` weekly Monday 10:00 — merged/stale branch sweep with operator approval.
- `scheduled_checks[]` → `dev-doctor` interval 7 days — 13 PASS/WARN/FAIL properties (core version, strict-profile consistency, test-command reachability, `.worktreeinclude` coverage, hook script syntax, etc.), piped into reflect as findings-only (no side effects) — [skills/dev-doctor/SKILL.md:88-116](../skills/dev-doctor/SKILL.md).

---

## Reference — key files

| Purpose | Path |
|---|---|
| Implementer contract | [agents/implementer.md](../agents/implementer.md) |
| Hatch wizard | [skills/hatch/SKILL.md](../skills/hatch/SKILL.md) |
| Quality gate | [skills/dev-quality/SKILL.md](../skills/dev-quality/SKILL.md) |
| Project profile | [skills/dev-adapt/SKILL.md](../skills/dev-adapt/SKILL.md) |
| Branch sweep | [skills/dev-cleanup/SKILL.md](../skills/dev-cleanup/SKILL.md) |
| Setup diagnostics | [skills/dev-doctor/SKILL.md](../skills/dev-doctor/SKILL.md) |
| Hook binding | [hooks/hooks.json](../hooks/hooks.json) |
| Push guard | [scripts/git-push-guard.js](../scripts/git-push-guard.js) |
| CLAUDE.md template | [state-templates/CLAUDE-APPEND.md](../state-templates/CLAUDE-APPEND.md) |
| Plugin manifest (requires core ≥ 1.0.18) | [.claude-plugin/plugin.json](../.claude-plugin/plugin.json) |
