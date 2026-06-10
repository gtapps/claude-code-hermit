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
# 2. reflect-precheck: auto-archived session report DOES trigger compute phase
# (the prior closed_via: auto skip was removed so daily-midnight archives reach reflect)
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
operator_turns: 3
closed_via: auto
---
## Overview
Auto-closed by heartbeat.
EOF
# reflection-state.json: old lastRunAt so the report mtime appears newer,
# old since so phase is 'adult' (prevents newborn/digest from firing).
cat > "$workdir/.claude-code-hermit/state/reflection-state.json" << 'EOF'
{"counters":{"last_run_at":"2020-01-01T00:00:00Z","since":"2020-01-01T00:00:00Z"}}
EOF
# session_state: idle so the in_progress short-circuit in reflect-precheck doesn't apply
echo '{"session_state":"idle"}' > "$workdir/.claude-code-hermit/state/runtime.json"
out="$(cd "$workdir" && node "$REFLECT_PRECHECK" .claude-code-hermit "$REPO_ROOT" 2>/dev/null)"
run_test "reflect-precheck: auto-archived report newer than last_reflection → triggers compute phase (skip removed)" \
  bash -c "[ '$out' != 'EMPTY' ]"
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
run_test "weekly-review: auto-archived excluded note GONE (filter removed)" bash -c \
  "! grep -q 'auto-archived excluded' '$review_file'"
# Both sessions have operator_turns > 0 → neither self-directed.
# Denominator is now all sessions (no auto exclusion). autonomousRate = 0/2 = 0.00.
run_test "weekly-review: self_directed_rate: 0.00 (both in denominator, neither self-directed)" bash -c \
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

echo ""
echo "=== daily-auto-close lull + pending-close drain ==="
echo ""

# Reusable fixture for the drain cases: HEARTBEAT.md with one item + alert-state.json scaffold.
hb_setup() {
  local dir="$1"
  mkdir -p "$dir/.claude-code-hermit/sessions"
  mkdir -p "$dir/.claude-code-hermit/state"
  printf '# Heartbeat\n\n- [ ] Check system\n' > "$dir/.claude-code-hermit/HEARTBEAT.md"
  touch "$dir/.claude-code-hermit/sessions/SHELL.md"
  echo '{"alerts":{},"last_digest_date":null,"self_eval":{},"total_ticks":0}' \
    > "$dir/.claude-code-hermit/state/alert-state.json"
}

# -------------------------------------------------------
# drain.1. pending-close.json + last_op > 10min + in_progress → AUTO_CLOSE
# -------------------------------------------------------
workdir="$(mktemp -d)"
hb_setup "$workdir"
echo '{"queued_at":"2026-05-20T22:00:00+00:00","queued_by":"daily-auto-close"}' \
  > "$workdir/.claude-code-hermit/state/pending-close.json"
echo '{"at":"2026-05-20T22:30:00+00:00"}' > "$workdir/.claude-code-hermit/state/last-operator-action.json"
echo '{"session_state":"in_progress","session_id":"S-001"}' > "$workdir/.claude-code-hermit/state/runtime.json"
out="$(cd "$workdir" && HERMIT_NOW="2026-05-20T22:45:00+00:00" node "$HEARTBEAT_PRECHECK" .claude-code-hermit)"
run_test "drain: pending-close + last_op > 10min + in_progress → AUTO_CLOSE" bash -c "[ '$out' = 'AUTO_CLOSE' ]"
cleanup

# -------------------------------------------------------
# drain.2. pending-close.json + last_op < 10min + in_progress → not AUTO_CLOSE
# -------------------------------------------------------
workdir="$(mktemp -d)"
hb_setup "$workdir"
echo '{"queued_at":"2026-05-20T22:00:00+00:00","queued_by":"daily-auto-close"}' \
  > "$workdir/.claude-code-hermit/state/pending-close.json"
