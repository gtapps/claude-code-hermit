#!/usr/bin/env bash
# Unit tests for scripts/eval-success-signal.js
# Validate mode (grammar) and evaluate mode (MET / UNMET / INSUFFICIENT_DATA).
# Runs from inside plugins/claude-code-hermit/ (REPO_ROOT = that directory).
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

EVAL="$REPO_ROOT/scripts/eval-success-signal.js"
echo "=== eval-success-signal tests ==="
echo ""

# ── Validate mode ─────────────────────────────────────────────────────────────

run_test "validate: canonical predicate accepted" \
  node "$EVAL" --validate "avg_session_cost_usd < 0.30 over 10 sessions"

run_test "validate: <= op accepted" \
  node "$EVAL" --validate "avg_session_cost_usd <= 0.50 over 5 sessions"

run_test "validate: > op accepted" \
  node "$EVAL" --validate "avg_session_cost_usd > 0.10 over 3 sessions"

run_test "validate: >= op accepted" \
  node "$EVAL" --validate "avg_session_cost_usd >= 0.05 over 1 session"

run_test "validate: integer threshold accepted" \
  node "$EVAL" --validate "avg_session_cost_usd < 1 over 7 sessions"

run_test "validate: bad op rejected (exit non-zero)" \
  bash -c '! node "$1" --validate "avg_session_cost_usd ~ 0.30 over 10 sessions"' -- "$EVAL"

run_test "validate: bad op prints reason" \
  bash -c 'node "$1" --validate "avg_session_cost_usd ~ 0.30 over 10 sessions" 2>&1 | grep -q "invalid grammar"' -- "$EVAL"

run_test "validate: unsupported metric rejected" \
  bash -c '! node "$1" --validate "total_tokens < 1000 over 5 sessions"' -- "$EVAL"

run_test "validate: unsupported metric prints reason" \
  bash -c 'node "$1" --validate "total_tokens < 1000 over 5 sessions" 2>&1 | grep -q "unsupported metric"' -- "$EVAL"

run_test "validate: missing 'over N sessions' rejected" \
  bash -c '! node "$1" --validate "avg_session_cost_usd < 0.30"' -- "$EVAL"

run_test "validate: missing window number rejected" \
  bash -c '! node "$1" --validate "avg_session_cost_usd < 0.30 over sessions"' -- "$EVAL"

# ── Evaluate mode — helper to build fixtures ──────────────────────────────────

# Write a session report fixture with a given id, date, and cost_usd.
write_report() {
  local dir="$1" id="$2" date="$3" cost="$4"
  cat >"$dir/$id-REPORT.md" <<EOF
---
id: $id
status: completed
date: $date
duration: ~1h
cost_usd: $cost
tokens: 10000
tags: []
task: "test task"
escalation: balanced
operator_turns: 2
closed_via: operator
---
# Session Report: $id
## Completed
Test.
EOF
}

# ── INSUFFICIENT_DATA (window not filled) ─────────────────────────────────────

run_test "evaluate: INSUFFICIENT_DATA when fewer sessions than window" \
  bash -c '
    workdir="$(mktemp -d)"
    trap "rm -rf \"$workdir\"" EXIT
    sdir="$workdir/.claude-code-hermit"
    mkdir -p "$sdir/sessions"
    # 3 sessions post-accept, window = 5 → not enough
    '"$(declare -f write_report)"'
    write_report "$sdir/sessions" S-001 "2026-05-01T10:00:00Z" 0.20
    write_report "$sdir/sessions" S-002 "2026-05-02T10:00:00Z" 0.22
    write_report "$sdir/sessions" S-003 "2026-05-03T10:00:00Z" 0.18
    out=$(node "'"$EVAL"'" "$sdir" "2026-04-30T00:00:00Z" "null" "avg_session_cost_usd < 0.30 over 5 sessions")
    echo "$out" | grep -q "INSUFFICIENT_DATA"
  '

run_test "evaluate: sessions_counted in INSUFFICIENT_DATA output" \
  bash -c '
    workdir="$(mktemp -d)"
    trap "rm -rf \"$workdir\"" EXIT
    sdir="$workdir/.claude-code-hermit"
    mkdir -p "$sdir/sessions"
    '"$(declare -f write_report)"'
    write_report "$sdir/sessions" S-001 "2026-05-01T10:00:00Z" 0.20
    out=$(node "'"$EVAL"'" "$sdir" "2026-04-30T00:00:00Z" "null" "avg_session_cost_usd < 0.30 over 5 sessions")
    echo "$out" | node -e "const d=JSON.parse(require(\"fs\").readFileSync(\"/dev/stdin\",\"utf8\")); process.exit(d.sessions_counted===1?0:1)"
  '

# ── MET ───────────────────────────────────────────────────────────────────────

