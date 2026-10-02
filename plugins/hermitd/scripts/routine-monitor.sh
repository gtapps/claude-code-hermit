#!/usr/bin/env bash
# Usage: routine-monitor.sh <interval_seconds> <hermit_state_dir>
# Env: ROUTINE_MONITOR_ONCE=1    → run one iteration and exit (tests)
#      ROUTINE_DUE_SCRIPT=<path> → override routine-due path (tests). Still a bare
#                                  script path called with `<dir>`; the default
#                                  now prepends routines.ts's verb.
# Polls `routines.ts due`, which owns all gating/state/liveness writes and prints a
# ROUTINE_DUE line only when eligible routines are due. No first-iteration
# suppression needed: routine-due initializes unseen routines to "now" and fires
# nothing on a fresh baseline.
#
# `routines.ts due` always exits 0, so the error branch only fires on a hard spawn
# failure (bun missing, script renamed). To avoid a wake-notification storm, the
# ROUTINE_MONITOR_ERROR line is throttled: emitted on the 1st failure and every
# 60th consecutive failure thereafter; any success resets the counter.
set -u
INTERVAL="${1:?usage: routine-monitor.sh <interval_seconds> <hermit_state_dir>}"
RT_DIR="${2:?usage: routine-monitor.sh <interval_seconds> <hermit_state_dir>}"
# Absolute: the sweep below runs it from inside a `cd` subshell, so a relative
# $0 (bash scripts/routine-monitor.sh …) would resolve against the wrong dir.
SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
# Array, not a string — see heartbeat-monitor.sh for why.
if [[ -n "${ROUTINE_DUE_SCRIPT:-}" ]]; then
  DUE=("$ROUTINE_DUE_SCRIPT")
else
  DUE=("$SCRIPT_DIR/routines.ts" due)
fi
fail_count=0
# Spawn-worktree sweep. The root is the git toplevel, not $RT_DIR/..: rc-server
# creates and scans worktrees under the repo root, which is only the hermit's
# project dir when the hermit was hatched there — gating on the wrong dir would
# silently never sweep. Every SWEEP_EVERY-th poll, not every one: a dirty orphan
# is kept by design, so an every-poll sweep would cost a bun spawn and a full
# process scan (lsof over every process on darwin) once a minute for as long as
# that worktree sits there.
SWEEP_ROOT="$(cd "$RT_DIR/.." 2>/dev/null && git rev-parse --show-toplevel 2>/dev/null)"
[[ -n "$SWEEP_ROOT" ]] || SWEEP_ROOT="$RT_DIR/.."
SWEEP_EVERY=10
sweep_tick=0
# Emission grammar (this line's "$out" and the ROUTINE_MONITOR_ERROR line below) is
# load-bearing: record-operator-action.ts isRoutinePrompt() drops these lines;
# tests/heartbeat-monitor-emissions.test.ts drift guard syncs them.
while true; do
  # Under the supervisor, a fallback recorded after this poller started (a spawn
  # slower than arm commit's wait) hands routines to CronCreate: exit so both
  # schedulers never fire the same routine.
  if [[ -n "${MONITOR_SUPERVISOR_PID:-}" ]] && bun "$SCRIPT_DIR/lib/monitor-leg-stopped.ts" "$RT_DIR" routines >/dev/null 2>&1; then
    exit 0
  fi
  if out="$(bun "${DUE[@]}" "$RT_DIR" 2>/dev/null)"; then
    fail_count=0
    [[ -n "$out" ]] && echo "$out"
  else
    fail_count=$((fail_count + 1))
    if (( fail_count == 1 || fail_count % 60 == 0 )); then
      echo "ROUTINE_MONITOR_ERROR: routine-due failed (${fail_count} consecutive)"
    fi
  fi
  if (( sweep_tick % SWEEP_EVERY == 0 )) && compgen -G "$SWEEP_ROOT/.claude/worktrees/bridge-*" >/dev/null; then
    (cd "$SWEEP_ROOT" && bun "$SCRIPT_DIR/rc-server.ts" sweep) >/dev/null 2>&1 || true
  fi
  sweep_tick=$((sweep_tick + 1))
  [[ -n "${ROUTINE_MONITOR_ONCE:-}" ]] && break
  sleep "$INTERVAL"
done
