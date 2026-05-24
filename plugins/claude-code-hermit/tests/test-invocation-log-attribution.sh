#!/usr/bin/env bash
# Tests: invocation-log.jsonl drives triggered_by/routine_id/proposal attribution
# in cost-tracker JSONL rows. Covers:
#   1. routine attribution (skill-invoke event → triggered_by: "routine")
#   2. cross-session isolation (prior session's events don't bleed)
#   3. proposal attribution via proposal-accept/resolve walk
#   4. stacked accepts — most recent open proposal wins
#   5. proposal-resolve closes the proposal (subsequent rows: proposal: null)
#   6. dedup — previously attributed invocation not re-used across consecutive Stop events
set -uo pipefail

source "$(dirname "$0")/lib.sh"

SCRIPT="$REPO_ROOT/scripts/cost-tracker.js"

echo "=== test-invocation-log-attribution ==="

# ── Test 1: routine attribution ───────────────────────────────────────────────
wd1="$(setup_workdir)"
echo '{"session_id":"S-routine"}' > "$wd1/.claude-code-hermit/state/runtime.json"

# Use a far-future ts so the invocation entry is never considered "already attributed".
cat > "$wd1/.claude-code-hermit/state/invocation-log.jsonl" << 'EOF'
{"ts":"2099-01-01T00:00:00Z","session_id":"S-routine","event":"skill-invoke","skill":"/claude-code-hermit:brief","triggered_by":"routine","routine_id":"morning-brief"}
EOF

cp "$FIXTURES/transcript-slashcommand-routine.jsonl" "$wd1/.claude/transcript.jsonl"

run_test "routine transcript exits 0" bash -c "
  cd '$wd1'
  printf '%s' '{\"session_id\":\"S-routine\",\"transcript_path\":\".claude/transcript.jsonl\"}' \
    | node '$SCRIPT' >/dev/null 2>&1
"

run_test "triggered_by = routine" bash -c "
  node -e \"
    const lines = require('fs').readFileSync('$wd1/.claude/cost-log.jsonl','utf-8').trim().split('\\\\n').filter(Boolean);
    const r = JSON.parse(lines[lines.length-1]);
    if (r.triggered_by !== 'routine') { console.error('got: ' + r.triggered_by); process.exit(1); }
  \" 2>&1
"

run_test "routine_id = morning-brief" bash -c "
  node -e \"
    const lines = require('fs').readFileSync('$wd1/.claude/cost-log.jsonl','utf-8').trim().split('\\\\n').filter(Boolean);
    const r = JSON.parse(lines[lines.length-1]);
    if (r.routine_id !== 'morning-brief') { console.error('got: ' + r.routine_id); process.exit(1); }
  \" 2>&1
"
rm -rf "$wd1"

# ── Test 2: cross-session isolation ──────────────────────────────────────────
wd2="$(setup_workdir)"
echo '{"session_id":"S-new"}' > "$wd2/.claude-code-hermit/state/runtime.json"

# Invocation-log entry belongs to OLD session, not S-new — must be ignored.
cat > "$wd2/.claude-code-hermit/state/invocation-log.jsonl" << 'EOF'
{"ts":"2099-01-01T00:00:00Z","session_id":"S-old","event":"skill-invoke","skill":"/claude-code-hermit:brief","triggered_by":"routine","routine_id":"morning-brief"}
EOF

cp "$FIXTURES/transcript-slashcommand-routine.jsonl" "$wd2/.claude/transcript.jsonl"

run_test "cross-session transcript exits 0" bash -c "
  cd '$wd2'
  printf '%s' '{\"session_id\":\"S-new\",\"transcript_path\":\".claude/transcript.jsonl\"}' \
    | node '$SCRIPT' >/dev/null 2>&1
"

run_test "old session entry NOT attributed (triggered_by = operator)" bash -c "
  node -e \"
    const lines = require('fs').readFileSync('$wd2/.claude/cost-log.jsonl','utf-8').trim().split('\\\\n').filter(Boolean);
    const r = JSON.parse(lines[lines.length-1]);
    if (r.triggered_by !== 'operator') { console.error('got: ' + r.triggered_by); process.exit(1); }
    if (r.routine_id !== null) { console.error('routine_id leaked: ' + r.routine_id); process.exit(1); }
  \" 2>&1
