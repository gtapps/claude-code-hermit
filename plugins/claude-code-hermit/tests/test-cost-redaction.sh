#!/usr/bin/env bash
# Tests: skill_args redaction policy is applied before writing to cost-log.jsonl.
# Sensitive flag values (--token=, --password=, --key=, --secret=, --api-key=, --auth=)
# are replaced with ***, and oversized args are truncated.
set -uo pipefail

source "$(dirname "$0")/lib.sh"

SCRIPT="$REPO_ROOT/scripts/cost-tracker.js"

echo "=== test-cost-redaction ==="

workdir="$(setup_workdir)"
echo '{"session_id":"S-redact"}' > "$workdir/.claude-code-hermit/state/runtime.json"

# Write a transcript with the given SlashCommand invocation and 50-token assistant response.
write_transcript() {
  local cmd="$1" outfile="$2"
  printf '%s\n%s\n' \
    "{\"type\":\"human\",\"message\":{\"content\":[{\"type\":\"tool_use\",\"id\":\"tu1\",\"name\":\"SlashCommand\",\"input\":{\"command\":\"$cmd\"}}]}}" \
    '{"type":"assistant","message":{"model":"claude-sonnet-4-6","content":[{"type":"text","text":"Done."}],"usage":{"input_tokens":100,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":50}}}' \
    > "$outfile"
}

# ── Test 1: --token=<value> is redacted ──────────────────────────────────────
write_transcript "/claude-code-hermit:some-skill --token=mysecret123" \
  "$workdir/.claude/t1.jsonl"

run_test "tracker exits 0 for token flag" bash -c "
  cd '$workdir'
  printf '%s' '{\"session_id\":\"S-redact\",\"transcript_path\":\".claude/t1.jsonl\"}' \
    | node '$SCRIPT' >/dev/null 2>&1
"

run_test "--token= value is redacted to ***" bash -c "
  node -e \"
    const lines = require('fs').readFileSync('$workdir/.claude/cost-log.jsonl','utf-8').trim().split('\\\\n').filter(Boolean);
    const r = JSON.parse(lines[lines.length-1]);
    if (!r.skill_args || r.skill_args.includes('mysecret123')) {
      console.error('Not redacted: ' + r.skill_args); process.exit(1);
    }
    if (!r.skill_args.includes('***')) {
      console.error('Missing ***: ' + r.skill_args); process.exit(1);
    }
  \" 2>&1
"

# ── Test 2: --password=<value> is redacted but safe args kept ────────────────
write_transcript "/claude-code-hermit:deploy --password=hunter2 --env=prod" \
  "$workdir/.claude/t2.jsonl"

run_test "tracker exits 0 for password flag" bash -c "
  cd '$workdir'
  printf '%s' '{\"session_id\":\"S-redact\",\"transcript_path\":\".claude/t2.jsonl\"}' \
    | node '$SCRIPT' >/dev/null 2>&1
"

run_test "--password= value redacted, safe args kept" bash -c "
  node -e \"
    const lines = require('fs').readFileSync('$workdir/.claude/cost-log.jsonl','utf-8').trim().split('\\\\n').filter(Boolean);
    const r = JSON.parse(lines[lines.length-1]);
    if (!r.skill_args || r.skill_args.includes('hunter2')) {
      console.error('Not redacted: ' + r.skill_args); process.exit(1);
    }
    if (!r.skill_args.includes('--env=prod')) {
      console.error('Safe arg stripped: ' + r.skill_args); process.exit(1);
    }
  \" 2>&1
"

# ── Test 3: --api-key= is redacted ───────────────────────────────────────────
write_transcript "/claude-code-hermit:call --api-key=sk-abc123 --model=opus" \
  "$workdir/.claude/t3.jsonl"

run_test "tracker exits 0 for api-key flag" bash -c "
  cd '$workdir'
  printf '%s' '{\"session_id\":\"S-redact\",\"transcript_path\":\".claude/t3.jsonl\"}' \
    | node '$SCRIPT' >/dev/null 2>&1
