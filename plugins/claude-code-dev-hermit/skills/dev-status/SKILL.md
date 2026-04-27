---
name: dev-status
description: One-shot read of branch state, dev-server monitor health, and worktree refs. Read-only — no gates, no fixes; surfaces issues with the recovery command the operator should run. Run any time you want to know "is the server up? what branch am I on? is anything stale?" without scanning three places.
---

# /dev-status

Three-line status read for the dev-hermit workflow. Read-only — this skill names commands the operator can run (`/dev-down`, `git worktree prune`) but never runs them itself.

Each section runs independently; if one fails to read, surface `(read failed: <reason>)` and continue. No FAIL gates.

## Plan

Kick off all three sections concurrently — they read independent state. Compose output in section order (1, 2, 3) once all have settled. Latency dominates here; this is an interactive skill, not a validation flow.

### 1. Branch

Run in parallel:

- `git rev-parse --abbrev-ref HEAD` → branch name. If output is `HEAD`, the tree is detached; substitute `(detached HEAD at $(git rev-parse --short HEAD))`.
- `git status --porcelain` → count `M ` (staged or unstaged modifications, including `MM`/`AM`/etc — any line starting with `M` or whose second char is `M`), `A ` (added), `D ` (deleted), `??` (untracked). Combine into one summary: `clean` if no lines, otherwise `DIRTY — <N> modified, <U> untracked` (omit zero-count categories; never list deleted/added separately — fold them into "modified" for the one-line summary).
- `git rev-list --left-right --count HEAD...@{u} 2>/dev/null` → ahead/behind counts. Skip if exit is non-zero (no upstream).

Compose:

- Clean and tracking: `<branch> (clean, in sync with <upstream>)` — only show "in sync" line when ahead and behind are both 0.
- Clean with divergence: `<branch> (clean, <N> ahead of <upstream>)` / `<N> behind <upstream>` / `<N> ahead, <M> behind <upstream>`.
- Dirty: `<branch> (DIRTY — N modified, M untracked)`. Append divergence in parens if non-zero: `<branch> (DIRTY — N modified, M untracked; X ahead of <upstream>)`.
- No upstream: `<branch> (clean)` or `<branch> (DIRTY — ...)` — omit the upstream clause entirely.

### 2. dev-up

The registry-read → pid-extract → `kill -0` → health-poll sequence mirrors `dev-up` Gate 1 (same JSON fields, same `kill -0` probe, same `health-poll.js` invocation). The difference is read-only treatment: a stale pid surfaces the STALE message and **does not** clear the registry entry. If Gate 1's liveness or health logic changes, mirror it here.

1. Read `.claude-code-hermit/state/monitors.runtime.json`. If missing or malformed: output `dev-up: (read failed: <reason>)` and stop the section. Do not proceed to any further step.
2. Find the entry where `id == "dev-server"`. If absent: `dev-up: not running`. Stop the section — do not read config, do not probe.
3. Extract `pid`. Run `kill -0 <pid> 2>/dev/null`.
   - **Non-zero exit (process not alive):** output `dev-up: registry has dev-server (pid <pid>) but process is not alive — STALE; /dev-down to clear`. Stop the section immediately — do not extract `started_at`, do not read config, do not probe health.
   - **Zero exit (process alive):** continue.
4. Extract `started_at` (ISO 8601). Format as `HH:MM` in local time. If parse fails, omit the timestamp.
5. Read `.claude-code-hermit/config.json` → `claude-code-dev-hermit.dev_health_url`. If the read fails, behave as if the field is unset.
6. **No `dev_health_url` configured:** `dev-up: running (pid <pid>, started <HH:MM>) — no health probe configured`.
7. **`dev_health_url` set:** invoke `node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/health-poll.js" "<url>" 5` (5-second timeout — `/dev-status` is interactive, but 3s false-positives on warming services like Spring/JVM/Next.js post-restart; 5s is the interactive sweet spot).
   - Exit 0 (2xx): `dev-up: running (pid <pid>, started <HH:MM>) — health <status> OK at <url>`.
   - Exit 1: parse the JSON on stdout for `{status, error, elapsedMs}`: `dev-up: running (pid <pid>, started <HH:MM>) — health probe failed at <url>: <error or "last status N">`. **Do not** mark the dev-server stale on a health failure — the process is up; only the readiness check failed.