echo '{"at":"2026-05-20T22:40:00+00:00"}' > "$workdir/.claude-code-hermit/state/last-operator-action.json"
echo '{"session_state":"in_progress","session_id":"S-001"}' > "$workdir/.claude-code-hermit/state/runtime.json"
out="$(cd "$workdir" && HERMIT_NOW="2026-05-20T22:45:00+00:00" node "$HEARTBEAT_PRECHECK" .claude-code-hermit)"
run_test "drain: pending-close + last_op < 10min + in_progress → does NOT emit AUTO_CLOSE" bash -c "[ '$out' != 'AUTO_CLOSE' ]"
cleanup

# -------------------------------------------------------
# drain.3. pending-close.json + session_state == idle + lull > 10min → AUTO_CLOSE
# (idle sessions now participate in the midnight close — always-on deployments
#  where work happens via channels/routines without a formal task get daily archival)
# -------------------------------------------------------
workdir="$(mktemp -d)"
hb_setup "$workdir"
echo '{"queued_at":"2026-05-20T22:00:00+00:00","queued_by":"daily-auto-close"}' \
  > "$workdir/.claude-code-hermit/state/pending-close.json"
echo '{"at":"2026-05-20T22:30:00+00:00"}' > "$workdir/.claude-code-hermit/state/last-operator-action.json"
echo '{"session_state":"idle"}' > "$workdir/.claude-code-hermit/state/runtime.json"
out="$(cd "$workdir" && HERMIT_NOW="2026-05-20T22:45:00+00:00" node "$HEARTBEAT_PRECHECK" .claude-code-hermit)"
run_test "drain: pending-close + idle + lull > 10min → AUTO_CLOSE" bash -c "[ '$out' = 'AUTO_CLOSE' ]"
cleanup

# -------------------------------------------------------
# drain.3b. pending-close.json + session_state == idle + last_op < 10min → not AUTO_CLOSE
# (operator is between tasks but recently active — respect the lull threshold)
# -------------------------------------------------------
workdir="$(mktemp -d)"
hb_setup "$workdir"
echo '{"queued_at":"2026-05-20T22:00:00+00:00","queued_by":"daily-auto-close"}' \
  > "$workdir/.claude-code-hermit/state/pending-close.json"
echo '{"at":"2026-05-20T22:40:00+00:00"}' > "$workdir/.claude-code-hermit/state/last-operator-action.json"
echo '{"session_state":"idle"}' > "$workdir/.claude-code-hermit/state/runtime.json"
out="$(cd "$workdir" && HERMIT_NOW="2026-05-20T22:45:00+00:00" node "$HEARTBEAT_PRECHECK" .claude-code-hermit)"
run_test "drain: pending-close + idle + last_op < 10min → does NOT emit AUTO_CLOSE" bash -c "[ '$out' != 'AUTO_CLOSE' ]"
cleanup

# -------------------------------------------------------
# drain.4. drain bypasses active-hours skip (load-bearing invariant)
# -------------------------------------------------------
workdir="$(mktemp -d)"
hb_setup "$workdir"
echo '{"queued_at":"2026-05-20T22:00:00+00:00","queued_by":"daily-auto-close","heartbeat":{"active_hours":{"start":"08:00","end":"23:00"}}}' \
  > "$workdir/.claude-code-hermit/state/pending-close.json"
# config has active_hours that EXCLUDE 03:00 (we'll send HERMIT_NOW at 03:00)
echo '{"timezone":"UTC","heartbeat":{"active_hours":{"start":"08:00","end":"23:00"}}}' > "$workdir/.claude-code-hermit/config.json"
echo '{"at":"2026-05-21T02:30:00+00:00"}' > "$workdir/.claude-code-hermit/state/last-operator-action.json"
echo '{"session_state":"in_progress","session_id":"S-001"}' > "$workdir/.claude-code-hermit/state/runtime.json"
out="$(cd "$workdir" && HERMIT_NOW="2026-05-21T03:00:00+00:00" node "$HEARTBEAT_PRECHECK" .claude-code-hermit)"
run_test "drain: outside active hours + pending-close + lull → AUTO_CLOSE (bypasses active-hours skip)" bash -c "[ '$out' = 'AUTO_CLOSE' ]"
cleanup

