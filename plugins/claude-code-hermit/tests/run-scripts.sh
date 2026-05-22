#!/usr/bin/env bash
# Tests for standalone scripts and static file contracts.
# These are scripts called by hooks or the CLI, but not themselves hooks.
# Usage: bash tests/run-scripts.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/lib.sh"

echo "=== Script & Static Tests ==="
echo ""

# -------------------------------------------------------
# check-upgrade.sh
# -------------------------------------------------------

# 1. check-upgrade.sh — reports when plugin version is behind
workdir="$(setup_workdir)"
cd "$workdir"
echo '{"_hermit_versions":{"claude-code-hermit":"0.0.0"}}' > "$workdir/.claude-code-hermit/config.json"
upgrade_out="$(bash "$REPO_ROOT/scripts/check-upgrade.sh" "$REPO_ROOT" 2>&1)" || true
run_test "check-upgrade.sh" bash -c "[ -n '$upgrade_out' ]"
run_test "check-upgrade output" bash -c "echo '$upgrade_out' | grep -qF -- '---Upgrade Available---'"
cleanup

# -------------------------------------------------------
# Static file checks
# -------------------------------------------------------

# 2. deny-patterns.json — valid JSON with expected structure
run_test "deny-patterns.json" bash -c \
  "python3 -c \"import json; d=json.load(open('$REPO_ROOT/state-templates/deny-patterns.json')); denyRead=d.get('sandbox',{}).get('filesystem',{}).get('denyRead',[]); assert isinstance(d.get('default'),list) and isinstance(d.get('always_on'),list) and isinstance(denyRead,list) and len(denyRead)>0\""

# 3. Bin scripts are executable
run_test "bin scripts executable" bash -c \
  "for f in '$REPO_ROOT/state-templates/bin/'*; do [ -x \"\$f\" ] || exit 1; done"

# -------------------------------------------------------
# sanitize.js — safeForLLM
# -------------------------------------------------------

SANITIZE_LIB="$REPO_ROOT/scripts/lib/sanitize.js"

run_test "safeForLLM: strips <system-reminder>" bash -c \
  "node -e \"const {safeForLLM}=require('$SANITIZE_LIB'); const r=safeForLLM('<system-reminder>inject</system-reminder>'); process.exit(r.includes('<system-reminder>') ? 1 : 0)\""

run_test "safeForLLM: strips </system>" bash -c \
  "node -e \"const {safeForLLM}=require('$SANITIZE_LIB'); const r=safeForLLM('</system>'); process.exit(r.includes('<') ? 1 : 0)\""

run_test "safeForLLM: strips <assistant>, <user>, <thinking>" bash -c \
  "node -e \"const {safeForLLM}=require('$SANITIZE_LIB'); const r=safeForLLM('<assistant>x</assistant><user>y</user><thinking>z</thinking>'); process.exit(r.includes('<assistant>') || r.includes('<user>') || r.includes('<thinking>') ? 1 : 0)\""

run_test "safeForLLM: strips <tool_use>, <tool_result>, <function_calls>" bash -c \
  "node -e \"const {safeForLLM}=require('$SANITIZE_LIB'); const r=safeForLLM('<tool_use/><tool_result/><function_calls/>'); process.exit(r.includes('<tool_use') || r.includes('<tool_result') || r.includes('<function_calls') ? 1 : 0)\""

run_test "safeForLLM: strips tags with attributes" bash -c \
  "node -e \"const {safeForLLM}=require('$SANITIZE_LIB'); const r=safeForLLM('<system class=\"x\">inject</system>'); process.exit(r.includes('<system') ? 1 : 0)\""

run_test "safeForLLM: bracket-wraps stripped tags (readable)" bash -c \
  "node -e \"const {safeForLLM}=require('$SANITIZE_LIB'); const r=safeForLLM('<system-reminder>x</system-reminder>'); process.exit(r.includes('[system-reminder]') && r.includes('[/system-reminder]') ? 0 : 1)\""

run_test "safeForLLM: preserves non-injection text" bash -c \
  "node -e \"const {safeForLLM}=require('$SANITIZE_LIB'); const r=safeForLLM('normal error text'); process.exit(r === 'normal error text' ? 0 : 1)\""

run_test "safeForLLM: preserves non-injection angle brackets (3 < 5)" bash -c \
  "node -e \"const {safeForLLM}=require('$SANITIZE_LIB'); const r=safeForLLM('3 < 5'); process.exit(r === '3 < 5' ? 0 : 1)\""

run_test "safeForLLM: preserves unknown tags (<foo>)" bash -c \
  "node -e \"const {safeForLLM}=require('$SANITIZE_LIB'); const r=safeForLLM('<foo>bar</foo>'); process.exit(r === '<foo>bar</foo>' ? 0 : 1)\""

run_test "safeForLLM: inherits control-char stripping from safe()" bash -c \
  "node -e \"const {safeForLLM}=require('$SANITIZE_LIB'); const r=safeForLLM('\x1b[31mred\x1b[0m'); process.exit(r.includes('\x1b') ? 1 : 0)\""

