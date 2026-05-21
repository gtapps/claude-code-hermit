#!/usr/bin/env bash
# Tests for PROP-040: automatic session close.
# Covers: heartbeat-precheck AUTO_CLOSE verdict, reflect-precheck closed_via filter,
# and weekly-review partition of auto-archived sessions.
# Usage: bash tests/test-auto-close.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/lib.sh"

echo "=== auto-close (PROP-040) ==="
echo ""

HEARTBEAT_PRECHECK="$REPO_ROOT/scripts/heartbeat-precheck.js"
REFLECT_PRECHECK="$REPO_ROOT/scripts/reflect-precheck.js"
WEEKLY_REVIEW="$REPO_ROOT/scripts/weekly-review.js"

# -------------------------------------------------------
# 1a. heartbeat-precheck: SHELL.md mtime > 12h → AUTO_CLOSE
# -------------------------------------------------------
workdir="$(mktemp -d)"
mkdir -p "$workdir/.claude-code-hermit/sessions"
mkdir -p "$workdir/.claude-code-hermit/state"
printf '# Heartbeat\n\n- [ ] Check system\n' > "$workdir/.claude-code-hermit/HEARTBEAT.md"
touch -d "13 hours ago" "$workdir/.claude-code-hermit/sessions/SHELL.md"
echo '{"session_state":"in_progress","session_id":"S-001"}' \
  > "$workdir/.claude-code-hermit/state/runtime.json"
echo '{"alerts":{},"last_digest_date":null,"self_eval":{},"total_ticks":0}' \
  > "$workdir/.claude-code-hermit/state/alert-state.json"
out="$(cd "$workdir" && node "$HEARTBEAT_PRECHECK" .claude-code-hermit)"
run_test "heartbeat-precheck: stale SHELL.md (13h) → AUTO_CLOSE" bash -c "[ '$out' = 'AUTO_CLOSE' ]"
cleanup

# -------------------------------------------------------
# 1b. heartbeat-precheck: fresh SHELL.md → EVALUATE (not AUTO_CLOSE)
# -------------------------------------------------------
workdir="$(mktemp -d)"
mkdir -p "$workdir/.claude-code-hermit/sessions"
mkdir -p "$workdir/.claude-code-hermit/state"
printf '# Heartbeat\n\n- [ ] Check system\n' > "$workdir/.claude-code-hermit/HEARTBEAT.md"
touch "$workdir/.claude-code-hermit/sessions/SHELL.md"
echo '{"session_state":"in_progress","session_id":"S-001"}' \
  > "$workdir/.claude-code-hermit/state/runtime.json"
echo '{"alerts":{},"last_digest_date":null,"self_eval":{},"total_ticks":0}' \
  > "$workdir/.claude-code-hermit/state/alert-state.json"
out="$(cd "$workdir" && node "$HEARTBEAT_PRECHECK" .claude-code-hermit)"
run_test "heartbeat-precheck: fresh SHELL.md → EVALUATE (not AUTO_CLOSE)" bash -c "[ '$out' = 'EVALUATE' ]"
cleanup

# -------------------------------------------------------
# 2. reflect-precheck: only auto-archived session report → EMPTY (not compute)
# -------------------------------------------------------
workdir="$(mktemp -d)"
mkdir -p "$workdir/.claude-code-hermit/sessions"
mkdir -p "$workdir/.claude-code-hermit/state"
mkdir -p "$workdir/.claude-code-hermit/proposals"
cp "$FIXTURES/shell-session.md" "$workdir/.claude-code-hermit/sessions/SHELL.md"
echo '{"timezone":"UTC"}' > "$workdir/.claude-code-hermit/config.json"
cat > "$workdir/.claude-code-hermit/sessions/S-001-REPORT.md" << 'EOF'
---
id: S-001
status: completed
date: 2026-01-15T10:00:00+00:00
duration: 1h
cost_usd: 0.00
tokens: 0
tags: []
proposals_created: []
task: "test"
escalation: balanced
operator_turns: 0
closed_via: auto
---
## Overview
Auto-closed after 12h quiet.
EOF
# reflection-state.json: old lastRunAt so the report mtime appears newer,
# old since so phase is 'adult' (prevents newborn/digest from firing).
cat > "$workdir/.claude-code-hermit/state/reflection-state.json" << 'EOF'
{"counters":{"last_run_at":"2020-01-01T00:00:00Z","since":"2020-01-01T00:00:00Z"}}
EOF
# session_state: idle so the in_progress short-circuit in reflect-precheck doesn't apply
echo '{"session_state":"idle"}' > "$workdir/.claude-code-hermit/state/runtime.json"
out="$(cd "$workdir" && node "$REFLECT_PRECHECK" .claude-code-hermit "$REPO_ROOT" 2>/dev/null)"
run_test "reflect-precheck: only auto-archived report → EMPTY (not compute)" \
  bash -c "[ '$out' = 'EMPTY' ]"