# -------------------------------------------------------
# drain.5. pending-close.json absent → existing 12h fallback path unchanged
# -------------------------------------------------------
workdir="$(mktemp -d)"
hb_setup "$workdir"
echo '{"at":"2026-05-20T09:00:00+00:00"}' > "$workdir/.claude-code-hermit/state/last-operator-action.json"
echo '{"session_state":"in_progress","session_id":"S-001"}' > "$workdir/.claude-code-hermit/state/runtime.json"
out="$(cd "$workdir" && HERMIT_NOW="2026-05-20T22:00:00+00:00" node "$HEARTBEAT_PRECHECK" .claude-code-hermit)"
run_test "drain: no pending flag + last_op 13h ago → AUTO_CLOSE via existing 12h fallback (regression guard)" bash -c "[ '$out' = 'AUTO_CLOSE' ]"
cleanup

# -------------------------------------------------------
# drain.6. malformed pending-close.json → no drain, no crash, falls through
# -------------------------------------------------------
workdir="$(mktemp -d)"
hb_setup "$workdir"
printf '{not valid' > "$workdir/.claude-code-hermit/state/pending-close.json"
echo '{"at":"2026-05-20T22:30:00+00:00"}' > "$workdir/.claude-code-hermit/state/last-operator-action.json"
echo '{"session_state":"in_progress","session_id":"S-001"}' > "$workdir/.claude-code-hermit/state/runtime.json"
out="$(cd "$workdir" && HERMIT_NOW="2026-05-20T22:45:00+00:00" node "$HEARTBEAT_PRECHECK" .claude-code-hermit)"
run_test "drain: malformed pending-close.json → no drain, no crash, falls through" bash -c "[ '$out' != 'AUTO_CLOSE' ]"
cleanup

# -------------------------------------------------------
# drain.7. hook smoke: [hermit-routine:daily-auto-close ...] → file NOT written
# (proves the routine fire doesn't poison the very clock it reads)
# -------------------------------------------------------
workdir="$(mktemp -d)"
mkdir -p "$workdir/.claude-code-hermit/state"
out="$(cd "$workdir" && echo '{"prompt":"[hermit-routine:daily-auto-close] Invoke /claude-code-hermit:daily-auto-close."}' | node "$RECORD_HOOK")"
run_test "hook smoke: [hermit-routine:daily-auto-close prefix → file NOT written" bash -c "[ ! -f '$workdir/.claude-code-hermit/state/last-operator-action.json' ]"
cleanup

# -------------------------------------------------------
# drain.8. pending-close.json + in_progress + last-operator-action.json ABSENT → AUTO_CLOSE
# (per daily-auto-close SKILL.md step 5: absent clock = idle indefinitely = fail-open close)
# -------------------------------------------------------
workdir="$(mktemp -d)"
hb_setup "$workdir"
echo '{"queued_at":"2026-05-20T22:00:00+00:00","queued_by":"daily-auto-close"}' \
  > "$workdir/.claude-code-hermit/state/pending-close.json"
# NO last-operator-action.json written — fresh install scenario.
echo '{"session_state":"in_progress","session_id":"S-001"}' > "$workdir/.claude-code-hermit/state/runtime.json"
out="$(cd "$workdir" && HERMIT_NOW="2026-05-20T22:45:00+00:00" node "$HEARTBEAT_PRECHECK" .claude-code-hermit)"
run_test "drain: pending-close + in_progress + absent last-op → AUTO_CLOSE (fail-open)" bash -c "[ '$out' = 'AUTO_CLOSE' ]"
cleanup