run_test "safeForLLM: case-insensitive (<System-Reminder>)" bash -c \
  "node -e \"const {safeForLLM}=require('$SANITIZE_LIB'); const r=safeForLLM('<System-Reminder>x</System-Reminder>'); process.exit(r.includes('<System-Reminder>') || r.includes('</System-Reminder>') ? 1 : 0)\""

# -------------------------------------------------------
# knowledge-lint.js
# -------------------------------------------------------

# 4. Empty state — no raw/, no compiled/
workdir="$(setup_workdir)"
echo '{}' > "$workdir/.claude-code-hermit/config.json"
run_test "knowledge-lint (empty state)" bash -c \
  "node '$REPO_ROOT/scripts/knowledge-lint.js' '$workdir/.claude-code-hermit' | grep -q 'Knowledge base is clean'"
cleanup

# 5. Findings: stale, unreferenced, oversized, missing-type
workdir="$(setup_workdir)"
mkdir -p "$workdir/.claude-code-hermit/raw" "$workdir/.claude-code-hermit/compiled"
echo '{}' > "$workdir/.claude-code-hermit/config.json"
printf -- '---\ntitle: old\ncreated: 2025-01-01T00:00:00+00:00\n---\ndata' \
  > "$workdir/.claude-code-hermit/raw/old-snap.md"
printf -- '---\ntitle: no type\ncreated: 2026-04-01T00:00:00+00:00\n---\nshort' \
  > "$workdir/.claude-code-hermit/compiled/note.md"
printf -- '---\ntitle: big\ntype: briefing\ncreated: 2026-04-10T00:00:00+00:00\n---\n%s' \
  "$(python3 -c "print('x' * 1500)")" \
  > "$workdir/.claude-code-hermit/compiled/big.md"
outfile="$(mktemp)"
node "$REPO_ROOT/scripts/knowledge-lint.js" "$workdir/.claude-code-hermit" > "$outfile" 2>&1
run_test "knowledge-lint (finds unreferenced or stale)" grep -qE 'unreferenced|stale' "$outfile"
run_test "knowledge-lint (finds stale)" grep -q 'stale' "$outfile"
run_test "knowledge-lint (finds oversized)" grep -q 'oversized' "$outfile"
run_test "knowledge-lint (finds missing-type)" grep -q 'missing-type' "$outfile"
rm -f "$outfile"
cleanup

# 6. Clean state — valid files with matching schema, no findings
workdir="$(setup_workdir)"
mkdir -p "$workdir/.claude-code-hermit/raw" "$workdir/.claude-code-hermit/compiled"
echo '{}' > "$workdir/.claude-code-hermit/config.json"
printf -- '## Work Products\n- briefing: daily summary\n\n## Raw Captures\n- source: fetched articles\n' \
  > "$workdir/.claude-code-hermit/knowledge-schema.md"
printf -- '---\ntitle: fresh\ntype: source\ncreated: 2026-04-14T00:00:00+00:00\n---\ndata' \
  > "$workdir/.claude-code-hermit/raw/fresh-snap.md"
printf -- '---\ntitle: summary\ntype: briefing\ncreated: 2026-04-14T00:00:00+00:00\n---\nBased on fresh-snap.md data' \
  > "$workdir/.claude-code-hermit/compiled/summary.md"
run_test "knowledge-lint (clean state)" bash -c \
  "node '$REPO_ROOT/scripts/knowledge-lint.js' '$workdir/.claude-code-hermit' | grep -q 'Knowledge base is clean'"
cleanup

# 6a. Schema-empty finding — template-style schema (all bullets commented) emits schema-empty without --verbose
workdir="$(setup_workdir)"
mkdir -p "$workdir/.claude-code-hermit/raw" "$workdir/.claude-code-hermit/compiled"
echo '{}' > "$workdir/.claude-code-hermit/config.json"
# Add a raw artifact so the schema-presence guard fires
printf -- '---\ntitle: snap\ncreated: 2026-04-22T00:00:00+00:00\n---\ndata' \
  > "$workdir/.claude-code-hermit/raw/snap.md"
# Copy the real template (all bullets inside HTML comments) so parseSchema returns null
cp "$REPO_ROOT/state-templates/knowledge-schema.md.template" "$workdir/.claude-code-hermit/knowledge-schema.md"
# Remove the starter bullets we just added to simulate a pre-upgrade all-comments schema
sed -i '/^- note:/d; /^- input:/d; /^- review:/d' "$workdir/.claude-code-hermit/knowledge-schema.md"
outfile="$(mktemp)"
node "$REPO_ROOT/scripts/knowledge-lint.js" "$workdir/.claude-code-hermit" > "$outfile" 2>&1 || true
run_test "knowledge-lint (schema-empty emitted without --verbose)" grep -q 'schema-empty' "$outfile"
rm -f "$outfile"
cleanup

# 6b. Schema enforcement — undeclared type emits warning; declared+matching type is clean
workdir="$(setup_workdir)"
mkdir -p "$workdir/.claude-code-hermit/raw" "$workdir/.claude-code-hermit/compiled"
echo '{}' > "$workdir/.claude-code-hermit/config.json"
# Schema declares 'briefing'; compiled file uses undeclared 'foo'
printf -- '## Work Products\n- briefing: daily summary\n\n## Raw Captures\n- source: fetched articles\n' \
  > "$workdir/.claude-code-hermit/knowledge-schema.md"
