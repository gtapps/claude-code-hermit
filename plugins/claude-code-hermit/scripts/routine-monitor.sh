#!/usr/bin/env bash
# Usage: routine-monitor.sh <interval_seconds> <hermit_state_dir>
# Env: ROUTINE_MONITOR_ONCE=1    → run one iteration and exit (tests)
#      ROUTINE_DUE_SCRIPT=<path> → override routine-due path (tests)
# Polls routine-due.ts, which owns all gating/state/liveness writes and prints a
# ROUTINE_DUE line only when eligible routines are due. No first-iteration
# suppression needed: routine-due initializes unseen routines to "now" and fires
# nothing on a fresh baseline.
set -u
INTERVAL="${1:?usage: routine-monitor.sh <interval_seconds> <hermit_state_dir>}"
RT_DIR="${2:?usage: routine-monitor.sh <interval_seconds> <hermit_state_dir>}"
DUE="${ROUTINE_DUE_SCRIPT:-$(dirname "$0")/routine-due.ts}"
while true; do
  if out="$(bun "$DUE" "$RT_DIR" 2>/dev/null)"; then
    [[ -n "$out" ]] && echo "$out"
  else
    echo "ROUTINE_MONITOR_ERROR: routine-due failed"
  fi
  [[ -n "${ROUTINE_MONITOR_ONCE:-}" ]] && break
  sleep "$INTERVAL"
done