# -------------------------------------------------------
# drain.9. pending-close.json + in_progress + last-operator-action.json malformed → AUTO_CLOSE
# (malformed at-field treated the same as absent — fail-open)
# -------------------------------------------------------
workdir="$(mktemp -d)"
hb_setup "$workdir"
echo '{"queued_at":"2026-05-20T22:00:00+00:00","queued_by":"daily-auto-close"}' \
  > "$workdir/.claude-code-hermit/state/pending-close.json"
echo '{"at":"not-a-date"}' > "$workdir/.claude-code-hermit/state/last-operator-action.json"
echo '{"session_state":"in_progress","session_id":"S-001"}' > "$workdir/.claude-code-hermit/state/runtime.json"
out="$(cd "$workdir" && HERMIT_NOW="2026-05-20T22:45:00+00:00" node "$HEARTBEAT_PRECHECK" .claude-code-hermit)"
run_test "drain: pending-close + in_progress + malformed last-op → AUTO_CLOSE (fail-open)" bash -c "[ '$out' = 'AUTO_CLOSE' ]"
cleanup

# -------------------------------------------------------
# drain.10. HEARTBEAT.md missing + pending-close + lull → AUTO_CLOSE
# (drain runs before the HEARTBEAT.md SKIP gate — the close is the signal,
#  not a notification, and must not depend on operator-editable HEARTBEAT.md)
# -------------------------------------------------------
workdir="$(mktemp -d)"
mkdir -p "$workdir/.claude-code-hermit/sessions"
mkdir -p "$workdir/.claude-code-hermit/state"
# Deliberately NO HEARTBEAT.md
touch "$workdir/.claude-code-hermit/sessions/SHELL.md"
echo '{"alerts":{},"last_digest_date":null,"self_eval":{},"total_ticks":0}' \
  > "$workdir/.claude-code-hermit/state/alert-state.json"
echo '{"queued_at":"2026-05-20T22:00:00+00:00","queued_by":"daily-auto-close"}' \
  > "$workdir/.claude-code-hermit/state/pending-close.json"
echo '{"at":"2026-05-20T22:30:00+00:00"}' > "$workdir/.claude-code-hermit/state/last-operator-action.json"
echo '{"session_state":"in_progress","session_id":"S-001"}' > "$workdir/.claude-code-hermit/state/runtime.json"
out="$(cd "$workdir" && HERMIT_NOW="2026-05-20T22:45:00+00:00" node "$HEARTBEAT_PRECHECK" .claude-code-hermit)"
run_test "drain: HEARTBEAT.md missing + pending-close + lull → AUTO_CLOSE (drain bypasses SKIP gate)" bash -c "[ '$out' = 'AUTO_CLOSE' ]"
cleanup

# -------------------------------------------------------
# drain.11. HEARTBEAT.md empty + pending-close + lull → AUTO_CLOSE
# (drain runs before the empty-checklist SKIP gate too)
# -------------------------------------------------------
workdir="$(mktemp -d)"
hb_setup "$workdir"
# Overwrite HEARTBEAT.md with no checklist items
printf '# Heartbeat\n\nNo items today.\n' > "$workdir/.claude-code-hermit/HEARTBEAT.md"
echo '{"queued_at":"2026-05-20T22:00:00+00:00","queued_by":"daily-auto-close"}' \
  > "$workdir/.claude-code-hermit/state/pending-close.json"
echo '{"at":"2026-05-20T22:30:00+00:00"}' > "$workdir/.claude-code-hermit/state/last-operator-action.json"
echo '{"session_state":"in_progress","session_id":"S-001"}' > "$workdir/.claude-code-hermit/state/runtime.json"
out="$(cd "$workdir" && HERMIT_NOW="2026-05-20T22:45:00+00:00" node "$HEARTBEAT_PRECHECK" .claude-code-hermit)"
run_test "drain: HEARTBEAT.md no-checklist + pending-close + lull → AUTO_CLOSE (drain bypasses SKIP gate)" bash -c "[ '$out' = 'AUTO_CLOSE' ]"
cleanup

