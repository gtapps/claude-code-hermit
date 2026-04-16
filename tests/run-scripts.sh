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

# 6. Clean state — valid files, no findings
workdir="$(setup_workdir)"
mkdir -p "$workdir/.claude-code-hermit/raw" "$workdir/.claude-code-hermit/compiled"
echo '{}' > "$workdir/.claude-code-hermit/config.json"
printf -- '---\ntitle: fresh\ncreated: 2026-04-14T00:00:00+00:00\n---\ndata' \
  > "$workdir/.claude-code-hermit/raw/fresh-snap.md"
printf -- '---\ntitle: summary\ntype: briefing\ncreated: 2026-04-14T00:00:00+00:00\n---\nBased on fresh-snap.md data' \
  > "$workdir/.claude-code-hermit/compiled/summary.md"
run_test "knowledge-lint (clean state)" bash -c \
  "node '$REPO_ROOT/scripts/knowledge-lint.js' '$workdir/.claude-code-hermit' | grep -q 'Knowledge base is clean'"
cleanup

# -------------------------------------------------------
# Summary
# -------------------------------------------------------
print_results
