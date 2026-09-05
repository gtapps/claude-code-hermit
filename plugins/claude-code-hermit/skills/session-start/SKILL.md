---
name: session-start
description: Initializes or resumes a work session. Loads context from OPERATOR.md and SHELL.md, orients the agent, and establishes what to work on. Use at the beginning of every work session.
---
# Session Start

## Operator Notification
Notify the operator per the channel policy in CLAUDE.md (§ Operator Notification).

## `--task` flag (non-interactive autonomous start)

If invoked as `session-start --task '<text>'`: use `<text>` as the task and bypass interactive prompts/questions only. When adopting `<text>` as this session's task, write it **verbatim** as the `## Task` first line — no elaboration, reordering, summarization, or truncation — so the collision guard's exact same-task comparison stays valid on a routine's re-entrant call. Operator notifications in step 8 still follow the channel policy above. This path is non-interactive: never ask the operator anything (no task, resume, tags, plan, or first-step prompts). The caller is a routine, not a person, so end the turn only on a completed start or the collision decline, never on a question or a plan. Steps 1–3 run unchanged; the collision guard runs next and makes the resume/defer decision in place of step 9. On a live-state collision (the `On collision — live` branch below) it aborts before step 4 — no session is created, renumbered, or otherwise mutated. On a recovery-state collision (the `On collision — recovery` branch below) it archives the crashed session and proceeds to step 4 as a new session.

**Collision guard (runs immediately after the step-3 `runtime.json` read, evaluated against the SHELL.md content already available from the startup injection; before step 4 routing and before any session is created, renumbered, or its `## Task` overwritten).** This is the `--task` path's non-interactive resolution of step 9's resume check, which this path otherwise bypasses along with the other interactive prompts.

