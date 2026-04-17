---
name: session-start
description: Initializes or resumes a work session. Loads context from OPERATOR.md and SHELL.md, orients the agent, and establishes what to work on. Use at the beginning of every work session.
---
# Session Start

## Operator Notification
Notify the operator per the channel policy in CLAUDE.md (§ Operator Notification).

When starting a new session:

All state lives under `.claude-code-hermit/` in the project root.

1. Read `.claude-code-hermit/config.json` for agent identity settings (`agent_name`, `language`)
2. If the SessionStart hook output above includes "---Upgrade Available---", mention it to the operator. Do NOT block session start.
3. **Read `state/runtime.json`** for lifecycle state. This is the single source of truth — never parse SHELL.md `Status:` for decisions.
   - **Advisory lock check:** Try to acquire `state/.lifecycle.lock` non-blocking. If held by another process (hermit-start.py, hermit-stop.py, routine-watcher), tell the operator "A lifecycle operation is in progress — wait for it to complete" and abort.
   - **If runtime.json is missing:** This is either a first run or a pre-runtime.json installation. If SHELL.md exists, treat as a first session and proceed normally. If neither exists, this is a fresh installation — proceed to step 5.
   - **Interrupted transition recovery (P3):** If `transition` is not null, use `claude-code-hermit:session-mgr` to resume the interrupted operation:
     - `transition == "archiving"` + target file missing → re-run archive
     - `transition == "archiving"` + target file exists → skip to SHELL.md cleanup
     - `transition == "cleaning"` → re-run SHELL.md cleanup
     - Notify the operator: "Recovered from interrupted [transition]. Session is now idle."
   - **Unclean shutdown detection:** If `last_error == "unclean_shutdown"`:
     - In always-on mode: set `session_state` to `waiting` and `waiting_reason` to `"unclean_shutdown"` in runtime.json, notify the operator via channel: "Came back up after unclean shutdown. Previous task: [task from SHELL.md, or 'unknown']. Reply with (1) to archive as partial and start fresh, or (2) to resume where we left off." Then stop — channel-responder handles the reply. If `heartbeat.waiting_timeout` is set, heartbeat will auto-transition to `idle` after timeout elapses with no channel activity.
     - In interactive mode: tell the operator "Previous session was not closed cleanly." Offer: (a) Archive as `partial` and start fresh, (b) Resume as-is.
     - Clear `last_error` after the operator decides.
   - **Dead process detection:** If `session_state == "dead_process"`: same flow as unclean shutdown above. Set `waiting_reason` to `"dead_process"` in runtime.json. Message: "Process died unexpectedly. Previous task: [task from SHELL.md, or 'unknown']. Reply with (1) to archive as partial and start fresh, or (2) to resume where we left off."
   - **Normal state:** If `session_state` is `idle` → ready for new task. If `in_progress` or `waiting` → existing session, offer resume.
3b. **Watch registry reset.** Read `state/monitors.runtime.json` and clear all entries unconditionally — watches are session-scoped, so any previous entries are stale. If the file is missing, skip. This runs on every session start (new, resume, or crash recovery) before any watch registration occurs.
4. **Session state routing** — evaluate the fast-path gate before spawning session-mgr.

   **Fast path (skip session-mgr) — ALL five must be true:**
   - `runtime.json` was found and parsed successfully (not missing, not malformed)
   - `session_state` ∈ {`in_progress`, `idle`, `waiting`}
   - `transition` is null
   - `last_error` is null
   - `.claude-code-hermit/sessions/SHELL.md` exists

   If all five are true: SHELL.md content is already available from the startup hook injection. Proceed directly to step 4b with the data already in hand. Do **not** spawn session-mgr. Read `session_id` from runtime.json — if set and SHELL.md `**ID:**` still contains the placeholder `S-NNN`, update it to the actual session ID (e.g., `S-009`) in-context without spawning session-mgr.

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
   - When a task is provided: use `claude-code-hermit:session-mgr` to set Status back to `in_progress` (cosmetic in SHELL.md) and update runtime.json `session_state` to `in_progress`. Fill in Task. After confirming the plan with the operator, create native Tasks (`TaskCreate`) for each step.
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

   3. Pre-flight: scan `config.json` `plugin_checks` for any entry in the fixed list below with `enabled: true`. If **none** qualify, delete the marker silently and continue to step 6.

      For each skill in the fixed list below, in order:
      - `/claude-md-management:claude-md-improver`
      - `/claude-code-setup:claude-automation-recommender`

      Do NOT invoke `/claude-md-management:revise-claude-md` — it is a session-trigger skill, not an audit, and runs separately via its own `plugin_checks` entry.

      For each audit skill:
      - Check `config.json` `plugin_checks` for a matching `skill` field with `enabled: true`. If absent or disabled, skip silently.
      - Emit a one-line progress signal before invoking (channel in always-on, inline otherwise): "Running {skill}…"
      - Invoke the skill.
      - If it reports unavailable/not-installed: append one SHELL.md Findings line ("Baseline audit: {skill} unavailable") and continue.
      - If it returns findings: route through `/claude-code-hermit:proposal-create` as **one proposal per plugin invocation**, with **`source: operator-request`** in the frontmatter. (Not `auto-detected` — that routes through reflection-judge expecting cross-session evidence citations the audit cannot provide.) Write the Problem section as a prioritized summary of all findings (top 3 inline, remainder as a bulleted list).

   4. Surface a single-line summary to the operator (channel in always-on, inline otherwise):

      > "Baseline audit done. {N} proposals queued: PROP-XXX[, PROP-YYY]. Review with /claude-code-hermit:proposal-list."

   **Guard:** the marker is the one-shot gate. Absent marker → this step never fires.

   **Note for maintainers:** `md-audit` and `automation-recommender` are already scheduled on 7-day intervals via `plugin_checks`. This step pulls the first run forward to day 1 with operator consent — it is not an independent execution path.