# -------------------------------------------------------
# drain.12. stale queued_at (>24h) + absent last-op + in_progress → NO AUTO_CLOSE
# (defends fresh sessions against premature close when a leftover flag from a
#  crashed prior session coincides with a missing last-op clock)
# -------------------------------------------------------
workdir="$(mktemp -d)"
hb_setup "$workdir"
echo '{"queued_at":"2026-05-19T00:00:00+00:00","queued_by":"daily-auto-close"}' \
  > "$workdir/.claude-code-hermit/state/pending-close.json"
# NO last-operator-action.json — fresh-session scenario after prior crash
echo '{"session_state":"in_progress","session_id":"S-002"}' > "$workdir/.claude-code-hermit/state/runtime.json"
# HERMIT_NOW is 2026-05-21 → queued_at is 48h+ old → stale flag
out="$(cd "$workdir" && HERMIT_NOW="2026-05-21T01:00:00+00:00" node "$HEARTBEAT_PRECHECK" .claude-code-hermit)"
run_test "drain: stale queued_at (>24h) + absent last-op → NO AUTO_CLOSE (stale-flag guard)" bash -c "[ '$out' != 'AUTO_CLOSE' ]"
cleanup

# -------------------------------------------------------
# drain.13. pending-close.json missing queued_at + absent last-op → NO AUTO_CLOSE
# (defensive: if queued_at can't be parsed we can't tell the flag's age, so
#  don't fail-open close — wait for either a valid last-op or the next routine fire)
# -------------------------------------------------------
workdir="$(mktemp -d)"
hb_setup "$workdir"
echo '{"queued_by":"daily-auto-close"}' \
  > "$workdir/.claude-code-hermit/state/pending-close.json"
# NO last-operator-action.json
echo '{"session_state":"in_progress","session_id":"S-003"}' > "$workdir/.claude-code-hermit/state/runtime.json"
out="$(cd "$workdir" && HERMIT_NOW="2026-05-21T01:00:00+00:00" node "$HEARTBEAT_PRECHECK" .claude-code-hermit)"
run_test "drain: pending-close missing queued_at + absent last-op → NO AUTO_CLOSE (defensive)" bash -c "[ '$out' != 'AUTO_CLOSE' ]"
cleanup

# -------------------------------------------------------
# drain.14. stale queued_at + VALID old last-op (>10min) → AUTO_CLOSE
# (a stale flag is still actionable when last-op proves a real lull; the staleness
#  guard only suppresses the fail-open path, not the standard lull-check path)
# -------------------------------------------------------
workdir="$(mktemp -d)"
hb_setup "$workdir"
echo '{"queued_at":"2026-05-19T00:00:00+00:00","queued_by":"daily-auto-close"}' \
  > "$workdir/.claude-code-hermit/state/pending-close.json"
echo '{"at":"2026-05-21T00:30:00+00:00"}' > "$workdir/.claude-code-hermit/state/last-operator-action.json"
echo '{"session_state":"in_progress","session_id":"S-004"}' > "$workdir/.claude-code-hermit/state/runtime.json"
out="$(cd "$workdir" && HERMIT_NOW="2026-05-21T01:00:00+00:00" node "$HEARTBEAT_PRECHECK" .claude-code-hermit)"
run_test "drain: stale queued_at + valid >10min last-op → AUTO_CLOSE (lull-check path unaffected by guard)" bash -c "[ '$out' = 'AUTO_CLOSE' ]"
cleanup

echo ""
echo "=== empty-12h-archive exclusion in weekly-review / reflect-precheck ==="
echo ""