- **Trigger:** `runtime.json` `session_state` is `in_progress` or `waiting`, AND SHELL.md's current `## Task` is non-placeholder, AND it collides with `<text>`. The `waiting_reason` selects the on-collision action below: `operator_input`/`conservative_pickup`/null are live states with a genuine pending task (per `channel-responder/SKILL.md`); `unclean_shutdown`/`dead_process` (and their `_no_channel` variants) are crash-recovery prompts whose `## Task` is a stale pre-crash task still awaiting the operator's archive-or-resume decision, not work actively in progress.
- **Task-text comparison:** take the first non-comment, non-empty line under `## Task` in SHELL.md, trimmed, and compare it to `<text>`, also trimmed. The placeholder `<!-- Awaiting next task -->` counts as empty (not a collision). Equal (post-trim) → **not** a collision, this is the same task continuing (e.g. a routine's own re-entrant call re-seeding the identical `<text>`; the `--task` contract above stores it verbatim, so the strings match) — proceed unchanged. Different → collision.
- **On collision — recovery `waiting_reason`** (`unclean_shutdown`/`dead_process`/`*_no_channel`): the crashed session's `## Task` is not live work, so do **not** subordinate the fresh task to it. Treat `<text>` as answering the pending recovery prompt with "archive as partial, start fresh": pipe `Status: partial\nBlockers: none\nClosed Via: operator\n` on stdin to `bun ${CLAUDE_PLUGIN_ROOT}/scripts/session-archive.ts archive --mode=close --state-dir=.claude-code-hermit`; if the returned `ok` is `false`, surface the `reason` and abort rather than proceeding with a fresh session on top of an unarchived crash. On `ok === true`, clear `waiting_reason` and `last_error` in runtime.json, then proceed below with `<text>` as a new session (do **not** defer to NEXT-TASK.md). Append one SHELL.md `## Progress Log` line and notify per channel policy: `[HH:MM] session-start --task archived crashed session (partial), starting fresh: "<incoming task, one line>"`.
- **On collision — live `waiting_reason` or `in_progress`** (`operator_input`/`conservative_pickup`/null, or `in_progress`):
  1. Do **not** overwrite `## Task`. Do **not** create or renumber a session.
  2. Defer `<text>` to `.claude-code-hermit/sessions/NEXT-TASK.md`, using the same markdown shape `proposal-act`'s "Create a session task" step writes (`# Next Task` / `## Task` / `## Context` / `## Suggested Plan`). If `NEXT-TASK.md` already exists (another task is already pending), do **not** overwrite it — this incoming task is dropped, not queued.
  3. Append one line to SHELL.md `## Findings` and `## Progress Log`: `[HH:MM] session-start --task deferred "<incoming task, one line>": session <session_state> with "<current task, one line>"`. If NEXT-TASK.md already existed (step 2's drop case), say "dropped (NEXT-TASK already pending)" instead of "deferred".
  4. Notify the operator per the channel policy above with the same information.
  5. Abort the start — do not proceed past this point. The caller (routine subagent or operator) receives the decline as this invocation's result.
- **No collision** (`idle`, or `## Task` is placeholder/empty, or same task) → proceed as normal below.

When starting a new session:

All state lives under `.claude-code-hermit/` in the project root.

1. Read `.claude-code-hermit/config.json` for agent identity settings (`agent_name`, `language`)
2. If the SessionStart hook output above includes "---Upgrade Available---": if the banner says `REQUIRED:` (always-on hermits), treat running `/claude-code-hermit:hermit-evolve unattended` as the hard first action of this session — do it before other work, then continue. Otherwise (advisory wording) just mention it to the operator and do NOT block session start. If instead it includes "---Stale Plugin Runtime---", this session loaded an older plugin copy than the hermit has already applied: relay that notice to the operator as-is, do NOT run `hermit-evolve` (it cannot fix a stale install), and do NOT block session start. Only "---Upgrade Available---" ever triggers evolve.
3. **Read `state/runtime.json`** for lifecycle state **(fresh read — re-read the file(s) now; do not reuse a value cached in context from before compaction)**. This is the single source of truth — never parse SHELL.md `Status:` for decisions.
   - **Context-refresh detection (first, before all other branches):** If `context_cleared === true` in runtime.json, set a local `suppress_startup_ping` flag to `true`; otherwise set it to `false`. Then unconditionally write `context_cleared: false` back to runtime.json regardless of which recovery path follows — this consumes the marker so a later genuine boot doesn't inherit it. This must happen before the recovery sub-branches below because those branches can stop the flow early.
   - **Compaction-boundary marker cleanup:** unconditionally delete `state/compact-requested.json` if present (`rm -f`, ignore if absent). This marker is arc-scoped (written by `session-archive.ts` on idle archive and by `proposal-act` at a work-done boundary so the watchdog's routine-hygiene compactor can waive its interval cooldown once); it must never survive into a new session and influence that session's own compaction timing.
   - **Advisory lock check:** Try to acquire `state/.lifecycle.lock` non-blocking. If held by another process (hermit-start.ts, hermit-stop.ts), tell the operator "A lifecycle operation is in progress — wait for it to complete" and abort.
   - **If runtime.json is missing:** This is either a first run or a pre-runtime.json installation. If SHELL.md exists, treat as a first session and proceed normally. If neither exists, this is a fresh installation — proceed to step 5.
   - **Interrupted transition recovery (P3):** If `transition` is not null, run `bun ${CLAUDE_PLUGIN_ROOT}/scripts/session-archive.ts recover --state-dir=.claude-code-hermit`. It owns the full deterministic branch table (`archiving`+target-missing → re-archive with a degraded payload; `archiving`+target-exists → skip straight to SHELL.md cleanup; `cleaning` → re-run SHELL.md cleanup; picks idle-vs-close cleanup semantics via the `transition_mode` field it reads, falling back to a full close for markers left by a pre-upgrade crash). Parse the returned JSON: if `ok === true`, notify the operator: "Recovered from interrupted transition. Session is now idle." If `ok === false`, treat this as the unclean-shutdown case below instead — the interrupted state could not be resolved mechanically.
   - **Unclean shutdown detection:** If `last_error == "unclean_shutdown"` (on a resumed conversation, background tasks from the previous session arrive as "stopped" task notifications and are not rerun; watches reset in step 3b and routines re-arm through the existing routine load):
     - In always-on mode: set `session_state` to `waiting` and `waiting_reason` to `"unclean_shutdown"` in runtime.json. If `watchdog_restart_reason` is set in runtime.json, include it in the channel message: "Came back up — watchdog restarted the session (reason: [watchdog_restart_reason]). Previous task: [task from SHELL.md, or 'unknown']. Reply with (1) to archive as partial and start fresh, or (2) to resume where we left off." Otherwise use: "Came back up after unclean shutdown. Previous task: [task from SHELL.md, or 'unknown']. Reply with (1) to archive as partial and start fresh, or (2) to resume where we left off." Then stop — channel-responder handles the reply. If `heartbeat.waiting_timeout` is set, heartbeat will auto-transition to `idle` after timeout elapses with no channel activity.
     - **Push-only setup guard:** if no channel is enabled (so channel-responder cannot receive a reply) AND `push_notifications === true`, the recovery prompt cannot be answered. The Operator Notification protocol will still fire `PushNotification` with the message, but immediately set `waiting_reason` to `"unclean_shutdown_no_channel"` and rely on `heartbeat.waiting_timeout` to auto-transition the session to `idle` (heartbeat step 6 flips `session_state` to `idle` without touching SHELL.md; the recovery prompt's archive-vs-resume choice is not made automatically — operators who want explicit archive-on-timeout semantics should configure a channel). If `waiting_timeout` is unset, log a Findings entry recommending the operator add one or configure a channel for two-way replies.
     - In interactive mode: tell the operator "Previous session was not closed cleanly." Offer: (a) Archive as `partial` and start fresh, (b) Resume as-is.
     - Clear `last_error` and `watchdog_restart_reason` after the operator decides (so a later unrelated unclean shutdown does not re-announce a stale watchdog restart).
   - **Orphaned-process detection:** If `last_error == "orphaned_process"`: the previous stop (or a watchdog restart) could not verify the old claude process tree died, so a stale `claude --channels` process may still be running. Surface this to the operator: "Previous stop couldn't confirm the old session's process exited — a claude process may still be running. Check `pgrep -af \"claude --channels\"` and terminate any survivor before assuming a clean slate." In always-on mode, notify per channel policy; in interactive mode, tell the operator inline. Clear `last_error` after the operator has been alerted so the warning does not re-fire on the next start.
   - **Dead process detection:** If `session_state == "dead_process"`: same flow as unclean shutdown above (including the push-only setup guard). Set `waiting_reason` to `"dead_process"` (or `"dead_process_no_channel"` in the push-only case) in runtime.json. Message: "Process died unexpectedly. Previous task: [task from SHELL.md, or 'unknown']. Reply with (1) to archive as partial and start fresh, or (2) to resume where we left off." When the conversation was resumed, background tasks from the previous session arrive as "stopped" task notifications and are not rerun; watches reset in step 3b and routines re-arm through the existing routine load.
   - **Normal state:** If `session_state` is `idle` → ready for new task. If `in_progress` or `waiting` → existing session, offer resume.
3b. **Watch registry reset.** Read `state/monitors.runtime.json` and clear all entries unconditionally — watches are session-scoped, so any previous entries are stale. If the file is missing, skip. This runs on every session start (new, resume, or crash recovery) before any watch registration occurs.
4. **Session state routing** — evaluate the fast-path gate before running `session-archive.ts`.

   **Fast path (skip session-archive.ts) — ALL five must be true:**
   - `runtime.json` was found and parsed successfully (not missing, not malformed)
   - `session_state` ∈ {`in_progress`, `idle`, `waiting`}
   - `transition` is null
   - `last_error` is null
   - `.claude-code-hermit/sessions/SHELL.md` exists

   If all five are true: SHELL.md content is already available from the startup hook injection. Proceed directly to step 4b with the data already in hand. Do **not** run `session-archive.ts` here. Read `session_id` from runtime.json — if set and SHELL.md `**ID:**` still contains the placeholder `S-NNN`, update it to the actual session ID (e.g., `S-009`) in-context, no script call needed. Similarly, if `**Started:**` still contains the placeholder `YYYY-MM-DD HH:MM`, replace it with `created_at` from runtime.json (or the current date/time if `created_at` is absent), in-context, no script call needed.

   **Slow path (run `session-archive.ts open`) — any condition above fails:**
   - `runtime.json` is missing or malformed → first run or corrupted state
   - `session_state` is `dead_process` or any unrecognized value
   - `transition` is not null → already handled by the P3 recovery check in step 3 above; if it's still non-null here, `recover` didn't fully resolve it — re-run `recover` once more before falling through to `open`
   - `last_error` is not null → error recovery needed
   - `SHELL.md` is missing → `open` must create it from template

   On the slow path: run `bun ${CLAUDE_PLUGIN_ROOT}/scripts/session-archive.ts open --state-dir=.claude-code-hermit` (empty `Task:` payload if no task is known yet) to create/update SHELL.md and pre-compute the session ID. Gate on the returned `ok`; if `false`, surface the `reason` to the operator before proceeding.
4b. If `runtime.json` `session_state` is `idle` (session between tasks — SHELL.md exists but no active task):
   - This is a session between tasks — do NOT create a new session or SHELL.md
   - Present: session start date, tasks completed count, latest entry from Session Summary (strip its trailing `($X.XX)` spend figure — spend is on request via `/cost-reflect`)
   - Skip to step 6 (NEXT-TASK.md check) to determine the task source
   - When a task is provided: pipe `Task: <text>` on stdin to `bun ${CLAUDE_PLUGIN_ROOT}/scripts/session-archive.ts open --state-dir=.claude-code-hermit` to update runtime.json `session_state` to `in_progress` and fill in Task. Record its ordered steps in the SHELL.md Progress Log.
   - The session ID is pre-computed in runtime.json (set by the previous idle transition's `archive --mode=idle`)
   - If heartbeat is running, it continues
5. Read `.claude-code-hermit/OPERATOR.md` for project context and constraints
6. Check if `.claude-code-hermit/sessions/NEXT-TASK.md` exists. If it does:
   - **Autonomous drain** (`config.always_on` is `true` AND `escalation` is `balanced` or `autonomous`): there is no operator to present to — auto-accept the prepared task. Use its `## Task` line as this session's task (as if the operator had accepted it) and adopt its `## Suggested Plan` in order as this session's plan. Step 1 gates the rest, so it runs before any edit. Then delete `NEXT-TASK.md`. This is the deterministic path the `session` Work-done flow (§6 step 7) and the heartbeat's queued-task pickup invoke with a bare `session-start`.
   - **Conservative** (`config.always_on` is `true` AND `escalation` is `conservative`): do **not** auto-start. Leave `NEXT-TASK.md` in place — the heartbeat conservative branch owns pickup (notify + set `waiting`). Continue without adopting a task from it.
   - **Interactive** (`config.always_on` is `false`): present the prepared task to the operator as the suggested task for this session.
     - If the operator accepts it: use it as the task (skip asking "What should I help with?").
     - If the operator provides a different task: delete `NEXT-TASK.md` and proceed with their task.
     - If the operator declines without giving a task: leave `NEXT-TASK.md` in place for a later session.
   - Delete `NEXT-TASK.md` **only** once its task has actually been adopted as this session's task (auto-accepted, accepted, or replaced by the operator's own task). Never delete a queued task that was not started.
7. Scan `.claude-code-hermit/proposals/` for files with `Source: auto-detected` and `Status: proposed`. If any exist, mention: "There are N unreviewed auto-detected proposal(s). Review with `/proposal-list` when ready." Do NOT block the session — this is a one-line notification only.
7b. **Interactive morning brief.** If `config.always_on` is `false` AND `config.routines` contains an enabled entry with skill containing `brief --morning`: run the morning brief inline — generate a brief emphasizing where things stand, pending proposals, and what's on deck. No dedup needed — interactive sessions are short-lived.
8. If `agent_name` is set, use it in the greeting (e.g., "Atlas reporting in." or "{name} a reportar." if language is `pt`).
   In always-on mode: if no recovery message was sent in step 3, notify the operator via channel with a startup ping (1 line): "[name or 'Hermit'] online. Reviewing session state." Skip this ping if a recovery question was already sent — the recovery message is the boot signal. Also skip if `suppress_startup_ping` is `true` (set in step 3) — this invocation follows a watchdog context-clear, not a genuine restart.
In always-on mode (`config.always_on` is `true`) with no task known (no `--task`, no NEXT-TASK.md adopted in step 6, none in the invoking request), never ask: leave `session_state` as it is and report readiness; the next task arrives from the channel, a routine, or a queued NEXT-TASK.md.

9. If resuming an existing session (runtime.json `session_state` is `in_progress` or `waiting`):
   - Read the SHELL.md Progress Log for the plan and how far it got. Present the current task, the most recent Progress Log entries, and blockers.
   - If the session status is `blocked`: suggest running `/debug` to diagnose tool/hook failures before re-attempting the blocked work
   - If the invoking request already selects the task, continue within that authorization. Otherwise ask whether to continue or start a new task. Recovery choices in step 3 still apply.
9b. If resuming an idle session (runtime.json `session_state` is `idle`):
   - Show session continuity info: tasks completed, session duration
   - Ask: "What should I work on next?" (unless a task is already known, or the always-on rule above applied)
   - Once provided, pipe `Task: <text>` on stdin to `bun ${CLAUDE_PLUGIN_ROOT}/scripts/session-archive.ts open --state-dir=.claude-code-hermit` to fill Task and update runtime.json `session_state` to `in_progress`. Record its ordered steps in the SHELL.md Progress Log.
10. If starting a new session:
   - Ask the operator: "What should I help with?" (unless a task is already known, or the always-on rule above applied)
   - Once provided, pipe `Task: <text>` on stdin to `bun ${CLAUDE_PLUGIN_ROOT}/scripts/session-archive.ts open --state-dir=.claude-code-hermit` to create the session with the task. Record its ordered steps in the SHELL.md Progress Log.
11. Once I know what to work on (new session only):
    - **Tags:** Use operator-provided tags or infer them from the task using the existing vocabulary. Write them to `Tags:` in SHELL.md; tags never block startup.
11b. **Watch registration.** If `config.monitors` exists and has enabled entries, invoke
     `/claude-code-hermit:watch start` to register them. (Registry was already cleared in
     step 3b.) This is silent — do not prompt the operator about watch registration.
12. State the first actionable step and proceed within the task's existing authorization. Ask only when missing information, a material scope change, or an explicit approval gate requires an operator decision.

## Context to Load

- `.claude-code-hermit/OPERATOR.md` (always)
- `.claude-code-hermit/sessions/SHELL.md` (if exists) **(re-read before writing to it or before reusing a value cached in context from before compaction; after a compact-source start the injected capsule's task/progress lines suffice for orientation — don't re-read just to reconstruct context)**
- Most recent `.claude-code-hermit/sessions/S-*-REPORT.md` only when the selected task needs continuity missing from the startup context; read the relevant sections. Skip after a compact-source start, where the capsule carries its path.
- `.claude-code-hermit/state/runtime.json` (always — for lifecycle state)

Do NOT load all session reports — only the most recent one.
