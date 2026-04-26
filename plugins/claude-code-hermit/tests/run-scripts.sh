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

# 2. deny-patterns.json — valid JSON with expected arrays
run_test "deny-patterns.json" bash -c \
  "python3 -c \"import json; d=json.load(open('$REPO_ROOT/state-templates/deny-patterns.json')); assert isinstance(d.get('default'),list) and isinstance(d.get('always_on'),list)\""

# 3. Bin scripts are executable
run_test "bin scripts executable" bash -c \
  "for f in '$REPO_ROOT/state-templates/bin/'*; do [ -x \"\$f\" ] || exit 1; done"

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
sed -i '/^- note:/d; /^- input:/d' "$workdir/.claude-code-hermit/knowledge-schema.md"
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
# Summary
# -------------------------------------------------------
print_results