printf -- '---\ntitle: unknown\ntype: foo\ncreated: 2026-04-14T00:00:00+00:00\n---\ndata' \
  > "$workdir/.claude-code-hermit/compiled/unknown.md"
outfile="$(mktemp)"
node "$REPO_ROOT/scripts/knowledge-lint.js" "$workdir/.claude-code-hermit" > "$outfile" 2>&1
run_test "knowledge-lint (schema: undeclared type warned)" grep -q 'undeclared-type' "$outfile"
rm -f "$outfile"
# Matching type: schema has 'briefing', file has type: briefing — no undeclared-type
printf -- '---\ntitle: summary\ntype: briefing\ncreated: 2026-04-14T00:00:00+00:00\n---\ndata' \
  > "$workdir/.claude-code-hermit/compiled/unknown.md"
run_test "knowledge-lint (schema: declared type is clean)" bash -c \
  "node '$REPO_ROOT/scripts/knowledge-lint.js' '$workdir/.claude-code-hermit' | grep -q 'Knowledge base is clean'"
cleanup

# -------------------------------------------------------
# update-reflection-state.js
# -------------------------------------------------------

# 7. Fresh state file — initializes counters from scratch
workdir="$(setup_workdir)"
echo '{"last_reflection":null}' > "$workdir/.claude-code-hermit/state/reflection-state.json"
node "$REPO_ROOT/scripts/update-reflection-state.js" \
  "$workdir/.claude-code-hermit/state/reflection-state.json" \
  '{"ran_with_candidates":true,"judge_accept":2,"proposals_created":1}' >/dev/null
run_test "update-reflection-state (initializes counters)" bash -c \
  "python3 -c \"import json; d=json.load(open('$workdir/.claude-code-hermit/state/reflection-state.json')); c=d['counters']; assert c['total_runs']==1 and c['runs_with_candidates']==1 and c['empty_runs']==0 and c['judge_accept']==2 and c['proposals_created']==1 and c['last_output_at'] is not None\""
cleanup

# 8. Empty run — increments empty_runs, leaves last_output_at null, preserves other keys
workdir="$(setup_workdir)"
echo '{"scheduled_checks":{"md-audit":{"last_run":"2026-04-01"}},"counters":{"total_runs":5,"empty_runs":2,"runs_with_candidates":3,"last_output_at":null}}' \
  > "$workdir/.claude-code-hermit/state/reflection-state.json"
node "$REPO_ROOT/scripts/update-reflection-state.js" \
  "$workdir/.claude-code-hermit/state/reflection-state.json" \
  '{"ran_with_candidates":false}' >/dev/null
run_test "update-reflection-state (empty run, preserves other keys)" bash -c \
  "python3 -c \"import json; d=json.load(open('$workdir/.claude-code-hermit/state/reflection-state.json')); c=d['counters']; assert c['total_runs']==6 and c['empty_runs']==3 and c['runs_with_candidates']==3 and c['last_output_at'] is None and d['scheduled_checks']['md-audit']['last_run']=='2026-04-01'\""
cleanup

# 9. Missing counters object — treated as all-zero, seeds counters with since key
workdir="$(setup_workdir)"
echo '{"last_reflection":"2026-04-01T00:00:00Z"}' > "$workdir/.claude-code-hermit/state/reflection-state.json"
node "$REPO_ROOT/scripts/update-reflection-state.js" \
  "$workdir/.claude-code-hermit/state/reflection-state.json" \
  '{"ran_with_candidates":true,"micro_proposals_queued":1}' >/dev/null
run_test "update-reflection-state (missing counters object)" bash -c \
  "python3 -c \"import json; d=json.load(open('$workdir/.claude-code-hermit/state/reflection-state.json')); c=d['counters']; assert c['total_runs']==1 and c['micro_proposals_queued']==1 and c['last_output_at'] is not None and 'since' in c\""
cleanup

# 10. Missing state file — fail-open: exits 0 and writes valid JSON
workdir="$(setup_workdir)"
node "$REPO_ROOT/scripts/update-reflection-state.js" \
  "$workdir/.claude-code-hermit/state/reflection-state.json" \
  '{"ran_with_candidates":false}' >/dev/null
run_test "update-reflection-state (missing state file, fail-open)" bash -c \
  "python3 -c \"import json; d=json.load(open('$workdir/.claude-code-hermit/state/reflection-state.json')); assert d['counters']['total_runs']==1\""
cleanup

# 11. last_sparse_nudge — new entry is merged, existing entries preserved
workdir="$(setup_workdir)"
echo '{"last_sparse_nudge":{"PROP-001":"2026-04-01T00:00:00Z"},"counters":{"total_runs":1}}' \
  > "$workdir/.claude-code-hermit/state/reflection-state.json"
