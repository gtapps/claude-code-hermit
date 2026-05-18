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

print_results
