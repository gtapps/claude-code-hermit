---
name: session-start
description: Initializes or resumes a work session. Loads context from OPERATOR.md and SHELL.md, orients the agent, and establishes what to work on. Use at the beginning of every work session.
---
# Session Start

> **Tool note:** `claude-code-hermit:session-mgr` is a **subagent** — invoke it via the Agent tool, never the Skill tool. The `plugin:name` form it shares with skills does not imply the Skill tool.

## Operator Notification
Notify the operator per the channel policy in CLAUDE.md (§ Operator Notification).

## `--task` flag (non-interactive autonomous start)

If invoked as `session-start --task '<text>'`: use `<text>` as the task and bypass interactive prompts/questions only. When adopting `<text>` as this session's task, write it **verbatim** as the `## Task` first line — no elaboration, reordering, summarization, or truncation — so the collision guard's exact same-task comparison stays valid on a routine's re-entrant call. Operator notifications in step 8 still follow the channel policy above. Skip the NEXT-TASK.md presentation (step 6), the "What should I work on next?" / "What should I help with?" prompts (steps 9b/10), the resume prompt (step 9's "continue the current task or start a new one" ask — the collision guard already made the resume/defer decision non-interactively), the Tags prompt (step 11), the step-12 first-step confirmation, and the "After confirming the plan with the operator" plan-confirmation prose in the task-source paths. Do not ask for plan confirmation. Steps 1–3 run unchanged; the collision guard runs next. On a live-state collision (the `On collision — live` branch below) it aborts before step 4 — no session is created, renumbered, or otherwise mutated. On a recovery-state collision (the `On collision — recovery` branch below) it archives the crashed session and proceeds to step 4 as a new session.

**Collision guard (runs immediately after the step-3 `runtime.json` read, evaluated against the SHELL.md content already available from the startup injection; before step 4 routing and before any session is created, renumbered, or its `## Task` overwritten).** This is the `--task` path's non-interactive resolution of step 9's resume check, which this path otherwise bypasses along with the other interactive prompts.

