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
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Validate python3 availability once at startup
PYTHON3="$(command -v python3 2>/dev/null || true)"
if [ -z "$PYTHON3" ]; then
  echo "[routine-watcher] FATAL: python3 not found in PATH — routines cannot run" >&2
  echo "[routine-watcher] Install Python 3 or ensure python3 is on PATH" >&2
  exit 1
fi
if [ ! -f "$SCRIPT_DIR/cron-match.py" ]; then
  echo "[routine-watcher] FATAL: $SCRIPT_DIR/cron-match.py not found" >&2
  exit 1
fi

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
    "$PYTHON3" -c "
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

# Append a routine to the queue file (idempotent per routine per scheduled slot)
queue_routine() {
  "$PYTHON3" -c "
import json, sys, datetime
f, rid, skill, slot = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
try: q = json.load(open(f))
except: q = {'queued': []}
if not any(e['id'] == rid and e.get('scheduled_slot', e.get('queued_date')) == slot for e in q['queued']):
    q['queued'].append({
        'id': rid, 'scheduled_slot': slot,
        'queued_since': datetime.datetime.now().isoformat(),
        'skill': skill
    })
    json.dump(q, open(f, 'w'))
" "$QUEUE_FILE" "$1" "$2" "$3" 2>/dev/null
}

# Reset ephemeral state on start
> "$STATE"

# Drain stale queue entries from previous runs (older than 2h = one heartbeat cycle)
if [ -f "$QUEUE_FILE" ]; then
  "$PYTHON3" -c "
import json, sys, datetime
f = sys.argv[1]
try: q = json.load(open(f))
except: sys.exit(0)
now = datetime.datetime.now()
fresh = []
for item in q.get('queued', []):
    try:
        qs = datetime.datetime.fromisoformat(item['queued_since'])
        if (now - qs).total_seconds() < 7200:
            fresh.append(item)
    except:
        fresh.append(item)  # keep items we can't parse rather than silently dropping them
if len(fresh) != len(q.get('queued', [])):
    json.dump({'queued': fresh}, open(f, 'w'))
" "$QUEUE_FILE" 2>/dev/null
fi

LAST_DATE=""
SUSPECT_COUNT=0
CACHED_HB_EVERY=""
CACHED_THRESHOLD_SECS=""

while true; do
  export TZ=$(jq -r '.timezone // "UTC"' "$CONFIG" 2>/dev/null)
  NOW_TS=$(date +%Y-%m-%dT%H:%M)
  NOW_DOW=$(date +%w)
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
          CACHED_THRESHOLD_SECS=$("$PYTHON3" -c "
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

        HB_MTIME=$("$PYTHON3" -c "import os,sys; print(int(os.path.getmtime(sys.argv[1])))" "$HEARTBEAT_FILE" 2>/dev/null || echo 0)
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
      "$PYTHON3" -c "
import json, sys, subprocess
f, target, state = sys.argv[1], sys.argv[2], sys.argv[3]
config_path = sys.argv[4]
status = sys.argv[5]
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
    # Use the original scheduled slot for dedup — not the current time.
    # This prevents a replayed backlog item from suppressing genuine cron hits
    # at the current minute.
    slot = item.get('scheduled_slot') or item.get('queued_date')
    fired_key = slot + '|' + item['id']
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
" "$QUEUE_FILE" "$TARGET" "$STATE" "$CONFIG" "$STATUS" 2>/dev/null
    fi
  fi

  # --- Schedule: check cron-matched routines ---
  jq -r '
    .routines[]? | select(.enabled==true) |
    .id + "\t" + .skill + "\t" + .schedule + "\t" + (if .run_during_waiting then "true" else "false" end)
  ' "$CONFIG" 2>/dev/null | while IFS=$'\t' read -r rid skill schedule rdw; do
    # Match schedule via cron-match.py
    # Exit codes: 0=match, 1=no-match, 2=parse error, 126/127=interpreter failure
    match_result=0
    match_stderr=$("$PYTHON3" "$SCRIPT_DIR/cron-match.py" "$schedule" "$NOW_TS" "$NOW_DOW" 2>&1) || match_result=$?
    if [ "$match_result" -eq 2 ]; then
      echo "[routine-watcher] Invalid schedule for routine '$rid': $schedule — skipping"
      continue
    fi
    if [ "$match_result" -ge 126 ]; then
      echo "[routine-watcher] ERROR: cron-match.py failed to execute (exit $match_result): $match_stderr" >&2
      continue
    fi
    if [ "$match_result" -ne 0 ]; then
      continue
    fi

    FIRED_KEY="${NOW_TS}|${rid}"
    # Dedup: once per routine per time slot
    if grep -qF "$FIRED_KEY" "$STATE" 2>/dev/null; then
      continue
    fi

    if [ "$STATUS" = "in_progress" ]; then
      queue_routine "$rid" "$skill" "$NOW_TS"
      continue
    elif [ "$STATUS" = "waiting" ]; then
      if [ "$rdw" != "true" ]; then
        queue_routine "$rid" "$skill" "$NOW_TS"
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
