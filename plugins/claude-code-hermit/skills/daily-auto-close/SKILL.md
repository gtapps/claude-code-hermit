---
name: daily-auto-close
description: Daily routine that closes the current session at midnight when the operator has been idle ≥10 minutes. Queues a pending close (drained by heartbeat) when the operator is currently active. Intended to fire via the `daily-auto-close` routine; safe to invoke manually.
---
# Daily Auto-Close

Closes long-running daemon sessions on a daily cadence so cross-session learning surfaces (`reflect`, `weekly-review`, `hermit-brain`, `hermit-evolution`) have archives to work with.

The skill is invoked by the `daily-auto-close` routine at `0 0 * * *` (local). The routine prompt is prefixed `[hermit-routine:daily-auto-close]` so `scripts/record-operator-action.js` does not bump `state/last-operator-action.json` (load-bearing: this skill reads that clock to decide whether to close now or queue).

## Steps

1. Read `.claude-code-hermit/state/runtime.json` (`session_state`).
2. Read `.claude-code-hermit/state/last-operator-action.json` (`at`).
3. Check whether `.claude-code-hermit/state/pending-close.json` exists.
4. Branch:

   **a. `session_state` not in `{"in_progress", "idle"}`** — nothing to close.
   - If `pending-close.json` exists → delete it (stale flag from a prior session that already closed). Use the Bash tool: `rm -f .claude-code-hermit/state/pending-close.json`.
   - Stop. Do not notify the operator. Do not write to `routine-metrics.jsonl` (no-op events are not part of the existing `log-routine-event.sh` vocabulary).

   **b. `session_state` in `{"in_progress", "idle"}` AND `now - last_operator_action > 10min`** — safe lull; close directly.
   - Invoke `/claude-code-hermit:session-close --auto`. The auto-close path archives the session and clears `pending-close.json` itself on archive success.
   - Stop.

   **c. `session_state` in `{"in_progress", "idle"}` AND `now - last_operator_action ≤ 10min`** — operator is currently active; queue.
   - Write `.claude-code-hermit/state/pending-close.json` with `{"queued_at":"<now ISO>","queued_by":"daily-auto-close"}` (singleton; overwrite unconditionally). Use the Write tool.
   - Stop. The heartbeat-precheck drain block will emit `AUTO_CLOSE` on the next tick where the operator has been idle >10 minutes.

5. If `last-operator-action.json` is absent, unreadable, or has no valid `at` timestamp: treat as "operator has been idle indefinitely" → take branch (b) (close directly). Fail-open: it's better to close an arguably-still-active session than to leak the routine into perpetual noop.

## Notes

- The skill is intentionally silent. No operator notification on queue or drain — the existing `Auto-closed S-NNN` notification from `/session-close --auto` is the only operator-facing signal.
- The 10-minute lull threshold is hardcoded. If operators report mid-conversation closes, raise it; the threshold is a single constant in this skill and in `scripts/heartbeat-precheck.js`.
- When heartbeat is disabled and the operator stays active past midnight, this routine itself acts as the slow-path drain on the next day's tick: it re-evaluates and closes directly if branch (b)'s conditions are met.