- **Trigger:** `runtime.json` `session_state` is `in_progress` or `waiting`, AND SHELL.md's current `## Task` is non-placeholder, AND it collides with `<text>`. The `waiting_reason` selects the on-collision action below: `operator_input`/`conservative_pickup`/null are live states with a genuine pending task (per `channel-responder/SKILL.md`); `unclean_shutdown`/`dead_process` (and their `_no_channel` variants) are crash-recovery prompts whose `## Task` is a stale pre-crash task still awaiting the operator's archive-or-resume decision, not work actively in progress.
- **Task-text comparison:** take the first non-comment, non-empty line under `## Task` in SHELL.md, trimmed, and compare it to `<text>`, also trimmed. The placeholder `<!-- Awaiting next task -->` counts as empty (not a collision). Equal (post-trim) → **not** a collision, this is the same task continuing (e.g. a routine's own re-entrant call re-seeding the identical `<text>`; the `--task` contract above stores it verbatim, so the strings match) — proceed unchanged. Different → collision.
- **On collision — recovery `waiting_reason`** (`unclean_shutdown`/`dead_process`/`*_no_channel`): the crashed session's `## Task` is not live work, so do **not** subordinate the fresh task to it. Treat `<text>` as answering the pending recovery prompt with "archive as partial, start fresh": use `claude-code-hermit:session-mgr` to archive the crashed session as `partial`, clear `waiting_reason` and `last_error` in runtime.json, then proceed below with `<text>` as a new session (do **not** defer to NEXT-TASK.md). Append one SHELL.md `## Progress Log` line and notify per channel policy: `[HH:MM] session-start --task archived crashed session (partial), starting fresh: "<incoming task, one line>"`.
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
2. If the SessionStart hook output above includes "---Upgrade Available---": if the banner says `REQUIRED:` (always-on hermits), treat running `/claude-code-hermit:hermit-evolve unattended` as the hard first action of this session — do it before other work, then continue. Otherwise (advisory wording) just mention it to the operator and do NOT block session start.
3. **Read `state/runtime.json`** for lifecycle state **(fresh read — re-read the file(s) now; do not reuse a value cached in context from before compaction)**. This is the single source of truth — never parse SHELL.md `Status:` for decisions.
   - **Context-refresh detection (first, before all other branches):** If `context_cleared === true` in runtime.json, set a local `suppress_startup_ping` flag to `true`; otherwise set it to `false`. Then unconditionally write `context_cleared: false` back to runtime.json regardless of which recovery path follows — this consumes the marker so a later genuine boot doesn't inherit it. This must happen before the recovery sub-branches below because those branches can stop the flow early.
   - **Compaction-boundary marker cleanup:** unconditionally delete `state/compact-requested.json` if present (`rm -f`, ignore if absent). This marker is arc-scoped (written by `session`/`proposal-act` at a work-done boundary so the watchdog's routine-hygiene compactor can waive its interval cooldown once); it must never survive into a new session and influence that session's own compaction timing.
   - **Advisory lock check:** Try to acquire `state/.lifecycle.lock` non-blocking. If held by another process (hermit-start.ts, hermit-stop.ts), tell the operator "A lifecycle operation is in progress — wait for it to complete" and abort.
   - **If runtime.json is missing:** This is either a first run or a pre-runtime.json installation. If SHELL.md exists, treat as a first session and proceed normally. If neither exists, this is a fresh installation — proceed to step 5.
   - **Interrupted transition recovery (P3):** If `transition` is not null, use `claude-code-hermit:session-mgr` to resume the interrupted operation:
     - `transition == "archiving"` + target file missing → re-run archive
     - `transition == "archiving"` + target file exists → skip to SHELL.md cleanup
     - `transition == "cleaning"` → re-run SHELL.md cleanup
     - Notify the operator: "Recovered from interrupted [transition]. Session is now idle."
   - **Unclean shutdown detection:** If `last_error == "unclean_shutdown"`:
     - In always-on mode: set `session_state` to `waiting` and `waiting_reason` to `"unclean_shutdown"` in runtime.json. If `watchdog_restart_reason` is set in runtime.json, include it in the channel message: "Came back up — watchdog restarted the session (reason: [watchdog_restart_reason]). Previous task: [task from SHELL.md, or 'unknown']. Reply with (1) to archive as partial and start fresh, or (2) to resume where we left off." Otherwise use: "Came back up after unclean shutdown. Previous task: [task from SHELL.md, or 'unknown']. Reply with (1) to archive as partial and start fresh, or (2) to resume where we left off." Then stop — channel-responder handles the reply. If `heartbeat.waiting_timeout` is set, heartbeat will auto-transition to `idle` after timeout elapses with no channel activity.
     - **Push-only setup guard:** if no channel is enabled (so channel-responder cannot receive a reply) AND `push_notifications === true`, the recovery prompt cannot be answered. The Operator Notification protocol will still fire `PushNotification` with the message, but immediately set `waiting_reason` to `"unclean_shutdown_no_channel"` and rely on `heartbeat.waiting_timeout` to auto-transition the session to `idle` (heartbeat step 6 flips `session_state` to `idle` without touching SHELL.md; the recovery prompt's archive-vs-resume choice is not made automatically — operators who want explicit archive-on-timeout semantics should configure a channel). If `waiting_timeout` is unset, log a Findings entry recommending the operator add one or configure a channel for two-way replies.
     - In interactive mode: tell the operator "Previous session was not closed cleanly." Offer: (a) Archive as `partial` and start fresh, (b) Resume as-is.
     - Clear `last_error` and `watchdog_restart_reason` after the operator decides (so a later unrelated unclean shutdown does not re-announce a stale watchdog restart).
   - **Dead process detection:** If `session_state == "dead_process"`: same flow as unclean shutdown above (including the push-only setup guard). Set `waiting_reason` to `"dead_process"` (or `"dead_process_no_channel"` in the push-only case) in runtime.json. Message: "Process died unexpectedly. Previous task: [task from SHELL.md, or 'unknown']. Reply with (1) to archive as partial and start fresh, or (2) to resume where we left off."
   - **Normal state:** If `session_state` is `idle` → ready for new task. If `in_progress` or `waiting` → existing session, offer resume.
3b. **Watch registry reset.** Read `state/monitors.runtime.json` and clear all entries unconditionally — watches are session-scoped, so any previous entries are stale. If the file is missing, skip. This runs on every session start (new, resume, or crash recovery) before any watch registration occurs.
4. **Session state routing** — evaluate the fast-path gate before spawning session-mgr.

   **Fast path (skip session-mgr) — ALL five must be true:**
   - `runtime.json` was found and parsed successfully (not missing, not malformed)
   - `session_state` ∈ {`in_progress`, `idle`, `waiting`}
   - `transition` is null
   - `last_error` is null
   - `.claude-code-hermit/sessions/SHELL.md` exists

   If all five are true: SHELL.md content is already available from the startup hook injection. Proceed directly to step 4b with the data already in hand. Do **not** spawn session-mgr. Read `session_id` from runtime.json — if set and SHELL.md `**ID:**` still contains the placeholder `S-NNN`, update it to the actual session ID (e.g., `S-009`) in-context without spawning session-mgr. Similarly, if `**Started:**` still contains the placeholder `YYYY-MM-DD HH:MM`, replace it with `created_at` from runtime.json (or the current date/time if `created_at` is absent), in-context without spawning session-mgr.

   **Slow path (spawn session-mgr) — any condition above fails:**
   - `runtime.json` is missing or malformed → first run or corrupted state
   - `session_state` is `dead_process` or any unrecognized value
   - `transition` is not null → interrupted transition recovery needed
   - `last_error` is not null → error recovery needed
   - `SHELL.md` is missing → session-mgr must create it from template

   On the slow path: use `claude-code-hermit:session-mgr` to check session state, handle recovery, and create/update SHELL.md as needed.
4b. If `runtime.json` `session_state` is `idle` (session between tasks — SHELL.md exists but no active task):
   - This is a session between tasks — do NOT create a new session or SHELL.md
   - Present: session start date, tasks completed count, latest entry from Session Summary
   - Skip to step 5 (NEXT-TASK.md check) to determine the task source
   - When a task is provided: use `claude-code-hermit:session-mgr` to update runtime.json `session_state` to `in_progress`. Fill in Task. After confirming the plan with the operator, create native Tasks (`TaskCreate`) for each step.
   - The session ID is pre-computed in runtime.json (set by session-mgr on previous idle transition)
   - If heartbeat is running, it continues
5. Read `.claude-code-hermit/OPERATOR.md` for project context and constraints
5b. **Baseline audit offer (first session only).**

   Check for `.claude-code-hermit/.baseline-pending`. If absent, skip this step entirely.

   <!-- Compatible-plugin list is mirrored in hatch Phase 4 options, Phase 4b eligibility, and session-start step 5b. Update all three when adding. -->

   If present:

   1. Notify per channel policy (always-on: channel; interactive: inline). Operator message:

      > "First session on this project. Want me to run a one-time audit using the plugins you installed at hatch? It'll surface CLAUDE.md gaps and automation opportunities. (yes / no)"

      In always-on mode, only this single prompt and the final summary go through the channel. Plugin invocations run in-agent without channel chatter.

   2. Handle response:
      - **no / decline** → delete marker, log one SHELL.md Findings line ("Baseline audit declined."), continue to step 6.
      - **yes** → **delete `.claude-code-hermit/.baseline-pending` immediately** (before invoking any skill). Marker semantic = "we haven't offered yet." Once consented, the offer is consumed regardless of invocation outcome. If a skill crashes mid-run, the operator re-invokes it manually; we do not re-offer on next session. Then proceed to step 3.

   3. Pre-flight: scan `config.json` `scheduled_checks` for any entry in the fixed list below with `enabled: true`. If **none** qualify, delete the marker silently and continue to step 6.

      For each skill in the fixed list below, in order:
      - `/claude-md-management:claude-md-improver`
      - `/claude-code-setup:claude-automation-recommender`

      Do NOT invoke `/claude-md-management:revise-claude-md` — it is a session-trigger skill, not an audit, and runs separately via its own `scheduled_checks` entry.

      For each audit skill:
      - Check `config.json` `scheduled_checks` for a matching `skill` field with `enabled: true`. If absent or disabled, skip silently.
      - Emit a one-line progress signal before invoking (channel in always-on, inline otherwise): "Running {skill}…"
      - Invoke the skill.
      - If it reports unavailable/not-installed: append one SHELL.md Findings line ("Baseline audit: {skill} unavailable") and continue.
      - If it returns findings: route through `/claude-code-hermit:proposal-create` as **one proposal per plugin invocation**, passing `Evidence Source: operator-request` and with **`source: operator-request`** in the frontmatter. (Not `auto-detected` — that routes through reflection-judge expecting cross-session evidence citations the audit cannot provide.) Write the Problem section as a prioritized summary of all findings (top 3 inline, remainder as a bulleted list).

   4. Surface a single-line summary to the operator (channel in always-on, inline otherwise):

      > "Baseline audit done. {N} proposals queued: PROP-XXX[, PROP-YYY]. Review with /claude-code-hermit:proposal-list."

   **Guard:** the marker is the one-shot gate. Absent marker → this step never fires.

   **Note for maintainers:** `md-audit` and `automation-recommender` are already scheduled on 7-day intervals via `scheduled_checks`. This step pulls the first run forward to day 1 with operator consent — it is not an independent execution path.

6. Check if `.claude-code-hermit/sessions/NEXT-TASK.md` exists. If it does:
   - **Autonomous drain** (`config.always_on` is `true` AND `escalation` is `balanced` or `autonomous`): there is no operator to present to — auto-accept the prepared task. Use its `## Task` line as this session's task (as if the operator had accepted it), then delete `NEXT-TASK.md`. This is the deterministic path the `session` Work-done flow (§8) and heartbeat Idle Agency invoke with a bare `session-start`.
   - **Conservative** (`config.always_on` is `true` AND `escalation` is `conservative`): do **not** auto-start. Leave `NEXT-TASK.md` in place — the heartbeat conservative branch owns pickup (notify + set `waiting`). Continue without adopting a task from it.
   - **Interactive** (`config.always_on` is `false`): present the prepared task to the operator as the suggested task for this session.
     - If the operator accepts it: use it as the task (skip asking "What should I help with?").
     - If the operator provides a different task: delete `NEXT-TASK.md` and proceed with their task.
     - If the operator declines without giving a task: leave `NEXT-TASK.md` in place for a later session.
   - Delete `NEXT-TASK.md` **only** once its task has actually been adopted as this session's task (auto-accepted, accepted, or replaced by the operator's own task). Never delete a queued task that was not started.
7. Scan `.claude-code-hermit/proposals/` for files with `Source: auto-detected` and `Status: proposed`. If any exist, mention: "There are N unreviewed auto-detected proposal(s). Review with `/proposal-list` when ready." Do NOT block the session — this is a one-line notification only.
7b. **Interactive morning brief.** If `config.always_on` is `false` AND `config.routines` contains an enabled entry with skill containing `brief --morning`: run the morning brief inline — generate a brief emphasizing where things stand, pending proposals, and what's on deck. No dedup needed — interactive sessions are short-lived.
8. If `agent_name` is set, use it in the greeting (e.g., "Atlas reporting in." or "{name} a reportar." if language is `pt`). If `language` is set, communicate with the operator in that language for the rest of the session.
   In always-on mode: if no recovery message was sent in step 3, notify the operator via channel with a startup ping (1 line): "[name or 'Hermit'] online. Reviewing session state." Skip this ping if a recovery question was already sent — the recovery message is the boot signal. Also skip if `suppress_startup_ping` is `true` (set in step 3) — this invocation follows a watchdog context-clear, not a genuine restart.
9. If resuming an existing session (runtime.json `session_state` is `in_progress` or `waiting`):
   - Call `TaskList` to see current plan steps. Present the current task, progress (completed/remaining tasks), and blockers.
   - If the session status is `blocked`: suggest running `/debug` to diagnose tool/hook failures before re-attempting the blocked work
   - Ask the operator if they want to continue the current task or start a new one
9b. If resuming an idle session (runtime.json `session_state` is `idle`):
   - Show session continuity info: tasks completed, session duration, cumulative cost
   - Ask: "What should I work on next?" (unless a NEXT-TASK.md was accepted in step 6)
   - Once provided, use `claude-code-hermit:session-mgr` to fill Task and update runtime.json `session_state` to `in_progress`. After confirming the plan, create native Tasks for each step.
10. If starting a new session:
   - Ask the operator: "What should I help with?" (unless a NEXT-TASK.md was accepted in step 6)
   - Once provided, use `claude-code-hermit:session-mgr` to create the session with the task. After confirming the plan, create native Tasks (`TaskCreate`) for each step.
11. Once I know what to work on (new session only):
    - **Tags:** Ask "Any tags for this session? (e.g., refactor, frontend, urgent) Enter to skip." Write the answer to the `Tags:` field in SHELL.md. If skipped, leave blank.
11b. **Watch registration.** If `config.monitors` exists and has enabled entries, invoke
     `/claude-code-hermit:watch start` to register them. (Registry was already cleared in
     step 3b.) This is silent — do not prompt the operator about watch registration.
12. Identify the first actionable step and confirm with the operator before proceeding

## Context to Load

- `.claude-code-hermit/OPERATOR.md` (always)
- `.claude-code-hermit/sessions/SHELL.md` (if exists) **(fresh read — re-read the file(s) now; do not reuse a value cached in context from before compaction)**
- Most recent `.claude-code-hermit/sessions/S-*-REPORT.md` (for continuity — only the latest one)
- `.claude-code-hermit/state/runtime.json` (always — for lifecycle state)

Do NOT load all session reports — only the most recent one.