cleanup

# -------------------------------------------------------
# 3. weekly-review: auto-archived in cost total, excluded from autonomy denominator
# -------------------------------------------------------
workdir="$(mktemp -d)"
mkdir -p "$workdir/.claude-code-hermit/sessions"
mkdir -p "$workdir/.claude-code-hermit/state"
echo '{"timezone":"UTC"}' > "$workdir/.claude-code-hermit/config.json"

TODAY="$(date -u +%Y-%m-%dT12:00:00+00:00)"

cat > "$workdir/.claude-code-hermit/sessions/S-001-REPORT.md" << EOF
---
id: S-001
status: completed
date: ${TODAY}
duration: 2h
cost_usd: 1.50
tokens: 50000
tags: []
proposals_created: []
task: "real work"
escalation: balanced
operator_turns: 5
closed_via: operator
---
## Overview
Real work session.
EOF

cat > "$workdir/.claude-code-hermit/sessions/S-002-REPORT.md" << EOF
---
id: S-002
status: completed
date: ${TODAY}
duration: 1h
cost_usd: 0.80
tokens: 20000
tags: []
proposals_created: []
task: "work then quiet"
escalation: balanced
operator_turns: 3
closed_via: auto
---
## Overview
Auto-closed after 12h quiet.
EOF

cd "$workdir" && node "$WEEKLY_REVIEW" .claude-code-hermit /nonexistent 2>/dev/null
review_file="$(find "$workdir/.claude-code-hermit/compiled" -name 'review-weekly-*.md' | head -1)"
cd "$ORIG_DIR"

run_test "weekly-review: sessions_count: 2 (both included)" bash -c \
  "grep -q 'sessions_count: 2' '$review_file'"
run_test "weekly-review: total_cost_usd: 2.30 (both summed)" bash -c \
  "grep -q 'total_cost_usd: 2.30' '$review_file'"
run_test "weekly-review: body shows 2 sessions headline" bash -c \
  "grep -q '2 sessions' '$review_file'"
run_test "weekly-review: auto-archived excluded note appears" bash -c \
  "grep -q '1 auto-archived excluded' '$review_file'"
# S-001 has operator_turns=5 → not self-directed; S-002 excluded from denominator
# autonomousRate = 0/1 = 0.00
run_test "weekly-review: self_directed_rate: 0.00 (auto-archived excluded from denominator)" bash -c \
  "grep -q 'self_directed_rate: 0.00' '$review_file'"
cleanup

echo ""
echo "=== last-operator-action.json signal ==="
echo ""

RECORD_HOOK="$REPO_ROOT/scripts/record-operator-action.js"

