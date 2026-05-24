#!/usr/bin/env bash
# Tests: all 9 new attribution fields appear in each JSONL row written by cost-tracker.
set -uo pipefail

source "$(dirname "$0")/lib.sh"

SCRIPT="$REPO_ROOT/scripts/cost-tracker.js"

echo "=== test-cost-schema-contract ==="

workdir="$(setup_workdir)"
cp "$FIXTURES/transcript-slashcommand-operator.jsonl" "$workdir/.claude/transcript.jsonl"
echo '{"session_id":"S-schema"}' > "$workdir/.claude-code-hermit/state/runtime.json"

# Run cost-tracker with the operator transcript
run_test "cost-tracker exits 0" bash -c "
  cd '$workdir'
  printf '%s' '{\"session_id\":\"S-schema\",\"transcript_path\":\".claude/transcript.jsonl\"}' \
    | node '$SCRIPT' >/dev/null 2>&1
"

run_test "cost-log.jsonl created" bash -c "[ -f '$workdir/.claude/cost-log.jsonl' ]"

# Write an assertion script so we avoid quoting hell
cat > "$workdir/assert-schema.js" << 'JSEOF'
'use strict';
const fs = require('fs');
const lines = fs.readFileSync('.claude/cost-log.jsonl','utf-8').trim().split('\n').filter(Boolean);
if (lines.length === 0) { console.error('No rows in cost-log.jsonl'); process.exit(1); }
const row = JSON.parse(lines[lines.length - 1]);

const REQUIRED = [
  'model_full','had_human_turn','skill','skill_args','task',
  'triggered_by','routine_id','proposal','proposal_tag',
];
for (const f of REQUIRED) {
  if (!(f in row)) { console.error('Missing field: ' + f); process.exit(1); }
}

if (row.skill !== '/claude-code-hermit:pulse') {
  console.error('skill wrong: ' + row.skill); process.exit(1);
}
if (row.triggered_by !== 'operator') {
  console.error('triggered_by wrong: ' + row.triggered_by); process.exit(1);
}
if (row.had_human_turn !== true) {
  console.error('had_human_turn wrong: ' + row.had_human_turn); process.exit(1);
}
if (row.skill_args !== null) {
  console.error('skill_args should be null: ' + row.skill_args); process.exit(1);
}
// Legacy fields must still be present
const LEGACY = ['timestamp','session_id','model','input_tokens','cache_write_tokens',
                 'cache_read_tokens','output_tokens','total_tokens','estimated_cost_usd'];
for (const f of LEGACY) {
  if (!(f in row)) { console.error('Missing legacy field: ' + f); process.exit(1); }
}
console.log('OK');
JSEOF

run_test "all 9 new fields present with correct values" bash -c "
  cd '$workdir' && node assert-schema.js >/dev/null 2>&1
"

# Skill+args when the command has arguments (use routine transcript)
cp "$FIXTURES/transcript-slashcommand-routine.jsonl" "$workdir/.claude/transcript2.jsonl"

run_test "cost-tracker exits 0 on routine transcript" bash -c "
  cd '$workdir'
  printf '%s' '{\"session_id\":\"S-schema\",\"transcript_path\":\".claude/transcript2.jsonl\"}' \
    | node '$SCRIPT' >/dev/null 2>&1
"

cat > "$workdir/assert-args.js" << 'JSEOF'
'use strict';
const fs = require('fs');
const lines = fs.readFileSync('.claude/cost-log.jsonl','utf-8').trim().split('\n').filter(Boolean);
const row = JSON.parse(lines[lines.length - 1]);
if (row.skill !== '/claude-code-hermit:brief') {
  console.error('skill wrong: ' + row.skill); process.exit(1);
}
if (row.skill_args !== '--morning') {
  console.error('skill_args wrong: ' + row.skill_args); process.exit(1);
}
console.log('OK');
JSEOF

run_test "skill with args split correctly" bash -c "
  cd '$workdir' && node assert-args.js >/dev/null 2>&1
"

# Task field captured from TaskCreate transcript
cp "$FIXTURES/transcript-task-inprogress.jsonl" "$workdir/.claude/transcript3.jsonl"

run_test "cost-tracker exits 0 on task transcript" bash -c "
  cd '$workdir'
  printf '%s' '{\"session_id\":\"S-schema\",\"transcript_path\":\".claude/transcript3.jsonl\"}' \
    | node '$SCRIPT' >/dev/null 2>&1
"

cat > "$workdir/assert-task.js" << 'JSEOF'
'use strict';
const fs = require('fs');
const lines = fs.readFileSync('.claude/cost-log.jsonl','utf-8').trim().split('\n').filter(Boolean);
const row = JSON.parse(lines[lines.length - 1]);
if (!row.task || !row.task.includes('PROP-047')) {
  console.error('task wrong: ' + row.task); process.exit(1);
}
console.log('OK');
JSEOF

run_test "task captured from TaskCreate" bash -c "
  cd '$workdir' && node assert-task.js >/dev/null 2>&1
"

cleanup
print_results
