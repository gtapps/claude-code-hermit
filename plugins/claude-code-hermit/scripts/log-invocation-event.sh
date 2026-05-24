#!/usr/bin/env bash
# Append one event line to .claude-code-hermit/state/invocation-log.jsonl
# Usage:
#   log-invocation-event.sh skill-invoke <skill> <triggered_by> [<routine_id>]
#   log-invocation-event.sh proposal-accept <proposal_id>
#   log-invocation-event.sh proposal-resolve <proposal_id>
set -euo pipefail

subcmd="${1:-}"
ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
session_id="$(node -e "try{var d=JSON.parse(require('fs').readFileSync('.claude-code-hermit/state/runtime.json','utf-8'));process.stdout.write(d.session_id||'')}catch(e){process.stdout.write('')}" 2>/dev/null || true)"

case "$subcmd" in
  skill-invoke)
    skill="${2:-}"
    triggered_by="${3:-operator}"
    routine_id="${4:-}"
    if [ -n "$routine_id" ]; then
      printf '{"ts":"%s","session_id":"%s","event":"skill-invoke","skill":"%s","triggered_by":"%s","routine_id":"%s"}\n' \
        "$ts" "$session_id" "$skill" "$triggered_by" "$routine_id" \
        >> ".claude-code-hermit/state/invocation-log.jsonl"
    else
      printf '{"ts":"%s","session_id":"%s","event":"skill-invoke","skill":"%s","triggered_by":"%s"}\n' \
        "$ts" "$session_id" "$skill" "$triggered_by" \
        >> ".claude-code-hermit/state/invocation-log.jsonl"
    fi
    ;;
  proposal-accept)
    proposal_id="${2:-}"
    printf '{"ts":"%s","session_id":"%s","event":"proposal-accept","proposal_id":"%s"}\n' \
      "$ts" "$session_id" "$proposal_id" \
      >> ".claude-code-hermit/state/invocation-log.jsonl"
    ;;
  proposal-resolve)
    proposal_id="${2:-}"
    printf '{"ts":"%s","session_id":"%s","event":"proposal-resolve","proposal_id":"%s"}\n' \
      "$ts" "$session_id" "$proposal_id" \
      >> ".claude-code-hermit/state/invocation-log.jsonl"
    ;;
  *)
    echo "Usage: log-invocation-event.sh <skill-invoke|proposal-accept|proposal-resolve> [args...]" >&2
    exit 1
    ;;
esac