run_test "evaluate: MET when avg < threshold" \
  bash -c '
    workdir="$(mktemp -d)"
    trap "rm -rf \"$workdir\"" EXIT
    sdir="$workdir/.claude-code-hermit"
    mkdir -p "$sdir/sessions"
    '"$(declare -f write_report)"'
    # avg = (0.20+0.22+0.18+0.19+0.21) / 5 = 0.20 < 0.30
    write_report "$sdir/sessions" S-001 "2026-05-01T10:00:00Z" 0.20
    write_report "$sdir/sessions" S-002 "2026-05-02T10:00:00Z" 0.22
    write_report "$sdir/sessions" S-003 "2026-05-03T10:00:00Z" 0.18
    write_report "$sdir/sessions" S-004 "2026-05-04T10:00:00Z" 0.19
    write_report "$sdir/sessions" S-005 "2026-05-05T10:00:00Z" 0.21
    out=$(node "'"$EVAL"'" "$sdir" "2026-04-30T00:00:00Z" "null" "avg_session_cost_usd < 0.30 over 5 sessions")
    echo "$out" | grep -q "\"verdict\":\"MET\""
  '

run_test "evaluate: observed value in MET output" \
  bash -c '
    workdir="$(mktemp -d)"
    trap "rm -rf \"$workdir\"" EXIT
    sdir="$workdir/.claude-code-hermit"
    mkdir -p "$sdir/sessions"
    '"$(declare -f write_report)"'
    write_report "$sdir/sessions" S-001 "2026-05-01T10:00:00Z" 0.20
    write_report "$sdir/sessions" S-002 "2026-05-02T10:00:00Z" 0.20
    write_report "$sdir/sessions" S-003 "2026-05-03T10:00:00Z" 0.20
    out=$(node "'"$EVAL"'" "$sdir" "2026-04-30T00:00:00Z" "null" "avg_session_cost_usd < 0.30 over 3 sessions")
    echo "$out" | node -e "const d=JSON.parse(require(\"fs\").readFileSync(\"/dev/stdin\",\"utf8\")); process.exit(d.observed===0.2?0:1)"
  '

# ── UNMET ─────────────────────────────────────────────────────────────────────

run_test "evaluate: UNMET when avg >= threshold (< op)" \
  bash -c '
    workdir="$(mktemp -d)"
    trap "rm -rf \"$workdir\"" EXIT
    sdir="$workdir/.claude-code-hermit"
    mkdir -p "$sdir/sessions"
    '"$(declare -f write_report)"'
    # avg = 0.40 which is NOT < 0.30
    write_report "$sdir/sessions" S-001 "2026-05-01T10:00:00Z" 0.40
    write_report "$sdir/sessions" S-002 "2026-05-02T10:00:00Z" 0.40
    write_report "$sdir/sessions" S-003 "2026-05-03T10:00:00Z" 0.40
    out=$(node "'"$EVAL"'" "$sdir" "2026-04-30T00:00:00Z" "null" "avg_session_cost_usd < 0.30 over 3 sessions")
    echo "$out" | grep -q "\"verdict\":\"UNMET\""
  '

# ── accepted_in_session exclusion ─────────────────────────────────────────────

run_test "evaluate: accepted_in_session excluded from window" \
  bash -c '
    workdir="$(mktemp -d)"
    trap "rm -rf \"$workdir\"" EXIT
    sdir="$workdir/.claude-code-hermit"
    mkdir -p "$sdir/sessions"
    '"$(declare -f write_report)"'
    # S-001 is the implementation session (high cost); S-002..S-004 are under threshold.
    # If S-001 were included, avg would be (1.50+0.20+0.20+0.20)/4 = 0.525 → UNMET.
    # With exclusion, avg = (0.20+0.20+0.20)/3 = 0.20 → MET.
    write_report "$sdir/sessions" S-001 "2026-05-01T10:00:00Z" 1.50
    write_report "$sdir/sessions" S-002 "2026-05-02T10:00:00Z" 0.20
    write_report "$sdir/sessions" S-003 "2026-05-03T10:00:00Z" 0.20
    write_report "$sdir/sessions" S-004 "2026-05-04T10:00:00Z" 0.20
    out=$(node "'"$EVAL"'" "$sdir" "2026-04-30T00:00:00Z" "S-001" "avg_session_cost_usd < 0.30 over 3 sessions")
    echo "$out" | grep -q "\"verdict\":\"MET\""
  '

# ── Pre-accept sessions excluded ──────────────────────────────────────────────