node "$REPO_ROOT/scripts/update-reflection-state.js" \
  "$workdir/.claude-code-hermit/state/reflection-state.json" \
  '{"ran_with_candidates":false,"last_sparse_nudge":{"PROP-002":"2026-04-22T00:00:00Z"}}' >/dev/null
run_test "update-reflection-state (last_sparse_nudge merge)" bash -c \
  "python3 -c \"import json; d=json.load(open('$workdir/.claude-code-hermit/state/reflection-state.json')); n=d['last_sparse_nudge']; assert n['PROP-001']=='2026-04-01T00:00:00Z' and n['PROP-002']=='2026-04-22T00:00:00Z'\""
cleanup

# -------------------------------------------------------
# heartbeat-precheck.js
# -------------------------------------------------------

# 12. SKIP — HEARTBEAT.md missing
workdir="$(setup_workdir)"
echo '{"timezone":"UTC","heartbeat":{"active_hours":{"start":"00:00","end":"23:59"}}}' \
  > "$workdir/.claude-code-hermit/config.json"
echo '{"alerts":{},"last_digest_date":null,"self_eval":{},"total_ticks":0}' \
  > "$workdir/.claude-code-hermit/state/alert-state.json"
echo '{"session_state":"idle"}' > "$workdir/.claude-code-hermit/state/runtime.json"
echo '{"pending":[]}' > "$workdir/.claude-code-hermit/state/micro-proposals.json"
out="$(node "$REPO_ROOT/scripts/heartbeat-precheck.js" "$workdir/.claude-code-hermit")"
run_test "heartbeat-precheck (SKIP: missing HEARTBEAT.md)" bash -c "echo '$out' | grep -qE '^SKIP\|'"
cleanup

# 13. SKIP — empty HEARTBEAT.md (no checklist items)
workdir="$(setup_workdir)"
echo '{"timezone":"UTC","heartbeat":{"active_hours":{"start":"00:00","end":"23:59"}}}' \
  > "$workdir/.claude-code-hermit/config.json"
echo '{"alerts":{},"last_digest_date":null,"self_eval":{},"total_ticks":0}' \
  > "$workdir/.claude-code-hermit/state/alert-state.json"
echo '{"session_state":"idle"}' > "$workdir/.claude-code-hermit/state/runtime.json"
echo '{"pending":[]}' > "$workdir/.claude-code-hermit/state/micro-proposals.json"
printf '# Heartbeat Checklist\n<!-- no items -->\n' > "$workdir/.claude-code-hermit/HEARTBEAT.md"
out="$(node "$REPO_ROOT/scripts/heartbeat-precheck.js" "$workdir/.claude-code-hermit")"
run_test "heartbeat-precheck (SKIP: empty HEARTBEAT.md)" bash -c "echo '$out' | grep -qE '^SKIP\|'"
cleanup

# 14. SKIP — outside active hours (window 00:00–00:01, always past it)
workdir="$(setup_workdir)"
echo '{"timezone":"UTC","heartbeat":{"active_hours":{"start":"00:00","end":"00:01"}}}' \
  > "$workdir/.claude-code-hermit/config.json"
echo '{"alerts":{},"last_digest_date":null,"self_eval":{},"total_ticks":0}' \
  > "$workdir/.claude-code-hermit/state/alert-state.json"
echo '{"session_state":"idle"}' > "$workdir/.claude-code-hermit/state/runtime.json"
echo '{"pending":[]}' > "$workdir/.claude-code-hermit/state/micro-proposals.json"
printf '# Heartbeat\n- Check something\n' > "$workdir/.claude-code-hermit/HEARTBEAT.md"
out="$(node "$REPO_ROOT/scripts/heartbeat-precheck.js" "$workdir/.claude-code-hermit")"
run_test "heartbeat-precheck (SKIP: outside active hours)" bash -c "echo '$out' | grep -qE '^SKIP\|'"
cleanup

# 15. EVALUATE — no alert entry for checklist item
workdir="$(setup_workdir)"
echo '{"timezone":"UTC","heartbeat":{"active_hours":{"start":"00:00","end":"23:59"}}}' \
  > "$workdir/.claude-code-hermit/config.json"
echo '{"alerts":{},"last_digest_date":null,"self_eval":{},"total_ticks":0}' \
  > "$workdir/.claude-code-hermit/state/alert-state.json"
echo '{"session_state":"idle"}' > "$workdir/.claude-code-hermit/state/runtime.json"
echo '{"pending":[]}' > "$workdir/.claude-code-hermit/state/micro-proposals.json"
printf '# Heartbeat\n- Review proposals/ for any needing attention\n' \
  > "$workdir/.claude-code-hermit/HEARTBEAT.md"
out="$(node "$REPO_ROOT/scripts/heartbeat-precheck.js" "$workdir/.claude-code-hermit")"
run_test "heartbeat-precheck (EVALUATE: item not in alerts)" bash -c "[ '$out' = 'EVALUATE' ]"
cleanup

# 16. EVALUATE — pending tier-1 micro-proposal
workdir="$(setup_workdir)"
echo '{"timezone":"UTC","heartbeat":{"active_hours":{"start":"00:00","end":"23:59"}}}' \
  > "$workdir/.claude-code-hermit/config.json"
