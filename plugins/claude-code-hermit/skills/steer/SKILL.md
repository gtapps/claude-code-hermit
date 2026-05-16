---
name: steer
description: Steers the always-on hermit toward the next focus. Loads operator context, runs dirty-shutdown recovery if needed, and either takes a positional `<focus text>` argument or asks the operator what to work on. Activates on messages like "let's start", "good morning", "what's on deck", "let's tackle X", "I'm starting on X".
---
# Steer

## Operator Notification
Notify the operator per the channel policy in CLAUDE.md (§ Operator Notification).

All state lives under `.claude-code-hermit/` in the project root.

## Workflow

1. **Load context.** Read `config.json` (identity, language, channels), `OPERATOR.md`, `sessions/SHELL.md`, `state/runtime.json`. If the SessionStart hook injection mentioned "---Upgrade Available---", surface it once to the operator without blocking.

2. **Process-died check.** If `runtime.tmux_session` is set AND `runtime.runtime_mode` ∈ {`tmux`, `docker`} AND that tmux session is NOT alive (`tmux has-session -t <name>` fails), the previous process died without graceful shutdown.

3. **Unclean-shutdown check.** If `runtime.shutdown_requested_at` is set AND (`runtime.shutdown_completed_at` is null OR `shutdown_completed_at < shutdown_requested_at` via lexical compare of UTC-Z ISO timestamps), the previous shutdown didn't complete.

4. **Recovery prompt.** If (2) or (3) fired AND SHELL.md `## Focus` has non-placeholder content:
   - Use `claude-code-hermit:focus-mgr` to write a recovery marker to SHELL.md Findings (`<!-- pending-recovery: awaiting-1-or-2 -->`) and prompt the operator: "Previous run didn't shut down cleanly. Focus in flight was: '<focus content, one line>'. Reply (1) to drop this focus and start fresh, or (2) to resume where we left off."
   - In always-on mode: send via channel. In interactive mode: ask inline.
   - Clear `runtime.shutdown_requested_at` after the operator decides.
   - On (1): clear Focus + Progress Log + Findings, set `session_state` to `idle`. On (2): keep Focus, set `session_state` to `in_progress`.

5. **Stale-field tolerance.** If runtime.json contains retired fields (`transition`, `transition_target`, `transition_started_at`, `waiting_reason`, `last_error`, `session_id`, `session_state == "dead_process"`), ignore them silently. The next runtime.json write drops them.

6. **Watch registry reset.** Read `state/monitors.runtime.json` and clear all entries unconditionally — watches are session-scoped. If the file is missing, skip.

7. **Daily counter reset (interim until PROP-036).** Read `state/.status.json` → `last_counter_reset`. If absent OR less than today's date (operator timezone from `config.timezone`, default UTC), reset `cost_usd`, `tokens`, `operator_turns` to 0 and update `last_counter_reset` to today's date.

8. **Baseline audit offer (first session only).** Check for `.claude-code-hermit/.baseline-pending`. If absent, skip. If present:

   1. Notify per channel policy: "First session on this project. Want me to run a one-time audit using the plugins you installed at hatch? It'll surface CLAUDE.md gaps and automation opportunities. (yes / no)"

      <!-- Compatible-plugin list is mirrored in hatch Phase 4 options and Phase 4b eligibility. Update both when adding. -->

   2. Handle response:
      - **no / decline** → delete marker, log one SHELL.md Findings line ("Baseline audit declined."), continue.
      - **yes** → **delete `.claude-code-hermit/.baseline-pending` immediately** (marker semantic = "we haven't offered yet"). Once consented, the offer is consumed regardless of invocation outcome.

   3. Pre-flight: scan `config.json` `scheduled_checks` for any entry in the fixed list below with `enabled: true`. If **none** qualify, delete the marker silently and continue.

      For each skill in the list, in order:
      - `/claude-md-management:claude-md-improver`
      - `/claude-code-setup:claude-automation-recommender`

      For each audit skill: check `scheduled_checks` for a matching `skill` field with `enabled: true`. If absent or disabled, skip silently. Otherwise emit "Running {skill}…", invoke. If unavailable: append one SHELL.md Findings line and continue. If findings: route through `/claude-code-hermit:proposal-create` as one proposal per plugin invocation, with `Evidence Source: operator-request` and `source: operator-request` in frontmatter.

   4. Surface a single-line summary: "Baseline audit done. {N} proposals queued: PROP-XXX[, PROP-YYY]. Review with /claude-code-hermit:proposal-list."

9. **Task or pivot?**

   - **If a positional `<focus text>` argument was passed** (typical idle-pickup, routine pickup, or operator direct invocation, e.g. `/steer dependency audit`):
     - Use `claude-code-hermit:focus-mgr` to set SHELL.md `## Focus` to the focus text, append `[HH:MM] Started: <focus text>` to `## Progress Log`, set `runtime.session_state` to `in_progress`.
     - Skip to step 12.

   - **If `.claude-code-hermit/sessions/NEXT-TASK.md` exists:**
     - Present its content as the suggested focus.
     - If the operator accepts: treat as the focus text, use focus-mgr to set Focus, log Progress, set `in_progress`.
     - If the operator provides a different focus: delete `NEXT-TASK.md` and use the operator's input.
     - Always delete `NEXT-TASK.md` after presentation.

   - **If SHELL.md `## Focus` has non-placeholder content** (resuming):
     - Call `TaskList`. Show: current focus, progress (completed/remaining), and any blockers from `## Findings`.
     - Ask: "Continue this, or pivot to something else?"

   - **Otherwise** (idle, no Focus, no NEXT-TASK):
     - Ask: "What should I work on?"
     - Once provided: use focus-mgr to set Focus + Progress entry + `in_progress`.

10. **Proposal mention.** Scan `.claude-code-hermit/proposals/` for files with `source: auto-detected` and `status: proposed`. If any exist, one-liner: "There are N unreviewed auto-detected proposal(s). Review with `/proposal-list`." Do NOT block.

11. **Interactive morning brief.** If `config.always_on` is `false` AND `config.routines` contains an enabled entry with skill containing `brief --morning`: run inline. No dedup — interactive sessions are short-lived.

12. **Tags + budget (new focus only).** If a fresh focus was just set:
    - **Tags:** Ask "Any tags for this focus? (e.g., refactor, frontend, urgent) Enter to skip." Write to SHELL.md `Tags:` field if provided.
    - **Budget:** Check `config.ask_budget`. If `true`: ask "Set a cost budget?" Options: (1) enter dollar amount → write `Budget: $X.XX`, (2) no budget this focus, (3) never ask again → set `ask_budget: false`. If `false`: skip silently.

13. **Watch registration.** If `config.monitors` exists with enabled entries, invoke `/claude-code-hermit:watch start`. Silent — do not prompt.

14. **Greeting.** If `config.agent_name` is set, use it (e.g., "Atlas reporting in."). If `config.language` is set, communicate in that language for the rest of the session. In always-on mode and no recovery message was sent: channel ping "[name or 'Hermit'] online. Reviewing focus."

15. **First step.** Identify the first actionable step and confirm with the operator before proceeding. For multi-step work: create native Tasks via `TaskCreate`.

## Context to Load

- `.claude-code-hermit/OPERATOR.md` (always)
- `.claude-code-hermit/sessions/SHELL.md` (if exists — for `## Focus` and `## Recent Activity`)
- `.claude-code-hermit/state/runtime.json` (always)

Do NOT load historical `S-*-REPORT.md` files unless the operator specifically asks about prior work.
