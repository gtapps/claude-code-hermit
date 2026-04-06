#!/usr/bin/env bash
# Routine watcher — reads config.json every 60s, fires skills at scheduled times.
# Queues routines during in_progress, dequeues when idle/waiting.
# Runs as a tmux window inside the hermit session — dies when session is killed.
# Args: $1 = tmux session name, $2 = config.json path
SESSION="$1"
CONFIG="$2"
TARGET="$SESSION:0.0"
STATE_DIR="$(dirname "$CONFIG")/state"
QUEUE_FILE="$STATE_DIR/routine-queue.json"
RUNTIME_JSON="$STATE_DIR/runtime.json"
LIFECYCLE_LOCK="$STATE_DIR/.lifecycle.lock"
HEARTBEAT_FILE="$STATE_DIR/.heartbeat"
# Ephemeral dedup state — resets on reboot (acceptable: worst case a routine fires twice)
STATE="/tmp/hermit-routines-$(echo "$SESSION" | tr -cd 'a-zA-Z0-9-')"

# Read session_state from runtime.json (single source of lifecycle truth)
read_session_state() {
  jq -r '.session_state // "idle"' "$RUNTIME_JSON" 2>/dev/null || echo "idle"
}

# Locked atomic write to runtime.json (hold flock for the entire read-modify-write)
update_runtime_json() {
  local field="$1" value="$2"
  (
    # Acquire lock non-blocking — skip if a lifecycle operation holds it
    if ! flock -n 9; then
      echo "[routine-watcher] Lifecycle lock held — skipping runtime.json write"
      exit 1
    fi
    python3 -c "
import json, sys, os, time
runtime_path = sys.argv[1]
tmp_path = sys.argv[2]
field, value = sys.argv[3], sys.argv[4]
try:
    with open(runtime_path) as f: data = json.load(f)
except: data = {}
data[field] = value
data['updated_at'] = time.strftime('%Y-%m-%dT%H:%M:%S%z')
with open(tmp_path, 'w') as f: json.dump(data, f, indent=2); f.write('\n')
os.rename(tmp_path, runtime_path)
" "$RUNTIME_JSON" "$STATE_DIR/.runtime.json.tmp" "$field" "$value" 2>/dev/null
  ) 9>"$LIFECYCLE_LOCK"
}

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
SUSPECT_COUNT=0
CACHED_HB_EVERY=""
CACHED_THRESHOLD_SECS=""

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

  STATUS=$(read_session_state)

  # --- P4: Liveness detection via .heartbeat mtime ---
  if [ "$STATUS" = "in_progress" ] || [ "$STATUS" = "suspect_process" ]; then
    # Check if lifecycle lock is held (active transition — back off)
    if flock -n "$LIFECYCLE_LOCK" true 2>/dev/null; then
      if [ -f "$HEARTBEAT_FILE" ]; then
        # Read stale threshold from config (cached — re-read only when config value changes)
        HB_EVERY=$(jq -r '.heartbeat.every // "2h"' "$CONFIG" 2>/dev/null)
        if [ "$HB_EVERY" != "$CACHED_HB_EVERY" ]; then
          CACHED_HB_EVERY="$HB_EVERY"
          CACHED_THRESHOLD_SECS=$(python3 -c "
import sys, re
d = sys.argv[1]
m = re.match(r'(\d+)([hm])', d)
if m:
    n, u = int(m.group(1)), m.group(2)
    print(n * 3600 * 2 if u == 'h' else n * 60 * 2)
else:
    print(14400)
" "$HB_EVERY" 2>/dev/null)
        fi
        THRESHOLD_SECS="$CACHED_THRESHOLD_SECS"

        HB_MTIME=$(stat -c %Y "$HEARTBEAT_FILE" 2>/dev/null || echo 0)
        NOW_EPOCH=$(date +%s)
        HB_AGE=$((NOW_EPOCH - HB_MTIME))

        if [ "$HB_AGE" -gt "${THRESHOLD_SECS:-14400}" ]; then
          SUSPECT_COUNT=$((SUSPECT_COUNT + 1))
          if [ "$SUSPECT_COUNT" -ge 3 ]; then
            echo "[routine-watcher] Claude process appears dead (heartbeat stale for ${HB_AGE}s, 3 consecutive checks)"
            update_runtime_json "session_state" "dead_process"
            update_runtime_json "last_error" "heartbeat_stale"
            SUSPECT_COUNT=0
          elif [ "$STATUS" != "suspect_process" ]; then
            echo "[routine-watcher] Claude process suspect (heartbeat stale for ${HB_AGE}s, check $SUSPECT_COUNT/3)"
            update_runtime_json "session_state" "suspect_process"
          fi
        else
          # Heartbeat is fresh — reset suspect counter
          if [ "$SUSPECT_COUNT" -gt 0 ]; then
            SUSPECT_COUNT=0
            if [ "$STATUS" = "suspect_process" ]; then
              update_runtime_json "session_state" "in_progress"
            fi
          fi
        fi
      fi
    else
      # Lock held — transition in progress, don't check liveness
      SUSPECT_COUNT=0
    fi
  else
    SUSPECT_COUNT=0
  fi

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