# -------------------------------------------------------
# a. precheck: last-operator-action.json 13h ago + fresh SHELL.md mtime → AUTO_CLOSE
# -------------------------------------------------------
workdir="$(mktemp -d)"
mkdir -p "$workdir/.claude-code-hermit/sessions"
mkdir -p "$workdir/.claude-code-hermit/state"
printf '# Heartbeat\n\n- [ ] Check system\n' > "$workdir/.claude-code-hermit/HEARTBEAT.md"
touch "$workdir/.claude-code-hermit/sessions/SHELL.md"   # fresh mtime
echo '{"at":"2026-05-20T09:00:00+00:00"}' > "$workdir/.claude-code-hermit/state/last-operator-action.json"
echo '{"session_state":"in_progress","session_id":"S-001"}' > "$workdir/.claude-code-hermit/state/runtime.json"
echo '{"alerts":{},"last_digest_date":null,"self_eval":{},"total_ticks":0}' > "$workdir/.claude-code-hermit/state/alert-state.json"
out="$(cd "$workdir" && HERMIT_NOW="2026-05-20T22:00:00+00:00" node "$HEARTBEAT_PRECHECK" .claude-code-hermit)"
run_test "precheck: stale last-operator-action (13h) + fresh SHELL.md → AUTO_CLOSE" bash -c "[ '$out' = 'AUTO_CLOSE' ]"
cleanup

# -------------------------------------------------------
# b. precheck: last-operator-action.json 1h ago + stale SHELL.md (13h) → EVALUATE
# -------------------------------------------------------
workdir="$(mktemp -d)"
mkdir -p "$workdir/.claude-code-hermit/sessions"
mkdir -p "$workdir/.claude-code-hermit/state"
printf '# Heartbeat\n\n- [ ] Check system\n' > "$workdir/.claude-code-hermit/HEARTBEAT.md"
touch -d "13 hours ago" "$workdir/.claude-code-hermit/sessions/SHELL.md"
echo '{"at":"2026-05-20T21:00:00+00:00"}' > "$workdir/.claude-code-hermit/state/last-operator-action.json"
echo '{"session_state":"in_progress","session_id":"S-001"}' > "$workdir/.claude-code-hermit/state/runtime.json"
echo '{"alerts":{},"last_digest_date":null,"self_eval":{},"total_ticks":0}' > "$workdir/.claude-code-hermit/state/alert-state.json"
out="$(cd "$workdir" && HERMIT_NOW="2026-05-20T22:00:00+00:00" node "$HEARTBEAT_PRECHECK" .claude-code-hermit)"
run_test "precheck: fresh last-operator-action (1h) + stale SHELL.md (13h) → EVALUATE" bash -c "[ '$out' = 'EVALUATE' ]"
cleanup

# -------------------------------------------------------
# c. precheck: last-operator-action.json absent + stale SHELL.md → AUTO_CLOSE (mtime fallback)
# -------------------------------------------------------
workdir="$(mktemp -d)"
mkdir -p "$workdir/.claude-code-hermit/sessions"
mkdir -p "$workdir/.claude-code-hermit/state"
printf '# Heartbeat\n\n- [ ] Check system\n' > "$workdir/.claude-code-hermit/HEARTBEAT.md"
touch -d "13 hours ago" "$workdir/.claude-code-hermit/sessions/SHELL.md"
echo '{"session_state":"in_progress","session_id":"S-001"}' > "$workdir/.claude-code-hermit/state/runtime.json"
echo '{"alerts":{},"last_digest_date":null,"self_eval":{},"total_ticks":0}' > "$workdir/.claude-code-hermit/state/alert-state.json"
out="$(cd "$workdir" && node "$HEARTBEAT_PRECHECK" .claude-code-hermit)"
run_test "precheck: absent last-operator-action + stale SHELL.md → AUTO_CLOSE (mtime fallback)" bash -c "[ '$out' = 'AUTO_CLOSE' ]"
cleanup

