#!/usr/bin/env bash
# Tests: cost-tracker exits 0 (never blocks Claude Code) under all failure modes.
# Rule: hooks fail open — errors must never cause a non-zero exit.
set -uo pipefail

source "$(dirname "$0")/lib.sh"

SCRIPT="$REPO_ROOT/scripts/cost-tracker.js"

echo "=== test-cost-tracker-fail-open ==="

workdir="$(setup_workdir)"

# ── Case 1: Missing transcript file ──────────────────────────────────────────
run_test "missing transcript → exit 0" bash -c "
  cd '$workdir'
  printf '%s' '{\"session_id\":\"S-fail\",\"transcript_path\":\"/nonexistent/transcript.jsonl\"}' \
    | node '$SCRIPT' >/dev/null 2>&1
"

# ── Case 2: Empty stdin ───────────────────────────────────────────────────────
run_test "empty stdin → exit 0" bash -c "
  cd '$workdir'
  printf '' | node '$SCRIPT' >/dev/null 2>&1
"

# ── Case 3: Invalid JSON stdin ────────────────────────────────────────────────
run_test "invalid JSON stdin → exit 0" bash -c "
  cd '$workdir'
  printf '%s' 'not valid json at all' | node '$SCRIPT' >/dev/null 2>&1
"

# ── Case 4: Transcript exists but contains no valid assistant entries ─────────
echo '{"type":"invalid"}' > "$workdir/.claude/empty-transcript.jsonl"

run_test "transcript with no assistant entries → exit 0" bash -c "
  cd '$workdir'
  printf '%s' '{\"session_id\":\"S-fail\",\"transcript_path\":\".claude/empty-transcript.jsonl\"}' \
    | node '$SCRIPT' >/dev/null 2>&1
"

# ── Case 5: Transcript exists but has zero-token assistant entry ───────────────
cat > "$workdir/.claude/zero-tokens.jsonl" << 'EOF'
{"type":"human","message":{"content":[{"type":"text","text":"hello"}]}}
{"type":"assistant","message":{"model":"claude-sonnet-4-6","content":[{"type":"text","text":"hi"}],"usage":{"input_tokens":0,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":0}}}
EOF

run_test "zero-token turn → exit 0 (nothing written)" bash -c "
  cd '$workdir'
  before=\$(wc -l < '$workdir/.claude/cost-log.jsonl' 2>/dev/null || echo 0)
  printf '%s' '{\"session_id\":\"S-fail\",\"transcript_path\":\".claude/zero-tokens.jsonl\"}' \
    | node '$SCRIPT' >/dev/null 2>&1
  after=\$(wc -l < '$workdir/.claude/cost-log.jsonl' 2>/dev/null || echo 0)
  [ \"\$before\" = \"\$after\" ]
"

# ── Case 6: Corrupt cost-log.jsonl (bad lines among valid ones) ───────────────
cat > "$workdir/.claude/cost-log.jsonl" << 'EOF'
{"timestamp":"2026-01-01T00:00:00Z","estimated_cost_usd":1.0,"had_human_turn":true,"total_tokens":1000}
this is not json
{"timestamp":"2026-01-02T00:00:00Z","estimated_cost_usd":2.0,"had_human_turn":true,"total_tokens":2000}
{ bad json here [
{"timestamp":"2026-01-03T00:00:00Z","estimated_cost_usd":0.5,"had_human_turn":false,"total_tokens":500}
EOF

cp "$FIXTURES/transcript-slashcommand-operator.jsonl" "$workdir/.claude/transcript.jsonl"

run_test "corrupt cost-log.jsonl → exit 0" bash -c "
  cd '$workdir'
  printf '%s' '{\"session_id\":\"S-fail\",\"transcript_path\":\".claude/transcript.jsonl\"}' \
    | node '$SCRIPT' >/dev/null 2>&1
"

run_test "new row still appended despite corrupt cost-log" bash -c "
  linecount=\$(grep -c . '$workdir/.claude/cost-log.jsonl' 2>/dev/null || echo 0)
  [ \"\$linecount\" -gt 5 ]
"

# ── Case 7: No .claude/ directory (cost-log write fails) ─────────────────────
workdir2="$(mktemp -d)"
mkdir -p "$workdir2/.claude-code-hermit/sessions" "$workdir2/.claude-code-hermit/state"
cp "$FIXTURES/shell-session.md" "$workdir2/.claude-code-hermit/sessions/SHELL.md"
cp "$FIXTURES/transcript-slashcommand-operator.jsonl" "$workdir2/transcript.jsonl"
# No .claude/ directory — cost-log append will fail

run_test "missing .claude/ dir → exit 0" bash -c "
  cd '$workdir2'
  printf '%s' '{\"session_id\":\"S-fail\",\"transcript_path\":\"transcript.jsonl\"}' \
    | node '$SCRIPT' >/dev/null 2>&1
"
rm -rf "$workdir2"

# ── Case 8: runtime.json missing ─────────────────────────────────────────────
# (cost-tracker falls back to the session_id from stdin)
workdir3="$(setup_workdir)"
cp "$FIXTURES/transcript-slashcommand-operator.jsonl" "$workdir3/.claude/transcript.jsonl"
# Intentionally do NOT create runtime.json

run_test "missing runtime.json → exit 0" bash -c "
  cd '$workdir3'
  printf '%s' '{\"session_id\":\"S-fallback\",\"transcript_path\":\".claude/transcript.jsonl\"}' \
    | node '$SCRIPT' >/dev/null 2>&1
"
run_test "session_id falls back to stdin value" bash -c "
  node -e \"
    const lines = require('fs').readFileSync('$workdir3/.claude/cost-log.jsonl','utf-8').trim().split('\n').filter(Boolean);
    const r = JSON.parse(lines[lines.length-1]);
    if (r.session_id !== 'S-fallback') {
      console.error('session_id: ' + r.session_id); process.exit(1);
    }
  \" 2>&1
"
rm -rf "$workdir3"

cleanup
print_results