echo '{"alerts":{},"last_digest_date":null,"self_eval":{},"total_ticks":0}' \
  > "$workdir/.claude-code-hermit/state/alert-state.json"
echo '{"session_state":"idle"}' > "$workdir/.claude-code-hermit/state/runtime.json"
echo '{"pending":[{"id":"MP-001","tier":1,"status":"pending","question":"Do X?"}]}' \
  > "$workdir/.claude-code-hermit/state/micro-proposals.json"
printf '# Heartbeat\n- Review proposals/ for any needing attention\n' \
  > "$workdir/.claude-code-hermit/HEARTBEAT.md"
out="$(node "$REPO_ROOT/scripts/heartbeat-precheck.js" "$workdir/.claude-code-hermit")"
run_test "heartbeat-precheck (EVALUATE: tier-1 micro-proposal pending)" bash -c "[ '$out' = 'EVALUATE' ]"
cleanup

# 17. EVALUATE — session in_progress
workdir="$(setup_workdir)"
echo '{"timezone":"UTC","heartbeat":{"active_hours":{"start":"00:00","end":"23:59"}}}' \
  > "$workdir/.claude-code-hermit/config.json"
echo '{"alerts":{},"last_digest_date":null,"self_eval":{},"total_ticks":0}' \
  > "$workdir/.claude-code-hermit/state/alert-state.json"
echo '{"session_state":"in_progress"}' > "$workdir/.claude-code-hermit/state/runtime.json"
echo '{"pending":[]}' > "$workdir/.claude-code-hermit/state/micro-proposals.json"
printf '# Heartbeat\n- Review proposals/ for any needing attention\n' \
  > "$workdir/.claude-code-hermit/HEARTBEAT.md"
out="$(node "$REPO_ROOT/scripts/heartbeat-precheck.js" "$workdir/.claude-code-hermit")"
run_test "heartbeat-precheck (EVALUATE: session in_progress)" bash -c "[ '$out' = 'EVALUATE' ]"
cleanup

# 18. EVALUATE — self-eval due (tick 20)
workdir="$(setup_workdir)"
echo '{"timezone":"UTC","heartbeat":{"active_hours":{"start":"00:00","end":"23:59"}}}' \
  > "$workdir/.claude-code-hermit/config.json"
echo '{"alerts":{},"last_digest_date":null,"self_eval":{},"total_ticks":19}' \
  > "$workdir/.claude-code-hermit/state/alert-state.json"
echo '{"session_state":"idle"}' > "$workdir/.claude-code-hermit/state/runtime.json"
echo '{"pending":[]}' > "$workdir/.claude-code-hermit/state/micro-proposals.json"
printf '# Heartbeat\n- Review proposals/ for any needing attention\n' \
  > "$workdir/.claude-code-hermit/HEARTBEAT.md"
out="$(node "$REPO_ROOT/scripts/heartbeat-precheck.js" "$workdir/.claude-code-hermit")"
run_test "heartbeat-precheck (EVALUATE: self-eval due at tick 20)" bash -c "[ '$out' = 'EVALUATE' ]"
cleanup

# 19. OK — all items suppressed and stable, structural checks clear
workdir="$(setup_workdir)"
echo '{"timezone":"UTC","heartbeat":{"active_hours":{"start":"00:00","end":"23:59"}}}' \
  > "$workdir/.claude-code-hermit/config.json"
echo '{"alerts":{"checklist:reviewpr":{"count":6,"suppressed":true,"consecutive_clean":0,"first_seen":"2026-04-01","last_seen":"2026-04-28","text":"Review proposals"}},"last_digest_date":"'$(date -u +%Y-%m-%d)'","self_eval":{},"total_ticks":5}' \
  > "$workdir/.claude-code-hermit/state/alert-state.json"
echo '{"session_state":"idle"}' > "$workdir/.claude-code-hermit/state/runtime.json"
echo '{"pending":[]}' > "$workdir/.claude-code-hermit/state/micro-proposals.json"
printf '# Heartbeat\n- Review proposals/ for any needing attention\n' \
  > "$workdir/.claude-code-hermit/HEARTBEAT.md"
out="$(node "$REPO_ROOT/scripts/heartbeat-precheck.js" "$workdir/.claude-code-hermit")"
run_test "heartbeat-precheck (OK: all items suppressed and stable)" bash -c "[ '$out' = 'OK' ]"
cleanup

# 20. total_ticks incremented exactly once; alerts{} and self_eval{} untouched by precheck
workdir="$(setup_workdir)"
echo '{"timezone":"UTC","heartbeat":{"active_hours":{"start":"00:00","end":"23:59"}}}' \
  > "$workdir/.claude-code-hermit/config.json"
echo '{"alerts":{"checklist:reviewpr":{"count":6,"suppressed":true,"consecutive_clean":0}},"last_digest_date":"'$(date -u +%Y-%m-%d)'","self_eval":{"mykey":{"clean_ticks":5}},"total_ticks":3}' \
  > "$workdir/.claude-code-hermit/state/alert-state.json"