"

run_test "--api-key= value is redacted" bash -c "
  node -e \"
    const lines = require('fs').readFileSync('$workdir/.claude/cost-log.jsonl','utf-8').trim().split('\\\\n').filter(Boolean);
    const r = JSON.parse(lines[lines.length-1]);
    if (!r.skill_args || r.skill_args.includes('sk-abc123')) {
      console.error('Not redacted: ' + r.skill_args); process.exit(1);
    }
  \" 2>&1
"

# ── Test 4: Oversized single arg is truncated ─────────────────────────────────
LONG_ARG="$(python3 -c "print('x' * 250, end='')")"
write_transcript "/claude-code-hermit:ingest $LONG_ARG" "$workdir/.claude/t4.jsonl"

run_test "tracker exits 0 for oversized arg" bash -c "
  cd '$workdir'
  printf '%s' '{\"session_id\":\"S-redact\",\"transcript_path\":\".claude/t4.jsonl\"}' \
    | node '$SCRIPT' >/dev/null 2>&1
"

run_test "oversized single arg truncated to <arg:N-chars>" bash -c "
  node -e \"
    const lines = require('fs').readFileSync('$workdir/.claude/cost-log.jsonl','utf-8').trim().split('\\\\n').filter(Boolean);
    const r = JSON.parse(lines[lines.length-1]);
    if (!r.skill_args || !r.skill_args.startsWith('<arg:')) {
      console.error('Not truncated: ' + String(r.skill_args).substring(0,40)); process.exit(1);
    }
  \" 2>&1
"

# ── Test 5: Total args over 500 chars → whole field replaced ─────────────────
LONG_ARGS="$(python3 -c "print(' '.join(['--opt' + str(i) + '=val' + str(i) for i in range(60)]), end='')")"
write_transcript "/claude-code-hermit:mega $LONG_ARGS" "$workdir/.claude/t5.jsonl"

run_test "tracker exits 0 for very long args" bash -c "
  cd '$workdir'
  printf '%s' '{\"session_id\":\"S-redact\",\"transcript_path\":\".claude/t5.jsonl\"}' \
    | node '$SCRIPT' >/dev/null 2>&1
"

run_test "args > 500 chars replaced with <args:N-chars-redacted>" bash -c "
  node -e \"
    const lines = require('fs').readFileSync('$workdir/.claude/cost-log.jsonl','utf-8').trim().split('\\\\n').filter(Boolean);
    const r = JSON.parse(lines[lines.length-1]);
    if (!r.skill_args || !r.skill_args.startsWith('<args:')) {
      console.error('Not replaced: ' + String(r.skill_args).substring(0,40)); process.exit(1);
    }
    if (!r.skill_args.endsWith('-chars-redacted>')) {
      console.error('Wrong format: ' + r.skill_args); process.exit(1);
    }
  \" 2>&1
"

# ── Test 6: Safe args are passed through unchanged ────────────────────────────
write_transcript "/claude-code-hermit:pulse --verbose --format=json" "$workdir/.claude/t6.jsonl"

run_test "tracker exits 0 for safe args" bash -c "
  cd '$workdir'
  printf '%s' '{\"session_id\":\"S-redact\",\"transcript_path\":\".claude/t6.jsonl\"}' \
    | node '$SCRIPT' >/dev/null 2>&1
"

run_test "safe args pass through unchanged" bash -c "
  node -e \"
    const lines = require('fs').readFileSync('$workdir/.claude/cost-log.jsonl','utf-8').trim().split('\\\\n').filter(Boolean);
    const r = JSON.parse(lines[lines.length-1]);
    if (r.skill_args !== '--verbose --format=json') {
      console.error('Args changed: ' + r.skill_args); process.exit(1);
    }
  \" 2>&1
"

cleanup
print_results
