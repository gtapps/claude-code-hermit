#!/usr/bin/env bash
# Append one event line to .claude-code-hermit/state/routine-metrics.jsonl
# Usage: log-routine-event.sh <routine-id> <event>
# Events: fired | skipped-waiting
set -euo pipefail

id="$1"
event="$2"
ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# CronCreate prompts fire with $PWD set to the session's primary working
# directory, which may be a subdirectory of the hermit project root. Walk up
# to the nearest ancestor containing .claude-code-hermit/ so the relative path
# resolves correctly regardless of launch CWD.
dir="$PWD"
while [[ "$dir" != "/" ]]; do
  [[ -d "$dir/.claude-code-hermit" ]] && break
  dir="$(dirname "$dir")"
done
if [[ "$dir" == "/" ]]; then
  echo "log-routine-event.sh: could not find .claude-code-hermit/ in any parent of $PWD" >&2
  exit 1
fi

printf '{"ts":"%s","routine_id":"%s","event":"%s","delivery":"cron-create"}\n' \
  "$ts" "$id" "$event" \
  >> "$dir/.claude-code-hermit/state/routine-metrics.jsonl"