echo '{"session_state":"idle"}' > "$workdir/.claude-code-hermit/state/runtime.json"
echo '{"pending":[]}' > "$workdir/.claude-code-hermit/state/micro-proposals.json"
printf '# Heartbeat\n- Review proposals/ for any needing attention\n' \
  > "$workdir/.claude-code-hermit/HEARTBEAT.md"
node "$REPO_ROOT/scripts/heartbeat-precheck.js" "$workdir/.claude-code-hermit" >/dev/null
run_test "heartbeat-precheck (total_ticks incremented once)" bash -c \
  "python3 -c \"import json; d=json.load(open('$workdir/.claude-code-hermit/state/alert-state.json')); assert d['total_ticks']==4\""
run_test "heartbeat-precheck (alerts{} not mutated by precheck)" bash -c \
  "python3 -c \"import json; d=json.load(open('$workdir/.claude-code-hermit/state/alert-state.json')); assert d['alerts']['checklist:reviewpr']['count']==6\""
run_test "heartbeat-precheck (self_eval{} not mutated by precheck)" bash -c \
  "python3 -c \"import json; d=json.load(open('$workdir/.claude-code-hermit/state/alert-state.json')); assert d['self_eval']['mykey']['clean_ticks']==5\""
cleanup

# -------------------------------------------------------
# reflect-precheck.js
# -------------------------------------------------------

