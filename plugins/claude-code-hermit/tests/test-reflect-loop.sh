#!/usr/bin/env bash
# Regression: reflect-loop contract tests — tooling debrief, vital-signs,
# observations ledger, success-signal push, artifact-cited evidence,
# ephemerality exception. Guards pinned SKILL.md / agent phrases so future
# trims don't silently lose them; also unit-tests the related Node scripts.
#
# Runs from inside plugins/claude-code-hermit/ (REPO_ROOT = that directory).
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

echo "=== reflect-loop tests ==="
echo ""

SESSION_CLOSE="$REPO_ROOT/skills/session-close/SKILL.md"

# ── item 1: session-close tooling debrief ───────────────────────────────────

run_test "session-close: tooling debrief question present" \
  grep -qF "What did I build ad-hoc this session" "$SESSION_CLOSE"

run_test "session-close: debrief asks for quantified cost" \
  grep -qF "quantified cost" "$SESSION_CLOSE"

run_test "session-close: debrief feeds procedure-capture Lessons" \
  grep -qF "procedure-capture recurs on" "$SESSION_CLOSE"

print_results
