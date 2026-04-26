#!/usr/bin/env bash
# Append one event line to .claude-code-hermit/state/routine-metrics.jsonl
# Usage: log-routine-event.sh <routine-id> <event>
# Events: fired | skipped-waiting
set -euo pipefail

id="$1"
event="$2"
ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

printf '{"ts":"%s","routine_id":"%s","event":"%s","delivery":"cron-create"}\n' \
  "$ts" "$id" "$event" \
  >> ".claude-code-hermit/state/routine-metrics.jsonl"