# -------------------------------------------------------
# d. precheck: malformed last-operator-action.json cases → fall back to mtime, no crash
# -------------------------------------------------------
for bad_at in 'null' '123' '"not-a-date"'; do
  workdir="$(mktemp -d)"
  mkdir -p "$workdir/.claude-code-hermit/sessions"
  mkdir -p "$workdir/.claude-code-hermit/state"
  printf '# Heartbeat\n\n- [ ] Check system\n' > "$workdir/.claude-code-hermit/HEARTBEAT.md"
  touch -d "13 hours ago" "$workdir/.claude-code-hermit/sessions/SHELL.md"
  echo "{\"at\":${bad_at}}" > "$workdir/.claude-code-hermit/state/last-operator-action.json"
  echo '{"session_state":"in_progress","session_id":"S-001"}' > "$workdir/.claude-code-hermit/state/runtime.json"
  echo '{"alerts":{},"last_digest_date":null,"self_eval":{},"total_ticks":0}' > "$workdir/.claude-code-hermit/state/alert-state.json"
  out="$(cd "$workdir" && node "$HEARTBEAT_PRECHECK" .claude-code-hermit)"
  run_test "precheck: malformed at=${bad_at} → AUTO_CLOSE via mtime fallback, no crash" bash -c "[ '$out' = 'AUTO_CLOSE' ]"
  cleanup
done

# -------------------------------------------------------
# e. hook smoke: routine prompt → file NOT written
# -------------------------------------------------------
workdir="$(mktemp -d)"
mkdir -p "$workdir/.claude-code-hermit/state"
out="$(cd "$workdir" && echo '{"prompt":"[hermit-routine:reflect] Invoke /claude-code-hermit:reflect."}' | node "$RECORD_HOOK")"
run_test "hook smoke: [hermit-routine: prefix → file NOT written" bash -c "[ ! -f '$workdir/.claude-code-hermit/state/last-operator-action.json' ]"
cleanup

# -------------------------------------------------------
# f. hook smoke: plain operator prompt → file IS written
# -------------------------------------------------------
workdir="$(mktemp -d)"
mkdir -p "$workdir/.claude-code-hermit/state"
cd "$workdir" && echo '{"prompt":"hello"}' | node "$RECORD_HOOK"
run_test "hook smoke: plain operator prompt → file IS written" bash -c "[ -f '$workdir/.claude-code-hermit/state/last-operator-action.json' ]"
cd "$ORIG_DIR"
cleanup

# -------------------------------------------------------
# g. hook smoke: bare loop re-fire → file NOT written
# -------------------------------------------------------
workdir="$(mktemp -d)"
mkdir -p "$workdir/.claude-code-hermit/state"
out="$(cd "$workdir" && echo '{"prompt":"/claude-code-hermit:heartbeat run"}' | node "$RECORD_HOOK")"
run_test "hook smoke: bare /claude-code-hermit:heartbeat run → file NOT written" bash -c "[ ! -f '$workdir/.claude-code-hermit/state/last-operator-action.json' ]"
cleanup

# -------------------------------------------------------
# h. hook smoke: operator-typed /heartbeat run (with command-message wrapper) → file IS written
# -------------------------------------------------------
workdir="$(mktemp -d)"
mkdir -p "$workdir/.claude-code-hermit/state"
cd "$workdir"
printf '{"prompt":"<command-message>heartbeat run</command-message>\\n<command-name>/claude-code-hermit:heartbeat run</command-name>"}' | node "$RECORD_HOOK"
run_test "hook smoke: operator-typed /heartbeat run (command-message wrapper) → file IS written" bash -c "[ -f '$workdir/.claude-code-hermit/state/last-operator-action.json' ]"
cd "$ORIG_DIR"
cleanup

# -------------------------------------------------------
# i. hook smoke: channel inbound prompt → file NOT written (channel-responder handles post-auth)
# -------------------------------------------------------
workdir="$(mktemp -d)"
mkdir -p "$workdir/.claude-code-hermit/state"
out="$(cd "$workdir" && echo '{"prompt":"<channel source=discord chat_id=x>hi</channel>"}' | node "$RECORD_HOOK")"
run_test "hook smoke: <channel inbound → file NOT written by hook" bash -c "[ ! -f '$workdir/.claude-code-hermit/state/last-operator-action.json' ]"
cleanup

