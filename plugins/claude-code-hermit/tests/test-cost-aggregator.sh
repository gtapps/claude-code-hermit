#!/usr/bin/env bash
# Tests: cost-aggregator.js writes the four profile files with correct stats
# and uses atomic (PID+random suffix) tmp files that clean up after rename.
set -uo pipefail

source "$(dirname "$0")/lib.sh"

AGG_SCRIPT="$REPO_ROOT/scripts/cost-aggregator.js"

echo "=== test-cost-aggregator ==="

workdir="$(setup_workdir)"

# Build JSONL fixture with attribution data for all four profile dimensions.
# All rows have recent timestamps (within 30d window).
TODAY="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
cat > "$workdir/.claude/cost-log.jsonl" << EOF
{"timestamp":"$TODAY","session_id":"S-001","model":"sonnet","model_full":"claude-sonnet-4-6","input_tokens":1000,"cache_write_tokens":0,"cache_read_tokens":5000,"output_tokens":200,"total_tokens":6200,"estimated_cost_usd":0.0100,"had_human_turn":true,"skill":"/claude-code-hermit:pulse","skill_args":null,"task":null,"triggered_by":"operator","routine_id":null,"proposal":null,"proposal_tag":null}
{"timestamp":"$TODAY","session_id":"S-001","model":"sonnet","model_full":"claude-sonnet-4-6","input_tokens":2000,"cache_write_tokens":0,"cache_read_tokens":10000,"output_tokens":400,"total_tokens":12400,"estimated_cost_usd":0.0200,"had_human_turn":false,"skill":"/claude-code-hermit:pulse","skill_args":null,"task":null,"triggered_by":"routine","routine_id":"morning-brief","proposal":null,"proposal_tag":null}
{"timestamp":"$TODAY","session_id":"S-001","model":"sonnet","model_full":"claude-sonnet-4-6","input_tokens":1500,"cache_write_tokens":100,"cache_read_tokens":8000,"output_tokens":300,"total_tokens":9900,"estimated_cost_usd":0.0150,"had_human_turn":false,"skill":"/claude-code-hermit:brief","skill_args":"--morning","task":null,"triggered_by":"routine","routine_id":"morning-brief","proposal":null,"proposal_tag":null}
{"timestamp":"$TODAY","session_id":"S-002","model":"sonnet","model_full":"claude-sonnet-4-6","input_tokens":3000,"cache_write_tokens":0,"cache_read_tokens":15000,"output_tokens":600,"total_tokens":18600,"estimated_cost_usd":0.0500,"had_human_turn":true,"skill":"/claude-code-hermit:reflect","skill_args":null,"task":"Implement cost attribution for PROP-047","triggered_by":"operator","routine_id":null,"proposal":"PROP-047","proposal_tag":"[tech-debt]"}
{"timestamp":"$TODAY","session_id":"S-002","model":"sonnet","model_full":"claude-sonnet-4-6","input_tokens":2500,"cache_write_tokens":0,"cache_read_tokens":12000,"output_tokens":500,"total_tokens":15000,"estimated_cost_usd":0.0400,"had_human_turn":false,"skill":"/claude-code-hermit:pulse","skill_args":null,"task":"Implement cost attribution for PROP-047","triggered_by":"operator","routine_id":null,"proposal":"PROP-047","proposal_tag":"[tech-debt]"}
EOF

run_test "cost-aggregator exits 0" bash -c "
  cd '$workdir' && node '$AGG_SCRIPT' >/dev/null 2>&1
"

run_test "skill-cost-profile.json written" bash -c "
  [ -f '$workdir/.claude-code-hermit/state/skill-cost-profile.json' ]
"
run_test "routine-cost-profile.json written" bash -c "
  [ -f '$workdir/.claude-code-hermit/state/routine-cost-profile.json' ]
"
run_test "proposal-cost-profile.json written" bash -c "
  [ -f '$workdir/.claude-code-hermit/state/proposal-cost-profile.json' ]
"
run_test "task-cost-profile.json written" bash -c "
  [ -f '$workdir/.claude-code-hermit/state/task-cost-profile.json' ]
"

run_test "no leftover .tmp files" bash -c "
  count=\$(find '$workdir/.claude-code-hermit/state' -name '*.tmp' | wc -l)
  [ \"\$count\" -eq 0 ]
"

cat > "$workdir/assert-profiles.js" << 'JSEOF'
'use strict';
const fs = require('fs');
const p = '.claude-code-hermit/state';

// --- Skill profile ---
const skill = JSON.parse(fs.readFileSync(p + '/skill-cost-profile.json','utf-8'));
// /claude-code-hermit:pulse appears in 3 rows
const pulse = skill['/claude-code-hermit:pulse'];
if (!pulse) { console.error('pulse entry missing'); process.exit(1); }
if (pulse.invocations !== 3) {
  console.error('pulse invocations: expected 3, got ' + pulse.invocations); process.exit(1);
}
// brief appears once
if (!skill['/claude-code-hermit:brief']) {
  console.error('brief entry missing'); process.exit(1);
}

// --- Routine profile ---
const routine = JSON.parse(fs.readFileSync(p + '/routine-cost-profile.json','utf-8'));
const mb = routine['morning-brief'];
if (!mb) { console.error('morning-brief routine entry missing'); process.exit(1); }
if (mb.invocations !== 2) {
  console.error('morning-brief invocations: expected 2, got ' + mb.invocations); process.exit(1);
}

// --- Proposal profile ---
const proposal = JSON.parse(fs.readFileSync(p + '/proposal-cost-profile.json','utf-8'));
const prop47 = proposal['PROP-047'];
if (!prop47) { console.error('PROP-047 proposal entry missing'); process.exit(1); }
if (prop47.invocations !== 2) {
  console.error('PROP-047 invocations: expected 2, got ' + prop47.invocations); process.exit(1);
}
// session_count should be 1 (both rows from S-002)
if (prop47.session_count !== 1) {
  console.error('PROP-047 session_count: expected 1, got ' + prop47.session_count); process.exit(1);
}

// --- Task profile ---
const task = JSON.parse(fs.readFileSync(p + '/task-cost-profile.json','utf-8'));
const keys = Object.keys(task);
if (keys.length === 0) { console.error('task profile empty'); process.exit(1); }
const taskEntry = task[keys[0]];
if (!taskEntry.last_seen_content || !taskEntry.last_seen_content.includes('PROP-047')) {
  console.error('task content wrong: ' + taskEntry.last_seen_content); process.exit(1);
}
if (taskEntry.invocations !== 2) {
  console.error('task invocations: expected 2, got ' + taskEntry.invocations); process.exit(1);
}

// p95 >= median (sorted order sanity)
if (pulse.p95_cost_usd < pulse.median_cost_usd) {
  console.error('p95 < median'); process.exit(1);
}

console.log('OK');
JSEOF

run_test "profile stats correct" bash -c "
  cd '$workdir' && node assert-profiles.js >/dev/null 2>&1
"

# Verify idempotency: second run overwrites cleanly
run_test "second aggregator run exits 0" bash -c "
  cd '$workdir' && node '$AGG_SCRIPT' >/dev/null 2>&1
"
run_test "no .tmp files after second run" bash -c "
  count=\$(find '$workdir/.claude-code-hermit/state' -name '*.tmp' | wc -l)
  [ \"\$count\" -eq 0 ]
"

cleanup
print_results
