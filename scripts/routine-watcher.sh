#!/usr/bin/env bash
# Routine watcher — reads config.json every 60s, fires skills at scheduled times.
# Queues routines during in_progress, dequeues when idle/waiting.
# Runs as a tmux window inside the hermit session — dies when session is killed.
# Args: $1 = tmux session name, $2 = config.json path
SESSION="$1"
CONFIG="$2"
TARGET="$SESSION:0.0"
STATE_DIR="$(dirname "$CONFIG")"
QUEUE_FILE="$STATE_DIR/state/routine-queue.json"
# Ephemeral dedup state — resets on reboot (acceptable: worst case a routine fires twice)
STATE="/tmp/hermit-routines-$(echo "$SESSION" | tr -cd 'a-zA-Z0-9-')"

# Append a routine to the queue file (idempotent per routine per day)
queue_routine() {
  python3 -c "
import json, sys, datetime
f, rid, skill, date = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
try: q = json.load(open(f))
except: q = {'queued': []}
if not any(e['id'] == rid and e['queued_date'] == date for e in q['queued']):
    q['queued'].append({
        'id': rid, 'queued_date': date,
        'queued_since': datetime.datetime.now().isoformat(),
        'skill': skill
    })
    json.dump(q, open(f, 'w'))
" "$QUEUE_FILE" "$1" "$2" "$3" 2>/dev/null
}

# Reset ephemeral state on start
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

  STATUS=$(cat "$STATE_DIR/.status" 2>/dev/null || echo "idle")

  # --- Dequeue: process queued routines when status allows ---
  if [ "$STATUS" = "idle" ] || [ "$STATUS" = "waiting" ]; then
    if [ -f "$QUEUE_FILE" ]; then
      python3 -c "
import json, sys, subprocess
f, target, state, today = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
config_path = sys.argv[5]
status = sys.argv[6]
try: q = json.load(open(f))
except: sys.exit(0)
# Read config once for run_during_waiting lookups
cfg = {}
if status == 'waiting':
    try: cfg = json.load(open(config_path))
    except: pass
remaining = []
processed_one = False
for item in q.get('queued', []):
    if processed_one:
        remaining.append(item)
        continue
    fired_key = today + ':' + item['id']
    try:
        with open(state) as sf:
            if fired_key in sf.read():
                continue
    except: pass
    if status == 'waiting':
        rdw = False
        for r in cfg.get('routines', []):
            if r.get('id') == item['id']:
                rdw = r.get('run_during_waiting', False)
                break
        if not rdw:
            remaining.append(item)
            continue
    result = subprocess.run(['tmux', 'send-keys', '-t', target, '/' + item['skill'], 'Enter'], capture_output=True)
    if result.returncode == 0:
        with open(state, 'a') as sf:
            sf.write(fired_key + '\n')
        processed_one = True
    else:
        remaining.append(item)
json.dump({'queued': remaining}, open(f, 'w'))
" "$QUEUE_FILE" "$TARGET" "$STATE" "$TODAY" "$CONFIG" "$STATUS" 2>/dev/null
    fi
  fi

  # --- Schedule: check time-matched routines ---
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

    if [ "$STATUS" = "in_progress" ]; then
      queue_routine "$rid" "$skill" "$TODAY"
      continue
    elif [ "$STATUS" = "waiting" ]; then
      # Check run_during_waiting flag
      RDW=$(jq -r --arg id "$rid" '.routines[]? | select(.id==$id) | .run_during_waiting // false' "$CONFIG" 2>/dev/null)
      if [ "$RDW" != "true" ]; then
        queue_routine "$rid" "$skill" "$TODAY"
        continue
      fi
      # Fall through and fire normally
    fi

    # Fire the routine (idle, or waiting with run_during_waiting=true)
    echo "$FIRED_KEY" >> "$STATE"
    tmux send-keys -t "$TARGET" "/${skill}" Enter
  done

  sleep 60
done