# -------------------------------------------------------
# exclude.1. weekly-review: closed_via:auto + operator_turns:0 EXCLUDED from autonomy denominator
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
duration: 12h
cost_usd: 0.00
tokens: 0
tags: []
proposals_created: []
task: ""
escalation: balanced
operator_turns: 0
closed_via: auto
---
## Overview
Auto-closed by heartbeat.
EOF
cd "$workdir" && node "$WEEKLY_REVIEW" .claude-code-hermit /nonexistent 2>/dev/null
review_file="$(find "$workdir/.claude-code-hermit/compiled" -name 'review-weekly-*.md' | head -1)"
cd "$ORIG_DIR"
# Both sessions count in sessions_count and total_cost (raw aggregates).
run_test "weekly-review: sessions_count: 2 (raw count includes empty 12h archive)" bash -c \
  "grep -q 'sessions_count: 2' '$review_file'"
# S-002 (empty 12h auto) excluded from autonomy calc. Denominator = 1 (S-001 only).
# S-001 has operator_turns=5 → not self-directed → numerator=0. autonomousRate = 0/1 = 0.00.
run_test "weekly-review: self_directed_rate: 0.00 (S-001 in denominator, S-002 empty-12h excluded)" bash -c \
  "grep -q 'self_directed_rate: 0.00' '$review_file'"
# Header text: 1 operator-assisted (S-001 with operator_turns=5), 0 self-directed.
run_test "weekly-review: '0 self-directed' (empty 12h archive NOT counted as self-directed)" bash -c \
  "grep -q '0 self-directed' '$review_file'"
cleanup

# -------------------------------------------------------
# exclude.2. reflect-precheck: closed_via:auto + operator_turns:0 does NOT trigger compute phase
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
duration: 12h
cost_usd: 0.00
tokens: 0
tags: []
proposals_created: []
task: ""
escalation: balanced
operator_turns: 0
closed_via: auto
---
## Overview
Auto-closed by heartbeat.
EOF
cat > "$workdir/.claude-code-hermit/state/reflection-state.json" << 'EOF'
{"counters":{"last_run_at":"2020-01-01T00:00:00Z","since":"2020-01-01T00:00:00Z"}}
EOF
echo '{"session_state":"idle"}' > "$workdir/.claude-code-hermit/state/runtime.json"
out="$(cd "$workdir" && node "$REFLECT_PRECHECK" .claude-code-hermit "$REPO_ROOT" 2>/dev/null)"
run_test "reflect-precheck: only empty 12h archive (operator_turns:0, closed_via:auto) → EMPTY (skipped)" \
  bash -c "[ '$out' = 'EMPTY' ]"
cleanup

echo ""
echo "=== stale-session gate: skip LLM wake when operator is present ==="
echo ""

# Shared setup: HEARTBEAT.md with one suppressed item (all OK for checklist gate),
# last_digest_date = today so the digest gate doesn't fire, total_ticks = 1.
TODAY_DATE="$(date -u +%Y-%m-%d)"
SUPPRESSED_ALERT_STATE="{\"alerts\":{\"checklist:checksys\":{\"count\":6,\"consecutive_clean\":0,\"suppressed\":true,\"first_seen\":\"${TODAY_DATE}\",\"last_seen\":\"${TODAY_DATE}\",\"text\":\"Check system\"}},\"last_digest_date\":\"${TODAY_DATE}\",\"self_eval\":{},\"total_ticks\":1}"

# -------------------------------------------------------
# stale.1. in_progress + operator within stale_threshold + all items suppressed + digest ran → OK
# -------------------------------------------------------
workdir="$(mktemp -d)"
mkdir -p "$workdir/.claude-code-hermit/sessions"
mkdir -p "$workdir/.claude-code-hermit/state"
printf '# Heartbeat\n\n- Check system\n' > "$workdir/.claude-code-hermit/HEARTBEAT.md"
touch "$workdir/.claude-code-hermit/sessions/SHELL.md"
echo '{"session_state":"in_progress","session_id":"S-001"}' > "$workdir/.claude-code-hermit/state/runtime.json"
echo '{"at":"2026-05-20T21:30:00+00:00"}' > "$workdir/.claude-code-hermit/state/last-operator-action.json"
echo "$SUPPRESSED_ALERT_STATE" > "$workdir/.claude-code-hermit/state/alert-state.json"
out="$(cd "$workdir" && HERMIT_NOW="2026-05-20T22:00:00+00:00" node "$HEARTBEAT_PRECHECK" --peek .claude-code-hermit)"
run_test "stale-gate: in_progress + operator 30min ago + suppressed checklist + digest done → OK" bash -c "[ '$out' = 'OK' ]"
cleanup