"
rm -rf "$wd2"

# ── Test 3: proposal attribution via proposal-accept ─────────────────────────
wd3="$(setup_workdir)"
echo '{"session_id":"S-prop"}' > "$wd3/.claude-code-hermit/state/runtime.json"

cat > "$wd3/.claude-code-hermit/state/invocation-log.jsonl" << 'EOF'
{"ts":"2099-01-01T00:00:00Z","session_id":"S-prop","event":"proposal-accept","proposal_id":"PROP-042"}
EOF

cp "$FIXTURES/transcript-slashcommand-operator.jsonl" "$wd3/.claude/transcript.jsonl"

run_test "proposal-accept transcript exits 0" bash -c "
  cd '$wd3'
  printf '%s' '{\"session_id\":\"S-prop\",\"transcript_path\":\".claude/transcript.jsonl\"}' \
    | node '$SCRIPT' >/dev/null 2>&1
"

run_test "proposal = PROP-042 from accept event" bash -c "
  node -e \"
    const lines = require('fs').readFileSync('$wd3/.claude/cost-log.jsonl','utf-8').trim().split('\\\\n').filter(Boolean);
    const r = JSON.parse(lines[lines.length-1]);
    if (r.proposal !== 'PROP-042') { console.error('got: ' + r.proposal); process.exit(1); }
  \" 2>&1
"
rm -rf "$wd3"

# ── Test 4: stacked accepts — most recent open wins ───────────────────────────
wd4="$(setup_workdir)"
echo '{"session_id":"S-stack"}' > "$wd4/.claude-code-hermit/state/runtime.json"

cat > "$wd4/.claude-code-hermit/state/invocation-log.jsonl" << 'EOF'
{"ts":"2099-01-01T00:00:00Z","session_id":"S-stack","event":"proposal-accept","proposal_id":"PROP-041"}
{"ts":"2099-01-01T00:01:00Z","session_id":"S-stack","event":"proposal-accept","proposal_id":"PROP-042"}
EOF

cp "$FIXTURES/transcript-slashcommand-operator.jsonl" "$wd4/.claude/transcript.jsonl"

run_test "stacked accepts transcript exits 0" bash -c "
  cd '$wd4'
  printf '%s' '{\"session_id\":\"S-stack\",\"transcript_path\":\".claude/transcript.jsonl\"}' \
    | node '$SCRIPT' >/dev/null 2>&1
"

run_test "most recent open proposal wins (PROP-042)" bash -c "
  node -e \"
    const lines = require('fs').readFileSync('$wd4/.claude/cost-log.jsonl','utf-8').trim().split('\\\\n').filter(Boolean);
    const r = JSON.parse(lines[lines.length-1]);
    if (r.proposal !== 'PROP-042') { console.error('got: ' + r.proposal); process.exit(1); }
  \" 2>&1
"
rm -rf "$wd4"

# ── Test 5: proposal-resolve closes the proposal ─────────────────────────────
wd5="$(setup_workdir)"
echo '{"session_id":"S-resolve"}' > "$wd5/.claude-code-hermit/state/runtime.json"

# PROP-041 accepted then resolved; PROP-042 still open — expect PROP-042
cat > "$wd5/.claude-code-hermit/state/invocation-log.jsonl" << 'EOF'
{"ts":"2099-01-01T00:00:00Z","session_id":"S-resolve","event":"proposal-accept","proposal_id":"PROP-041"}
{"ts":"2099-01-01T00:01:00Z","session_id":"S-resolve","event":"proposal-resolve","proposal_id":"PROP-041"}
{"ts":"2099-01-01T00:02:00Z","session_id":"S-resolve","event":"proposal-accept","proposal_id":"PROP-042"}
EOF

cp "$FIXTURES/transcript-slashcommand-operator.jsonl" "$wd5/.claude/transcript.jsonl"

run_test "resolve+accept transcript exits 0" bash -c "
  cd '$wd5'
  printf '%s' '{\"session_id\":\"S-resolve\",\"transcript_path\":\".claude/transcript.jsonl\"}' \
    | node '$SCRIPT' >/dev/null 2>&1