# 21. EMPTY — all timestamps recent, session idle, no accepted proposals
workdir="$(setup_workdir)"
echo '{"timezone":"UTC"}' > "$workdir/.claude-code-hermit/config.json"
echo '{"session_state":"idle"}' > "$workdir/.claude-code-hermit/state/runtime.json"
mkdir -p "$workdir/.claude-code-hermit/proposals"
today="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "{\"last_reflection\":\"$today\",\"last_resolution_check\":null,\"last_digest_at\":\"$today\",\"counters\":{\"total_runs\":5,\"empty_runs\":2,\"runs_with_candidates\":3,\"last_run_at\":\"$today\",\"since\":\"$(python3 -c "import datetime; print((datetime.datetime.now(datetime.timezone.utc)-datetime.timedelta(days=30)).strftime('%Y-%m-%dT%H:%M:%SZ'))")\"}}" \
  > "$workdir/.claude-code-hermit/state/reflection-state.json"
mkdir -p "$workdir/.claude"
# No cost log, no session reports newer than last_run_at
out="$(node "$REPO_ROOT/scripts/reflect-precheck.js" "$workdir/.claude-code-hermit" "$REPO_ROOT")"
run_test "reflect-precheck (EMPTY: no due phases)" bash -c "[ '$out' = 'EMPTY' ]"
cleanup

# 22. EMPTY path: progress log line appended to SHELL.md
workdir="$(setup_workdir)"
echo '{"timezone":"UTC"}' > "$workdir/.claude-code-hermit/config.json"
echo '{"session_state":"idle"}' > "$workdir/.claude-code-hermit/state/runtime.json"
mkdir -p "$workdir/.claude-code-hermit/proposals"
today="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "{\"last_reflection\":\"$today\",\"counters\":{\"total_runs\":1,\"empty_runs\":0,\"last_run_at\":\"$today\",\"since\":\"$(python3 -c "import datetime; print((datetime.datetime.now(datetime.timezone.utc)-datetime.timedelta(days=30)).strftime('%Y-%m-%dT%H:%M:%SZ'))")\"}}" \
  > "$workdir/.claude-code-hermit/state/reflection-state.json"
mkdir -p "$workdir/.claude"
node "$REPO_ROOT/scripts/reflect-precheck.js" "$workdir/.claude-code-hermit" "$REPO_ROOT" >/dev/null
run_test "reflect-precheck (EMPTY: progress log line written to SHELL.md)" bash -c \
  "grep -q 'reflect' '$workdir/.claude-code-hermit/sessions/SHELL.md'"
cleanup

# 23. EMPTY path: empty_runs incremented in reflection-state.json
workdir="$(setup_workdir)"
echo '{"timezone":"UTC"}' > "$workdir/.claude-code-hermit/config.json"
echo '{"session_state":"idle"}' > "$workdir/.claude-code-hermit/state/runtime.json"
mkdir -p "$workdir/.claude-code-hermit/proposals"
today="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "{\"counters\":{\"total_runs\":3,\"empty_runs\":1,\"runs_with_candidates\":2,\"last_run_at\":\"$today\",\"since\":\"$(python3 -c "import datetime; print((datetime.datetime.now(datetime.timezone.utc)-datetime.timedelta(days=30)).strftime('%Y-%m-%dT%H:%M:%SZ'))")\"}}" \
  > "$workdir/.claude-code-hermit/state/reflection-state.json"
mkdir -p "$workdir/.claude"
node "$REPO_ROOT/scripts/reflect-precheck.js" "$workdir/.claude-code-hermit" "$REPO_ROOT" >/dev/null
run_test "reflect-precheck (EMPTY: empty_runs incremented)" bash -c \
  "python3 -c \"import json; d=json.load(open('$workdir/.claude-code-hermit/state/reflection-state.json')); assert d['counters']['empty_runs']==2 and d['counters']['total_runs']==4\""
cleanup

# 24. RUN — resolution_check due (accepted proposal + last_resolution_check > 7 days)
workdir="$(setup_workdir)"
echo '{"timezone":"UTC"}' > "$workdir/.claude-code-hermit/config.json"
echo '{"session_state":"idle"}' > "$workdir/.claude-code-hermit/state/runtime.json"
mkdir -p "$workdir/.claude-code-hermit/proposals"
printf -- '---\nstatus: accepted\naccepted_date: 2026-04-01\ntitle: Test\n---\nBody\n' \
  > "$workdir/.claude-code-hermit/proposals/PROP-001.md"
today="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
old_date="2026-04-01T00:00:00Z"
echo "{\"counters\":{\"total_runs\":5,\"empty_runs\":2,\"last_run_at\":\"$today\",\"since\":\"$(python3 -c "import datetime; print((datetime.datetime.now(datetime.timezone.utc)-datetime.timedelta(days=30)).strftime('%Y-%m-%dT%H:%M:%SZ'))")\"},\"last_resolution_check\":\"$old_date\"}" \
  > "$workdir/.claude-code-hermit/state/reflection-state.json"
mkdir -p "$workdir/.claude"
out="$(node "$REPO_ROOT/scripts/reflect-precheck.js" "$workdir/.claude-code-hermit" "$REPO_ROOT")"
run_test "reflect-precheck (RUN: resolution_check due)" bash -c "echo '$out' | grep -q 'resolution_check'"
cleanup

# 24b. RUN — resolution_check due via new-format proposal filename (PROP-NNN-slug-HHMMSS.md)
workdir="$(setup_workdir)"
echo '{"timezone":"UTC"}' > "$workdir/.claude-code-hermit/config.json"
echo '{"session_state":"idle"}' > "$workdir/.claude-code-hermit/state/runtime.json"
mkdir -p "$workdir/.claude-code-hermit/proposals"
printf -- '---\nid: PROP-002-test-new-format-103612\nstatus: accepted\naccepted_date: 2026-04-01\ntitle: Test new format\n---\nBody\n' \
  > "$workdir/.claude-code-hermit/proposals/PROP-002-test-new-format-103612.md"
today="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
old_date="2026-04-01T00:00:00Z"
echo "{\"counters\":{\"total_runs\":5,\"empty_runs\":2,\"last_run_at\":\"$today\",\"since\":\"$(python3 -c "import datetime; print((datetime.datetime.now(datetime.timezone.utc)-datetime.timedelta(days=30)).strftime('%Y-%m-%dT%H:%M:%SZ'))")\"},\"last_resolution_check\":\"$old_date\"}" \
  > "$workdir/.claude-code-hermit/state/reflection-state.json"
mkdir -p "$workdir/.claude"
out="$(node "$REPO_ROOT/scripts/reflect-precheck.js" "$workdir/.claude-code-hermit" "$REPO_ROOT")"
run_test "reflect-precheck (RUN: resolution_check due — new-format proposal filename)" bash -c "echo '$out' | grep -q 'resolution_check'"
cleanup

# 25. RUN — compute activity (session report newer than last_run_at)
workdir="$(setup_workdir)"
echo '{"timezone":"UTC"}' > "$workdir/.claude-code-hermit/config.json"
echo '{"session_state":"idle"}' > "$workdir/.claude-code-hermit/state/runtime.json"
mkdir -p "$workdir/.claude-code-hermit/proposals"
old_date="2026-01-01T00:00:00Z"
echo "{\"counters\":{\"total_runs\":2,\"empty_runs\":1,\"last_run_at\":\"$old_date\",\"since\":\"$(python3 -c "import datetime; print((datetime.datetime.now(datetime.timezone.utc)-datetime.timedelta(days=30)).strftime('%Y-%m-%dT%H:%M:%SZ'))")\"}}" \
  > "$workdir/.claude-code-hermit/state/reflection-state.json"
# Create a session report (mtime = now, which is after old_date)
printf -- '---\ntitle: Test\ncreated: 2026-04-29\n---\nBody\n' \
  > "$workdir/.claude-code-hermit/sessions/S-001-REPORT.md"
mkdir -p "$workdir/.claude"
out="$(node "$REPO_ROOT/scripts/reflect-precheck.js" "$workdir/.claude-code-hermit" "$REPO_ROOT")"
run_test "reflect-precheck (RUN: compute activity detected)" bash -c "echo '$out' | grep -q 'compute'"
cleanup

# Local helper for tests #26-#29 — sets up a workdir with config/runtime/state/
# proposals/.claude scaffolding for reflect-precheck. Args: <session_state> <inflate?>
# Sets $workdir as a side effect (so the existing `cleanup` trap finds it).
setup_archive_precheck_workdir() {
  local session_state="$1"
  local inflate="${2:-no}"
  workdir="$(setup_workdir)"
  echo '{"timezone":"UTC"}' > "$workdir/.claude-code-hermit/config.json"
  echo "{\"session_state\":\"$session_state\",\"last_shell_snapshot_at\":null}" \
    > "$workdir/.claude-code-hermit/state/runtime.json"
  mkdir -p "$workdir/.claude-code-hermit/proposals"
  local today since
  today="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  since="$(python3 -c "import datetime; print((datetime.datetime.now(datetime.timezone.utc)-datetime.timedelta(days=30)).strftime('%Y-%m-%dT%H:%M:%SZ'))")"
  echo "{\"counters\":{\"total_runs\":5,\"empty_runs\":2,\"last_run_at\":\"$today\",\"since\":\"$since\"}}" \
    > "$workdir/.claude-code-hermit/state/reflection-state.json"
  mkdir -p "$workdir/.claude"
  if [ "$inflate" = "yes" ]; then
    {
      cat "$FIXTURES/shell-session.md"
      for i in $(seq 1 450); do echo "- [10:$(printf '%02d' $((i % 60)))] Bulk entry $i — done"; done
    } > "$workdir/.claude-code-hermit/sessions/SHELL.md"
  fi
}

# 26. ARCHIVE-only path: SHELL.md > 400 lines, last_shell_snapshot_at null,
#     no other phases due → precheck runs archive-shell.js synchronously and
#     emits EMPTY (no LLM reflect path).
setup_archive_precheck_workdir idle yes
out="$(node "$REPO_ROOT/scripts/reflect-precheck.js" "$workdir/.claude-code-hermit" "$REPO_ROOT")"
run_test "reflect-precheck (ARCHIVE-only: emits EMPTY)" bash -c "[ '$out' = 'EMPTY' ]"
run_test "reflect-precheck (ARCHIVE-only: snapshot file created)" bash -c \
  "[ \$(ls '$workdir/.claude-code-hermit/sessions/snapshots/' 2>/dev/null | wc -l) -ge 1 ]"
run_test "reflect-precheck (ARCHIVE-only: last_shell_snapshot_at populated)" bash -c \
  "python3 -c \"import json; d=json.load(open('$workdir/.claude-code-hermit/state/runtime.json')); assert d.get('last_shell_snapshot_at') is not None\""
run_test "reflect-precheck (ARCHIVE-only: SHELL.md compacted, sections preserved)" \
  grep -q '^## Task' "$workdir/.claude-code-hermit/sessions/SHELL.md"
cleanup

# 27. ARCHIVE skipped when SHELL.md is small (no archive_due fires)
setup_archive_precheck_workdir idle no
node "$REPO_ROOT/scripts/reflect-precheck.js" "$workdir/.claude-code-hermit" "$REPO_ROOT" >/dev/null
run_test "reflect-precheck (small SHELL.md: no snapshot taken)" bash -c \
  "[ ! -d '$workdir/.claude-code-hermit/sessions/snapshots' ] || [ \$(ls '$workdir/.claude-code-hermit/sessions/snapshots/' 2>/dev/null | wc -l) -eq 0 ]"
cleanup

# 28. ARCHIVE + other phases due → RUN with archive_due in phases JSON
#     (in_progress session forces compute=true; large SHELL forces archive_due)
setup_archive_precheck_workdir in_progress yes
out="$(node "$REPO_ROOT/scripts/reflect-precheck.js" "$workdir/.claude-code-hermit" "$REPO_ROOT")"
run_test "reflect-precheck (ARCHIVE+other: emits RUN)" bash -c "echo '$out' | grep -q '^RUN|'"
run_test "reflect-precheck (ARCHIVE+other: phases include compute)" bash -c \
  "echo '$out' | grep -q '\"compute\":true'"
run_test "reflect-precheck (ARCHIVE+other: phases include archive_due)" bash -c \
  "echo '$out' | grep -q '\"archive_due\":true'"
run_test "reflect-precheck (ARCHIVE+other: snapshot still taken)" bash -c \
  "[ \$(ls '$workdir/.claude-code-hermit/sessions/snapshots/' 2>/dev/null | wc -l) -eq 1 ]"
cleanup

# 29. ARCHIVE due but subprocess fails (snapshot already exists, EEXIST/concurrent)
#     + other phases → archive_due omitted from phases JSON (gated on archiveTaken)
setup_archive_precheck_workdir in_progress yes
mkdir -p "$workdir/.claude-code-hermit/sessions/snapshots"
# Pre-create the file linkSync would target (HERMIT_NOW pinned) → EEXIST.
touch "$workdir/.claude-code-hermit/sessions/snapshots/SHELL-20260506-2200.md"
out="$(cd "$workdir" && HERMIT_NOW='2026-05-06T22:00:00Z' node "$REPO_ROOT/scripts/reflect-precheck.js" "$workdir/.claude-code-hermit" "$REPO_ROOT")"
run_test "reflect-precheck (ARCHIVE failed: emits RUN)" bash -c "echo '$out' | grep -q '^RUN|'"
run_test "reflect-precheck (ARCHIVE failed: compute still in phases)" bash -c \
  "echo '$out' | grep -q '\"compute\":true'"
run_test "reflect-precheck (ARCHIVE failed: archive_due omitted)" bash -c \
  "! echo '$out' | grep -q 'archive_due'"
cleanup

# -------------------------------------------------------
# Summary
# -------------------------------------------------------
print_results
