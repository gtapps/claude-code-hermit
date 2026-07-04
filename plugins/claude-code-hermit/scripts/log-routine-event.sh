#!/usr/bin/env bash
# Append one event line to .claude-code-hermit/state/routine-metrics.jsonl
# Usage: log-routine-event.sh <routine-id> <event>
# Events: fired | skipped-waiting | skipped-paused | started
set -euo pipefail

id="$1"
event="$2"

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

metrics="$dir/.claude-code-hermit/state/routine-metrics.jsonl"

# Dedup guard (issue #464): heartbeat-restart re-invokes `hermit-routines load`
# at its own prompt tail, which can re-trigger the cron and emit a second
# `fired` with no intervening `started`. The prompt always logs `started`
# immediately before `fired`, so a `fired` whose latest same-routine event is
# already `fired` can only be the spurious re-trigger. Portable; no date math.
if [[ "$event" == "fired" && -f "$metrics" ]]; then
  last="$(grep -F "\"routine_id\":\"$id\"" "$metrics" | tail -n 1 || true)"
  [[ "$last" == *'"event":"fired"'* ]] && exit 0
fi

ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
printf '{"ts":"%s","routine_id":"%s","event":"%s","delivery":"cron-create"}\n' \
  "$ts" "$id" "$event" \
  >> "$metrics"