run_test "evaluate: sessions before accepted_date excluded" \
  bash -c '
    workdir="$(mktemp -d)"
    trap "rm -rf \"$workdir\"" EXIT
    sdir="$workdir/.claude-code-hermit"
    mkdir -p "$sdir/sessions"
    '"$(declare -f write_report)"'
    # S-001 is before accepted_date and should be excluded.
    # Only S-002..S-003 are valid (< 3 needed) → INSUFFICIENT_DATA.
    write_report "$sdir/sessions" S-001 "2026-04-01T10:00:00Z" 0.10
    write_report "$sdir/sessions" S-002 "2026-05-02T10:00:00Z" 0.20
    write_report "$sdir/sessions" S-003 "2026-05-03T10:00:00Z" 0.20
    out=$(node "'"$EVAL"'" "$sdir" "2026-05-01T00:00:00Z" "null" "avg_session_cost_usd < 0.30 over 3 sessions")
    echo "$out" | grep -q "INSUFFICIENT_DATA"
  '

# ── Fail-open on malformed report ─────────────────────────────────────────────

run_test "evaluate: malformed report does not crash (fail-open)" \
  bash -c '
    workdir="$(mktemp -d)"
    trap "rm -rf \"$workdir\"" EXIT
    sdir="$workdir/.claude-code-hermit"
    mkdir -p "$sdir/sessions"
    '"$(declare -f write_report)"'
    # Write a non-YAML file that will fail frontmatter parse.
    echo "not a frontmatter file" > "$sdir/sessions/S-BAD-REPORT.md"
    write_report "$sdir/sessions" S-001 "2026-05-01T10:00:00Z" 0.20
    write_report "$sdir/sessions" S-002 "2026-05-02T10:00:00Z" 0.20
    write_report "$sdir/sessions" S-003 "2026-05-03T10:00:00Z" 0.20
    out=$(node "'"$EVAL"'" "$sdir" "2026-04-30T00:00:00Z" "null" "avg_session_cost_usd < 0.30 over 3 sessions")
    # Bad file is skipped; valid ones are evaluated normally.
    echo "$out" | grep -q "\"verdict\":\"MET\""
  '

run_test "evaluate: missing sessions dir returns INSUFFICIENT_DATA (not crash)" \
  bash -c '
    workdir="$(mktemp -d)"
    trap "rm -rf \"$workdir\"" EXIT
    sdir="$workdir/.claude-code-hermit"
    mkdir -p "$sdir/state"
    # No sessions/ directory.
    out=$(node "'"$EVAL"'" "$sdir" "2026-04-30T00:00:00Z" "null" "avg_session_cost_usd < 0.30 over 3 sessions")
    echo "$out" | grep -q "INSUFFICIENT_DATA"
  '

# ── Unrecorded cost (cost_usd <= 0) excluded ──────────────────────────────────

run_test "evaluate: cost_usd=0 sessions excluded (no spurious MET)" \
  bash -c '
    workdir="$(mktemp -d)"
    trap "rm -rf \"$workdir\"" EXIT
    sdir="$workdir/.claude-code-hermit"
    mkdir -p "$sdir/sessions"
    '"$(declare -f write_report)"'
    # cost_usd defaults to 0.00 when the cost-tracker hook is inactive. Three
    # such sessions must NOT satisfy "< 0.30" — they are unrecorded, not $0.
    write_report "$sdir/sessions" S-001 "2026-05-01T10:00:00Z" 0.00
    write_report "$sdir/sessions" S-002 "2026-05-02T10:00:00Z" 0.00
    write_report "$sdir/sessions" S-003 "2026-05-03T10:00:00Z" 0.00
    out=$(node "'"$EVAL"'" "$sdir" "2026-04-30T00:00:00Z" "null" "avg_session_cost_usd < 0.30 over 3 sessions")
    echo "$out" | grep -q "INSUFFICIENT_DATA"
  '

run_test "evaluate: unrecorded sessions skipped, recorded ones still count" \
  bash -c '
    workdir="$(mktemp -d)"
    trap "rm -rf \"$workdir\"" EXIT
    sdir="$workdir/.claude-code-hermit"
    mkdir -p "$sdir/sessions"
    '"$(declare -f write_report)"'
    # Two unrecorded + three recorded → window of 3 fills from the recorded ones.
    write_report "$sdir/sessions" S-001 "2026-05-01T10:00:00Z" 0.00
    write_report "$sdir/sessions" S-002 "2026-05-02T10:00:00Z" 0.20
    write_report "$sdir/sessions" S-003 "2026-05-03T10:00:00Z" 0.00
    write_report "$sdir/sessions" S-004 "2026-05-04T10:00:00Z" 0.20
    write_report "$sdir/sessions" S-005 "2026-05-05T10:00:00Z" 0.20
    out=$(node "'"$EVAL"'" "$sdir" "2026-04-30T00:00:00Z" "null" "avg_session_cost_usd < 0.30 over 3 sessions")
    echo "$out" | node -e "const d=JSON.parse(require(\"fs\").readFileSync(\"/dev/stdin\",\"utf8\")); process.exit(d.verdict===\"MET\"&&d.sessions_counted===3&&d.observed===0.2?0:1)"
  '

print_results