### 3. Worktree

1. Run `git worktree list --porcelain`. If exit is non-zero, output `worktree: (read failed)` and stop.
2. Parse the porcelain output. Records are separated by blank lines. Each record has at minimum a `worktree <path>` line; secondary worktrees also have `branch refs/heads/<name>` (or `detached`); prunable worktrees have a `prunable <reason>` line.
3. Identify the main checkout (the record matching the current repo root, found via `git rev-parse --show-toplevel`). Exclude it from counts.
4. Bucket the remaining records into `active` (no `prunable`) and `prunable` (has `prunable`).
5. Compose:
   - Both buckets empty: `worktree: none`.
   - Exactly one active, no prunable: `worktree: 1 active (<path> on <branch>)`. If the worktree is detached, use `(<path> detached at <short-sha>)`.
   - Multiple active, no prunable: `worktree: <N> active`. Operator runs `git worktree list` for full detail — do not list every path.
   - Any prunable: prunable count first, prunable detail (sample one): `worktree: <P> PRUNABLE at <path> (<reason>) — git worktree prune` (single prunable). For multiple: `worktree: <P> PRUNABLE (sample: <path> — <reason>) — git worktree prune`. If active also exist, append after the prunable summary: `; <A> active`.

## Output

Always exactly three lines following the title line. Indent with two spaces; align colons at column 13 (`branch:` / `dev-up:` / `worktree:` are all 7-9 chars + colon — pad to consistent column).

```
dev-status
  branch:    feature/PROJ-123-add-auth (3 ahead of origin/main)
  dev-up:    dev-server running (pid 12345, started 14:23) — health 200 OK at http://localhost:3000/api/health
  worktree:  1 active (.claude/worktrees/implementer-456 on feature/PROJ-456)
```

Idle:

```
dev-status
  branch:    main (clean, in sync with origin/main)
  dev-up:    not running
  worktree:  none
```

Issues surface inline:

```
dev-status
  branch:    main (DIRTY — 3 modified, 1 untracked)
  dev-up:    registry has dev-server (pid 12345) but process is not alive — STALE; /dev-down to clear
  worktree:  1 PRUNABLE at .claude/worktrees/implementer-456 (branch was deleted) — git worktree prune
```

## Rules

- **Read-only.** Never call `git worktree prune`, `kill`, `/dev-down`, or anything that mutates state. Name the recovery command in the output and let the operator run it.
- **Fail-soft per section.** A broken `monitors.runtime.json` does not block the branch read. A failed `git worktree list` does not block the dev-up read.
- **No port probes.** Port-checking is `/dev-up` Gate 3's job. Running `lsof` on every status read is noise.
- **No SHELL.md parsing.** That is the operator's surface; the agent doesn't need to read it for status.
- **No `dev-log-errors` monitor reporting.** This skill is about the dev server, not the log watch — different question, different time-to-answer.
- **Three lines, always.** When in doubt, fewer details. The operator runs `git worktree list` / `/watch status` / `git status` for the full view.
- **Prose-only parsing is a deliberate exception here.** The `git status --porcelain` and `git worktree list --porcelain` parses live in this SKILL's prose rather than `scripts/lib/` helpers (per the plugin's "helpers own non-trivial parsing" convention used by `port-check.js`, `resolve-command.js`, etc.). The exception is justified because each parse is ~5 lines, has no edge cases worth a helper's overhead, and is consumed only by this read-only skill. If a second skill ever needs the same parse, extract to `scripts/lib/git-status.js` / `git-worktree.js` then.
