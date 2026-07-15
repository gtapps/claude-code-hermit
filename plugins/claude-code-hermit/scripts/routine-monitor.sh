#!/usr/bin/env bash
# Usage: routine-monitor.sh <interval_seconds> <hermit_state_dir>
# Env: ROUTINE_MONITOR_ONCE=1    → run one iteration and exit (tests)
#      ROUTINE_DUE_SCRIPT=<path> → override routine-due path (tests)
# Polls routine-due.ts, which owns all gating/state/liveness writes and prints a
# ROUTINE_DUE line only when eligible routines are due. No first-iteration
# suppression needed: routine-due initializes unseen routines to "now" and fires
# nothing on a fresh baseline.
#
# routine-due.ts always exits 0, so the error branch only fires on a hard spawn
# failure (bun missing, script renamed). To avoid a wake-notification storm, the
# ROUTINE_MONITOR_ERROR line is throttled: emitted on the 1st failure and every
# 60th consecutive failure thereafter; any success resets the counter.
set -u
INTERVAL="${1:?usage: routine-monitor.sh <interval_seconds> <hermit_state_dir>}"
RT_DIR="${2:?usage: routine-monitor.sh <interval_seconds> <hermit_state_dir>}"
DUE="${ROUTINE_DUE_SCRIPT:-$(dirname "$0")/routine-due.ts}"
fail_count=0
# Emission grammar (this line's "$out" and the ROUTINE_MONITOR_ERROR line below) is
# load-bearing: record-operator-action.ts isRoutinePrompt() drops these lines;
# tests/auto-close.test.ts drift guard syncs them.
while true; do
  if out="$(bun "$DUE" "$RT_DIR" 2>/dev/null)"; then
    fail_count=0
    [[ -n "$out" ]] && echo "$out"
  else
    fail_count=$((fail_count + 1))
    if (( fail_count == 1 || fail_count % 60 == 0 )); then
      echo "ROUTINE_MONITOR_ERROR: routine-due failed (${fail_count} consecutive)"
    fi
  fi
  [[ -n "${ROUTINE_MONITOR_ONCE:-}" ]] && break
  sleep "$INTERVAL"
done
