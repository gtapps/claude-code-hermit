#!/usr/bin/env bash
# Routine watcher — reads config.json every 60s, fires skills at scheduled times.
# Runs as a tmux window inside the hermit session — dies when session is killed.
# Args: $1 = tmux session name, $2 = config.json path
SESSION="$1"
CONFIG="$2"
TARGET="$SESSION:0.0"
STATE_DIR="$(dirname "$CONFIG")"
STATE="/tmp/hermit-routines-$(echo "$SESSION" | tr -cd 'a-zA-Z0-9-')"

# Reset state on start
> "$STATE"
LAST_DATE=""

while true; do
  export TZ=$(jq -r '.timezone // "UTC"' "$CONFIG" 2>/dev/null)
  NOW_HHMM=$(date +%H:%M)
  NOW_DAY=$(date +%a | tr '[:upper:]' '[:lower:]')
  TODAY=$(date +%Y-%m-%d)

  # Reset dedup state on new day
  if [ "$TODAY" != "$LAST_DATE" ]; then
    > "$STATE"
    LAST_DATE="$TODAY"
  fi

  # Read enabled routines matching current time and day
  jq -r --arg t "$NOW_HHMM" --arg d "$NOW_DAY" '
    .routines[]? | select(.enabled==true) | select(.time==$t) |
    select((.days == null) or (.days | index($d) != null)) |
    .id + "\t" + .skill
  ' "$CONFIG" 2>/dev/null | while IFS=$'\t' read -r rid skill; do
    FIRED_KEY="${TODAY}:${rid}"
    # Dedup: once per routine per day
    if grep -qF "$FIRED_KEY" "$STATE" 2>/dev/null; then
      continue
    fi
    # Check .status file — skip if actively working (retry next minute)
    STATUS=$(cat "$STATE_DIR/.status" 2>/dev/null || echo "idle")
    if [ "$STATUS" = "in_progress" ]; then
      continue
    fi
    echo "$FIRED_KEY" >> "$STATE"
    tmux send-keys -t "$TARGET" "/claude-code-hermit:${skill}" Enter
  done

  sleep 60
done