# -------------------------------------------------------
# j. hook smoke: bare /loop re-fire of /pulse → file NOT written
# -------------------------------------------------------
workdir="$(mktemp -d)"
mkdir -p "$workdir/.claude-code-hermit/state"
out="$(cd "$workdir" && echo '{"prompt":"/claude-code-hermit:pulse"}' | node "$RECORD_HOOK")"
run_test "hook smoke: bare /claude-code-hermit:pulse (loop re-fire) → file NOT written" bash -c "[ ! -f '$workdir/.claude-code-hermit/state/last-operator-action.json' ]"
cleanup

# -------------------------------------------------------
# k. hook smoke: operator-typed /pulse (command-message wrapper) → file IS written
# -------------------------------------------------------
workdir="$(mktemp -d)"
mkdir -p "$workdir/.claude-code-hermit/state"
cd "$workdir"
printf '{"prompt":"<command-message>claude-code-hermit:pulse</command-message>\\n<command-name>/claude-code-hermit:pulse</command-name>"}' | node "$RECORD_HOOK"
run_test "hook smoke: operator-typed /pulse (command-message wrapper) → file IS written" bash -c "[ -f '$workdir/.claude-code-hermit/state/last-operator-action.json' ]"
cd "$ORIG_DIR"
cleanup

# -------------------------------------------------------
# l. hook smoke: bare arbitrary slash command (any future loop re-fire) → file NOT written
# -------------------------------------------------------
workdir="$(mktemp -d)"
mkdir -p "$workdir/.claude-code-hermit/state"
out="$(cd "$workdir" && echo '{"prompt":"/some-future-plugin:some-cmd --flag"}' | node "$RECORD_HOOK")"
run_test "hook smoke: bare /some-future-plugin:some-cmd → file NOT written" bash -c "[ ! -f '$workdir/.claude-code-hermit/state/last-operator-action.json' ]"
cleanup

# -------------------------------------------------------
# m. SessionStart (no payload) + absent file → file IS written (cold-start seed)
# -------------------------------------------------------
workdir="$(mktemp -d)"
mkdir -p "$workdir/.claude-code-hermit/state"
cd "$workdir" && : | node "$RECORD_HOOK"
run_test "SessionStart with absent state file → file IS written (cold-start seed)" bash -c "[ -f '$workdir/.claude-code-hermit/state/last-operator-action.json' ]"
cd "$ORIG_DIR"
cleanup

# -------------------------------------------------------
# n. SessionStart (no payload) + existing file → timestamp preserved (no mask on restart)
# -------------------------------------------------------
workdir="$(mktemp -d)"
mkdir -p "$workdir/.claude-code-hermit/state"
echo '{"at":"2026-05-20T09:00:00.000Z"}' > "$workdir/.claude-code-hermit/state/last-operator-action.json"
cd "$workdir" && : | node "$RECORD_HOOK"
run_test "SessionStart with existing state file → timestamp preserved (restart doesn't reset clock)" bash -c "grep -q '2026-05-20T09:00:00' '$workdir/.claude-code-hermit/state/last-operator-action.json'"
cd "$ORIG_DIR"
cleanup

# -------------------------------------------------------
# o. --force invocation (channel-responder post-auth path) → file IS written
# -------------------------------------------------------
workdir="$(mktemp -d)"
mkdir -p "$workdir/.claude-code-hermit/state"
cd "$workdir" && node "$RECORD_HOOK" --force
run_test "--force → file IS written (channel-responder post-auth)" bash -c "[ -f '$workdir/.claude-code-hermit/state/last-operator-action.json' ]"
cd "$ORIG_DIR"
cleanup

# -------------------------------------------------------
# p. --force overwrites existing file (channel inbound = fresh operator activity)
# -------------------------------------------------------
workdir="$(mktemp -d)"
mkdir -p "$workdir/.claude-code-hermit/state"
echo '{"at":"2026-05-20T09:00:00.000Z"}' > "$workdir/.claude-code-hermit/state/last-operator-action.json"
cd "$workdir" && node "$RECORD_HOOK" --force
run_test "--force overwrites existing file (channel inbound bumps clock)" bash -c "! grep -q '2026-05-20T09:00:00' '$workdir/.claude-code-hermit/state/last-operator-action.json'"
cd "$ORIG_DIR"
cleanup

print_results