# -------------------------------------------------------
# stale.2. in_progress + operator quiet beyond stale_threshold → EVALUATE (unchanged)
# -------------------------------------------------------
workdir="$(mktemp -d)"
mkdir -p "$workdir/.claude-code-hermit/sessions"
mkdir -p "$workdir/.claude-code-hermit/state"
printf '# Heartbeat\n\n- Check system\n' > "$workdir/.claude-code-hermit/HEARTBEAT.md"
touch "$workdir/.claude-code-hermit/sessions/SHELL.md"
echo '{"session_state":"in_progress","session_id":"S-001"}' > "$workdir/.claude-code-hermit/state/runtime.json"
echo '{"at":"2026-05-20T19:00:00+00:00"}' > "$workdir/.claude-code-hermit/state/last-operator-action.json"
echo "$SUPPRESSED_ALERT_STATE" > "$workdir/.claude-code-hermit/state/alert-state.json"
out="$(cd "$workdir" && HERMIT_NOW="2026-05-20T22:00:00+00:00" node "$HEARTBEAT_PRECHECK" --peek .claude-code-hermit)"
run_test "stale-gate: in_progress + operator 3h ago (> 2h threshold) → EVALUATE" bash -c "[ '$out' = 'EVALUATE' ]"
cleanup

# -------------------------------------------------------
# stale.3. in_progress + operator recent + stale-session alert active → EVALUATE (resolution tracking)
# -------------------------------------------------------
workdir="$(mktemp -d)"
mkdir -p "$workdir/.claude-code-hermit/sessions"
mkdir -p "$workdir/.claude-code-hermit/state"
printf '# Heartbeat\n\n- Check system\n' > "$workdir/.claude-code-hermit/HEARTBEAT.md"
touch "$workdir/.claude-code-hermit/sessions/SHELL.md"
echo '{"session_state":"in_progress","session_id":"S-001"}' > "$workdir/.claude-code-hermit/state/runtime.json"
echo '{"at":"2026-05-20T21:30:00+00:00"}' > "$workdir/.claude-code-hermit/state/last-operator-action.json"
STALE_ACTIVE="{\"alerts\":{\"checklist:checksys\":{\"count\":6,\"consecutive_clean\":0,\"suppressed\":true,\"first_seen\":\"${TODAY_DATE}\",\"last_seen\":\"${TODAY_DATE}\",\"text\":\"Check system\"},\"stale-session\":{\"count\":1,\"consecutive_clean\":0,\"suppressed\":false,\"first_seen\":\"${TODAY_DATE}\",\"last_seen\":\"${TODAY_DATE}\",\"text\":\"Stale session\"}},\"last_digest_date\":\"${TODAY_DATE}\",\"self_eval\":{},\"total_ticks\":1}"
echo "$STALE_ACTIVE" > "$workdir/.claude-code-hermit/state/alert-state.json"
out="$(cd "$workdir" && HERMIT_NOW="2026-05-20T22:00:00+00:00" node "$HEARTBEAT_PRECHECK" --peek .claude-code-hermit)"
run_test "stale-gate: operator recent + stale-session alert active → EVALUATE (resolution tracking)" bash -c "[ '$out' = 'EVALUATE' ]"
cleanup

