#!/usr/bin/env bash
# Usage: heartbeat-monitor.sh <interval_seconds> <hermit_state_dir>
# Env: HEARTBEAT_MONITOR_ONCE=1  → run one iteration and exit (tests)
#      HEARTBEAT_PRECHECK=<path> → override precheck path (tests)
# Polls heartbeat-precheck.ts --peek and emits a notification only when the
# LLM needs to wake up (EVALUATE or AUTO_CLOSE verdict). --peek means the
# polling itself is read-only; the mutating tick happens once when
# /heartbeat run re-runs precheck inside the EVALUATE handler.
# First-iteration EVALUATE is suppressed: at cold boot the monitor fires
# within seconds of session-start (alerts{} empty, checklist unseen), which
# would trigger a redundant /heartbeat run. AUTO_CLOSE is never suppressed —
# a queued drain must fire immediately regardless of boot state.
set -u
INTERVAL="${1:?usage: heartbeat-monitor.sh <interval_seconds> <hermit_state_dir>}"
HB_DIR="${2:?usage: heartbeat-monitor.sh <interval_seconds> <hermit_state_dir>}"
PRECHECK="${HEARTBEAT_PRECHECK:-$(dirname "$0")/heartbeat-precheck.ts}"
mkdir -p "$HB_DIR/state"
first=1
while true; do
  verdict="$(bun "$PRECHECK" --peek "$HB_DIR" 2>/dev/null || echo "ERROR")"
  _ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf '{"last_peek_at":"%s"}\n' "$_ts" > "$HB_DIR/state/.heartbeat-liveness.tmp" \
    && mv "$HB_DIR/state/.heartbeat-liveness.tmp" "$HB_DIR/state/heartbeat-liveness.json" \
    || true
  case "$verdict" in
    EVALUATE*)
      [[ -n "$first" ]] || echo "HEARTBEAT_EVALUATE" ;;
    AUTO_CLOSE*)          echo "HEARTBEAT_EVALUATE" ;;
    OK|SKIP\|*)           : ;;  # silent — designed no-op
    ERROR*)               echo "HEARTBEAT_ERROR: precheck failed" ;;
    *)                    echo "HEARTBEAT_ERROR: unknown verdict: $verdict" ;;
  esac
  first=""
  [[ -n "${HEARTBEAT_MONITOR_ONCE:-}" ]] && break
  sleep "$INTERVAL"
done