6. Check if `.claude-code-hermit/sessions/NEXT-TASK.md` exists. If it does:
   - Present the prepared task to the operator as the suggested task for this session
   - If the operator accepts it: use it as the task (skip asking "What should I help with?")
   - If the operator provides a different task: delete `NEXT-TASK.md` and proceed with their task
   - Always delete `NEXT-TASK.md` after it has been presented (whether accepted or not)
7. Scan `.claude-code-hermit/proposals/` for files with `Source: auto-detected` and `Status: proposed`. If any exist, mention: "There are N unreviewed auto-detected proposal(s). Review with `/proposal-list` when ready." Do NOT block the session — this is a one-line notification only.
7b. **Interactive morning brief.** If `config.always_on` is `false` AND `config.routines` contains an enabled entry with skill containing `brief --morning`: run the morning brief inline — generate a brief emphasizing where things stand, pending proposals, and what's on deck. No dedup needed — interactive sessions are short-lived.
8. If `agent_name` is set, use it in the greeting (e.g., "Atlas reporting in." or "{name} a reportar." if language is `pt`). If `language` is set, communicate with the operator in that language for the rest of the session.
   In always-on mode: if no recovery message was sent in step 3, notify the operator via channel with a startup ping (1 line): "[name or 'Hermit'] online. Reviewing session state." Skip this ping if a recovery question was already sent — the recovery message is the boot signal.
9. If resuming an existing session (runtime.json `session_state` is `in_progress` or `waiting`):
   - Call `TaskList` to see current plan steps. Present the current task, progress (completed/remaining tasks), and blockers.
   - If the session status is `blocked`: suggest running `/debug` to diagnose tool/hook failures before re-attempting the blocked work
   - Ask the operator if they want to continue the current task or start a new one
9b. If resuming an idle session (runtime.json `session_state` is `idle`):
   - Show session continuity info: tasks completed, session duration, cumulative cost
   - Ask: "What should I work on next?" (unless a NEXT-TASK.md was accepted in step 6)
   - Once provided, use `claude-code-hermit:session-mgr` to update SHELL.md: set Status to `in_progress` (cosmetic), fill Task. Update runtime.json `session_state` to `in_progress`. After confirming the plan, create native Tasks for each step.
10. If starting a new session:
   - Ask the operator: "What should I help with?" (unless a NEXT-TASK.md was accepted in step 6)
   - Once provided, use `claude-code-hermit:session-mgr` to create the session with the task. After confirming the plan, create native Tasks (`TaskCreate`) for each step.
11. Once I know what to work on (new session only):
    - **Tags:** Ask "Any tags for this session? (e.g., refactor, frontend, urgent) Enter to skip." Write the answer to the `Tags:` field in SHELL.md. If skipped, leave blank.
    - **Budget:** Check `ask_budget` from the config read in step 1. If `ask_budget` is `true`:
      - Ask: "Set a cost budget for this work?"
        1. Set budget — enter a dollar amount → write `Budget: $X.XX` to SHELL.md
        2. No budget for this session — leave Budget field blank
        3. Never ask about budget — set `ask_budget` to `false` in config.json, leave Budget blank
    - If `ask_budget` is `false`: skip the budget prompt silently.
11b. **Watch registration.** If `config.monitors` exists and has enabled entries, invoke
     `/claude-code-hermit:watch start` to register them. (Registry was already cleared in
     step 3b.) This is silent — do not prompt the operator about watch registration.
12. Identify the first actionable step and confirm with the operator before proceeding

## Context to Load

- `.claude-code-hermit/OPERATOR.md` (always)
- `.claude-code-hermit/sessions/SHELL.md` (if exists)
- Most recent `.claude-code-hermit/sessions/S-*-REPORT.md` (for continuity — only the latest one)
- `.claude-code-hermit/state/runtime.json` (always — for lifecycle state)

Do NOT load all session reports — only the most recent one.