"

run_test "resolved proposal not attributed (PROP-042 is open)" bash -c "
  node -e \"
    const lines = require('fs').readFileSync('$wd5/.claude/cost-log.jsonl','utf-8').trim().split('\\\\n').filter(Boolean);
    const r = JSON.parse(lines[lines.length-1]);
    if (r.proposal !== 'PROP-042') { console.error('got: ' + r.proposal); process.exit(1); }
  \" 2>&1
"

# Now resolve PROP-042 — subsequent rows should have proposal: null
cat >> "$wd5/.claude-code-hermit/state/invocation-log.jsonl" << 'EOF'
{"ts":"2099-01-01T00:03:00Z","session_id":"S-resolve","event":"proposal-resolve","proposal_id":"PROP-042"}
EOF

cp "$FIXTURES/transcript-slashcommand-operator.jsonl" "$wd5/.claude/transcript2.jsonl"

run_test "after resolving PROP-042 transcript exits 0" bash -c "
  cd '$wd5'
  printf '%s' '{\"session_id\":\"S-resolve\",\"transcript_path\":\".claude/transcript2.jsonl\"}' \
    | node '$SCRIPT' >/dev/null 2>&1
"

run_test "after both resolved: proposal = null" bash -c "
  node -e \"
    const lines = require('fs').readFileSync('$wd5/.claude/cost-log.jsonl','utf-8').trim().split('\\\\n').filter(Boolean);
    const r = JSON.parse(lines[lines.length-1]);
    if (r.proposal !== null) { console.error('got: ' + r.proposal); process.exit(1); }
  \" 2>&1
"
rm -rf "$wd5"

# ── Test 6: dedup — same invocation entry not attributed twice ────────────────
# An invocation-log entry at ts T1 is already "used" by a prior cost-log row at ts T2 > T1.
# The next Stop should fall back to triggered_by: "operator".
wd6="$(setup_workdir)"
echo '{"session_id":"S-dedup"}' > "$wd6/.claude-code-hermit/state/runtime.json"

cat > "$wd6/.claude-code-hermit/state/invocation-log.jsonl" << 'EOF'
{"ts":"2026-01-01T10:00:00Z","session_id":"S-dedup","event":"skill-invoke","skill":"/claude-code-hermit:brief","triggered_by":"routine","routine_id":"morning-brief"}
EOF

# Pre-existing cost-log row for S-dedup + /claude-code-hermit:brief at a LATER timestamp.
# This simulates the first Stop which already consumed the invocation entry.
cat > "$wd6/.claude/cost-log.jsonl" << 'EOF'
{"timestamp":"2026-06-01T12:00:00.000Z","session_id":"S-dedup","model":"sonnet","model_full":null,"input_tokens":1000,"cache_write_tokens":0,"cache_read_tokens":0,"output_tokens":200,"total_tokens":1200,"estimated_cost_usd":0.01,"had_human_turn":false,"skill":"/claude-code-hermit:brief","skill_args":"--morning","task":null,"triggered_by":"routine","routine_id":"morning-brief","proposal":null,"proposal_tag":null}
EOF

cp "$FIXTURES/transcript-slashcommand-routine.jsonl" "$wd6/.claude/transcript.jsonl"

run_test "second Stop exits 0" bash -c "
  cd '$wd6'
  printf '%s' '{\"session_id\":\"S-dedup\",\"transcript_path\":\".claude/transcript.jsonl\"}' \
    | node '$SCRIPT' >/dev/null 2>&1
"

run_test "second Stop does NOT re-use old invocation entry (triggered_by = operator)" bash -c "
  node -e \"
    const lines = require('fs').readFileSync('$wd6/.claude/cost-log.jsonl','utf-8').trim().split('\\\\n').filter(Boolean);
    const r = JSON.parse(lines[lines.length-1]);
    if (r.triggered_by !== 'operator') {
      console.error('dedup failed: triggered_by=' + r.triggered_by); process.exit(1);
    }
    if (r.routine_id !== null) {
      console.error('dedup failed: routine_id=' + r.routine_id); process.exit(1);
    }
  \" 2>&1
"
rm -rf "$wd6"

print_results
