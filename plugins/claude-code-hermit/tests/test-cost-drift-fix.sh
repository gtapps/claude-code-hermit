#!/usr/bin/env bash
# Tests: cost_usd in .status.json is derived from JSONL sum (not accumulated increments),
# and operator_turns = baseline + count(had_human_turn: true rows in JSONL).
set -uo pipefail

source "$(dirname "$0")/lib.sh"

SCRIPT="$REPO_ROOT/scripts/cost-tracker.js"

echo "=== test-cost-drift-fix ==="

workdir="$(setup_workdir)"
echo '{"session_id":"S-drift"}' > "$workdir/.claude-code-hermit/state/runtime.json"

# Pre-populate cost-log with 3 rows totalling a known sum ($5.1234)
# Row 1 and 2: had_human_turn:true; Row 3: had_human_turn:false
cat > "$workdir/.claude/cost-log.jsonl" << 'EOF'
{"timestamp":"2026-01-01T00:00:00.000Z","session_id":"S-drift","model":"sonnet","model_full":null,"input_tokens":1000,"cache_write_tokens":0,"cache_read_tokens":0,"output_tokens":200,"total_tokens":1200,"estimated_cost_usd":1.0000,"had_human_turn":true,"skill":null,"skill_args":null,"task":null,"triggered_by":"operator","routine_id":null,"proposal":null,"proposal_tag":null}
{"timestamp":"2026-01-02T00:00:00.000Z","session_id":"S-drift","model":"sonnet","model_full":null,"input_tokens":2000,"cache_write_tokens":0,"cache_read_tokens":0,"output_tokens":400,"total_tokens":2400,"estimated_cost_usd":2.0000,"had_human_turn":true,"skill":null,"skill_args":null,"task":null,"triggered_by":"operator","routine_id":null,"proposal":null,"proposal_tag":null}
{"timestamp":"2026-01-03T00:00:00.000Z","session_id":"S-drift","model":"sonnet","model_full":null,"input_tokens":3000,"cache_write_tokens":0,"cache_read_tokens":0,"output_tokens":600,"total_tokens":3600,"estimated_cost_usd":2.1234,"had_human_turn":false,"skill":null,"skill_args":null,"task":null,"triggered_by":"operator","routine_id":null,"proposal":null,"proposal_tag":null}
EOF

# Write a stale .status.json with a wrong cost_usd ($4.00 instead of $5.12) and operator_turns:7
# This simulates the pre-PR-1 drift condition.
# NOTE: cost-baseline.json is intentionally absent; cost-tracker will create it from this file.
cat > "$workdir/.claude-code-hermit/sessions/.status.json" << 'EOF'
{
  "updated": "2026-01-03T00:00:00.000Z",
  "session_id": "S-drift",
  "status": "idle",
  "task": "",
  "plan_done": 0,
  "plan_total": 0,
  "tasks_completed": 0,
  "cost_usd": 4.0,
  "budget_usd": null,
  "tokens": 7200,
  "operator_turns": 7,
  "blockers": null
}
EOF

cp "$FIXTURES/transcript-slashcommand-operator.jsonl" "$workdir/.claude/transcript.jsonl"

run_test "cost-tracker exits 0" bash -c "
  cd '$workdir'
  printf '%s' '{\"session_id\":\"S-drift\",\"transcript_path\":\".claude/transcript.jsonl\"}' \
    | node '$SCRIPT' >/dev/null 2>&1
"

run_test ".status.json written" bash -c "[ -f '$workdir/.claude-code-hermit/sessions/.status.json' ]"

run_test "cost-baseline.json created from old operator_turns" bash -c "
  [ -f '$workdir/.claude-code-hermit/state/cost-baseline.json' ]
"

cat > "$workdir/assert-drift.js" << 'JSEOF'
'use strict';
const fs = require('fs');

// Sum all JSONL rows manually
const lines = fs.readFileSync('.claude/cost-log.jsonl','utf-8').trim().split('\n').filter(Boolean);
let jsonlSum = 0;
let humanTurnCount = 0;
for (const l of lines) {
  const r = JSON.parse(l);
  jsonlSum += r.estimated_cost_usd || 0;
  if (r.had_human_turn === true) humanTurnCount++;
}

const status = JSON.parse(fs.readFileSync('.claude-code-hermit/sessions/.status.json','utf-8'));

// cost_usd must match JSONL sum (not the old stale $4.00 value)
if (Math.abs(status.cost_usd - jsonlSum) > 0.01) {
  console.error(`cost_usd ${status.cost_usd} != JSONL sum ${jsonlSum}`);
  process.exit(1);
}

// Must NOT equal the stale drifted value
if (Math.abs(status.cost_usd - 4.0) < 0.01) {
  console.error('cost_usd still has the stale drifted value 4.0');
  process.exit(1);
}

// operator_turns = baseline (7, from old .status.json) + had_human_turn count from JSONL
// Pre-existing rows: 2 with had_human_turn:true; new row from transcript: 1 more.
// Total: 7 + 3 = 10.
const baseline = JSON.parse(fs.readFileSync('.claude-code-hermit/state/cost-baseline.json','utf-8'));
if (baseline.operator_turns_baseline !== 7) {
  console.error('baseline should be 7, got ' + baseline.operator_turns_baseline);
  process.exit(1);
}

const expectedTurns = 7 + humanTurnCount; // baseline + count from JSONL
if (status.operator_turns !== expectedTurns) {
  console.error(`operator_turns ${status.operator_turns} != expected ${expectedTurns} (baseline 7 + ${humanTurnCount} from JSONL)`);
  process.exit(1);
}

console.log(`OK: cost_usd=${status.cost_usd.toFixed(4)} (JSONL sum), operator_turns=${status.operator_turns}`);
JSEOF

run_test "cost_usd = JSONL sum (no rounding drift)" bash -c "
  cd '$workdir' && node assert-drift.js >/dev/null 2>&1
"

# Verify baseline is stable on a second run (not re-captured from the new .status.json)
cp "$FIXTURES/transcript-slashcommand-operator.jsonl" "$workdir/.claude/transcript2.jsonl"

run_test "second run exits 0" bash -c "
  cd '$workdir'
  printf '%s' '{\"session_id\":\"S-drift\",\"transcript_path\":\".claude/transcript2.jsonl\"}' \
    | node '$SCRIPT' >/dev/null 2>&1
"

run_test "baseline unchanged after second run" bash -c "
  node -e \"
    const b = JSON.parse(require('fs').readFileSync('$workdir/.claude-code-hermit/state/cost-baseline.json','utf-8'));
    if (b.operator_turns_baseline !== 7) { console.error('baseline changed to '+b.operator_turns_baseline); process.exit(1); }
  \" 2>&1
"

cleanup
print_results