# -------------------------------------------------------
# stale.4. in_progress + future-dated last-operator-action (clock skew) → EVALUATE (fail-open)
# -------------------------------------------------------
workdir="$(mktemp -d)"
mkdir -p "$workdir/.claude-code-hermit/sessions"
mkdir -p "$workdir/.claude-code-hermit/state"
printf '# Heartbeat\n\n- Check system\n' > "$workdir/.claude-code-hermit/HEARTBEAT.md"
touch "$workdir/.claude-code-hermit/sessions/SHELL.md"
echo '{"session_state":"in_progress","session_id":"S-001"}' > "$workdir/.claude-code-hermit/state/runtime.json"
echo '{"at":"2026-05-20T23:00:00+00:00"}' > "$workdir/.claude-code-hermit/state/last-operator-action.json"
echo "$SUPPRESSED_ALERT_STATE" > "$workdir/.claude-code-hermit/state/alert-state.json"
out="$(cd "$workdir" && HERMIT_NOW="2026-05-20T22:00:00+00:00" node "$HEARTBEAT_PRECHECK" --peek .claude-code-hermit)"
run_test "stale-gate: future-dated last-operator-action (clock skew) → EVALUATE (fail-open)" bash -c "[ '$out' = 'EVALUATE' ]"
cleanup

# -------------------------------------------------------
# stale.5. in_progress + no last-operator-action.json → EVALUATE (no regression for pre-upgrade installs)
# -------------------------------------------------------
workdir="$(mktemp -d)"
mkdir -p "$workdir/.claude-code-hermit/sessions"
mkdir -p "$workdir/.claude-code-hermit/state"
printf '# Heartbeat\n\n- Check system\n' > "$workdir/.claude-code-hermit/HEARTBEAT.md"
touch "$workdir/.claude-code-hermit/sessions/SHELL.md"
echo '{"session_state":"in_progress","session_id":"S-001"}' > "$workdir/.claude-code-hermit/state/runtime.json"
echo "$SUPPRESSED_ALERT_STATE" > "$workdir/.claude-code-hermit/state/alert-state.json"
out="$(cd "$workdir" && HERMIT_NOW="2026-05-20T22:00:00+00:00" node "$HEARTBEAT_PRECHECK" --peek .claude-code-hermit)"
run_test "stale-gate: absent last-operator-action (pre-upgrade install) → EVALUATE (no regression)" bash -c "[ '$out' = 'EVALUATE' ]"
cleanup

# -------------------------------------------------------
# stale.6. stale.1 variant WITHOUT last_digest_date=today → EVALUATE (digest gate fires correctly)
# -------------------------------------------------------
workdir="$(mktemp -d)"
mkdir -p "$workdir/.claude-code-hermit/sessions"
mkdir -p "$workdir/.claude-code-hermit/state"
printf '# Heartbeat\n\n- Check system\n' > "$workdir/.claude-code-hermit/HEARTBEAT.md"
touch "$workdir/.claude-code-hermit/sessions/SHELL.md"
echo '{"session_state":"in_progress","session_id":"S-001"}' > "$workdir/.claude-code-hermit/state/runtime.json"
echo '{"at":"2026-05-20T21:30:00+00:00"}' > "$workdir/.claude-code-hermit/state/last-operator-action.json"
# Same suppressed item but last_digest_date is yesterday → digest gate fires
STALE_NO_DIGEST="{\"alerts\":{\"checklist:checksys\":{\"count\":6,\"consecutive_clean\":0,\"suppressed\":true,\"first_seen\":\"2026-05-19\",\"last_seen\":\"2026-05-19\",\"text\":\"Check system\"}},\"last_digest_date\":\"2026-05-19\",\"self_eval\":{},\"total_ticks\":1}"
echo "$STALE_NO_DIGEST" > "$workdir/.claude-code-hermit/state/alert-state.json"
out="$(cd "$workdir" && HERMIT_NOW="2026-05-20T22:00:00+00:00" node "$HEARTBEAT_PRECHECK" --peek .claude-code-hermit)"
run_test "stale-gate: operator recent + suppressed but digest not yet run today → EVALUATE (daily digest)" bash -c "[ '$out' = 'EVALUATE' ]"
cleanup

print_results
